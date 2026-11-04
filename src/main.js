// DeepSeek Harness desktop shell.
//
// Chromium (via Electron) rather than the system WebView: the dsh UI is built with modern
// JavaScript syntax (class static blocks, import attributes) that the WebKit shipped with
// macOS 12 cannot parse, and no shim can fix a parser.
//
// The app owns no server code. It starts the engine under
//   ~/Library/Application Support/DeepSeek Harness/engine
// which is deliberately outside the app bundle, so upgrading dsh never rewrites signed files.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support', 'DeepSeek Harness');
const ENGINE = path.join(SUPPORT, 'engine');
const HELPER_BIN = path.join(SUPPORT, 'bin');
const EXTERNAL_LOG = path.join(SUPPORT, 'external-url.log');
const LOG_FILE = path.join(HOME, 'Library', 'Logs', 'deepseek-harness-desktop.log');
const PARTITION = 'persist:dsh';

let serverProcess = null;
let serverUrl = null;
let serverPort = 0;
let mainWindow = null;
let quitting = false;
let externalTimer = null;
let externalOffset = 0;
let logStream = null;
const externalWindows = new Set();

// MARK: - logging

function log(message) {
  const line = `[client ${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) { /* best effort */ }
}

// MARK: - engine helpers

function ensureDirs() {
  for (const dir of [SUPPORT, HELPER_BIN]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
  }
  if (!fs.existsSync(EXTERNAL_LOG)) {
    try { fs.writeFileSync(EXTERNAL_LOG, ''); } catch (e) { /* best effort */ }
  }
}

// dsh opens the sign-in page (and every "open in browser" link) through `open`. Ours records the
// URL for the shell to show in-app instead, so nothing ever lands in Safari.
function installOpenShim() {
  const target = path.join(HELPER_BIN, 'open');
  const script = `#!/bin/sh
case "$1" in
  -*) exec /usr/bin/open "$@" ;;
  http://*|https://*)
    printf '%s\\n' "$1" >> "${EXTERNAL_LOG}"
    exit 0 ;;
  *) exec /usr/bin/open "$@" ;;
esac
`;
  try {
    fs.writeFileSync(target, script, { mode: 0o755 });
  } catch (e) {
    log(`open shim failed: ${e.message}`);
  }
}

// The plugin market installs through pnpm; the engine runtime carries it under lib/node_modules.
function installPnpmShim() {
  const target = path.join(HELPER_BIN, 'pnpm');
  const entry = path.join(ENGINE, 'runtime', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (!fs.existsSync(entry)) return;
  const node = path.join(ENGINE, 'runtime', 'node');
  const script = `#!/bin/sh\nexec "${node}" "${entry}" "$@"\n`;
  try {
    fs.writeFileSync(target, script, { mode: 0o755 });
  } catch (e) {
    log(`pnpm shim failed: ${e.message}`);
  }
}

function engineEnvironment() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.NODE_EXTRA_CA_CERTS;
  env.PATH = [
    HELPER_BIN,
    path.join(ENGINE, 'runtime'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  return env;
}

function firstFreePort(from) {
  return new Promise((resolve) => {
    const attempt = (port) => {
      const server = net.createServer();
      server.once('error', () => (port > from + 20 ? resolve(0) : attempt(port + 1)));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    attempt(from);
  });
}

// MARK: - server

async function startServer() {
  const node = path.join(ENGINE, 'runtime', 'node');
  const entry = path.join(ENGINE, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  if (!fs.existsSync(node) || !fs.existsSync(entry)) {
    return dialog.showMessageBox({
      type: 'error',
      message: '找不到运行引擎',
      detail: `期望路径：\n${ENGINE}\n\n可用「重新安装引擎」菜单恢复。`,
      buttons: ['好'],
    });
  }

  const preferred = await firstFreePort(3080);
  const argv = [entry, 'web', '--port', String(preferred), '--no-open'];
  log(`spawn: ${node} ${argv.join(' ')}`);

  const child = spawn(node, argv, { cwd: HOME, env: engineEnvironment() });
  serverProcess = child;

  const consume = (chunk) => {
    const text = chunk.toString();
    try { logStream.write(text); } catch (e) { /* rotated away */ }
    if (!serverUrl) {
      const match = text.match(/http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/[^\s"']*/);
      if (match) {
        serverUrl = match[0];
        serverPort = Number(match[1]);
        log(`server is up on port ${serverPort}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(serverUrl);
        }
      }
    }
  };

  child.stdout.on('data', consume);
  child.stderr.on('data', consume);

  child.on('exit', (code) => {
    if (quitting) return;
    log(`server exited unexpectedly, status ${code}`);
    if (!serverUrl && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: '运行引擎启动失败',
        detail: `退出码 ${code}。日志：${LOG_FILE}`,
        buttons: ['好'],
      });
    }
  });
}

function stopServer() {
  const child = serverProcess;
  if (!child || child.exitCode !== null) return;
  log(`quitting: stopping spawned server (pid ${child.pid})`);
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 3000);
}

// A crash or a force-quit can leave the server behind. On startup, take out only servers that
// point at our engine and were orphaned (reparented to launchd) — never someone's terminal dsh.
function sweepOrphanServers() {
  const { execFileSync } = require('child_process');
  for (let port = 3080; port <= 3090; port += 1) {
    let output = '';
    try {
      output = execFileSync('/usr/sbin/lsof', ['-tnP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      });
    } catch (e) {
      continue;
    }
    for (const raw of output.split('\n')) {
      const pid = Number(raw.trim());
      if (!pid) continue;
      let info = '';
      try {
        info = execFileSync('/bin/ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' });
      } catch (e) {
        continue;
      }
      const ppid = Number(info.trim().split(/\s+/)[0]);
      const orphaned = ppid === 1;
      const ours = info.includes(path.join(ENGINE, 'dsh'));
      if (orphaned && ours) {
        log(`reclaiming orphaned server pid ${pid} on port ${port}`);
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already gone */ }
      }
    }
  }
}

// MARK: - windows

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff',
    title: 'DeepSeek Harness',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.loadURL(splashURL());

  const contents = mainWindow.webContents;
  contents.on('did-finish-load', () => {
    const url = contents.getURL();
    if (!url.startsWith('data:')) log(`page loaded: ${url}`);
    if (!process.env.DSH_SHELL_DEBUG) return;
    contents.executeJavaScript(
      '({title: document.title, text: document.body ? document.body.innerText.slice(0, 400) : "", ' +
      'nodes: document.body ? document.body.querySelectorAll("*").length : 0, ' +
      'ready: document.readyState})')
      .then((info) => log(`dom: ${JSON.stringify(info)}`))
      .catch((e) => log(`dom probe failed: ${e.message}`));
  });
  contents.on('did-fail-load', (event, code, description, url) => {
    log(`page load failed (${code}): ${description} ${url}`);
  });
  contents.on('render-process-gone', (event, details) => {
    log(`renderer gone: ${details.reason} exitCode=${details.exitCode}`);
  });
  contents.on('console-message', (event, level, message, line, source) => {
    if (level >= 2) log(`console[${level}] ${message} (${source}:${line})`);
  });

  // Links that leave the local server belong in a window of ours, never in Safari.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) return { action: 'allow' };
    openInApp(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocal(url) && /^https?:/i.test(url)) {
      event.preventDefault();
      openInApp(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function splashURL() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; margin: 0; }
    body { display: flex; align-items: center; justify-content: center; font: 14px -apple-system;
           background: #ffffff; color: #4a4a4a; }
    @media (prefers-color-scheme: dark) { body { background: #151517; color: #d0d0d0; } }
    .box { text-align: center; }
    .ring { width: 26px; height: 26px; margin: 0 auto 16px; border-radius: 50%;
            border: 3px solid rgba(128,128,128,.3); border-top-color: #4d6bfe;
            animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style></head><body><div class="box"><div class="ring"></div>正在启动 DeepSeek Harness…</div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function isLocal(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return false;
    return serverPort === 0 || !parsed.port || Number(parsed.port) === serverPort;
  } catch (e) {
    return false;
  }
}

function openInApp(url) {
  log(`external url: ${url}`);
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    title: (() => { try { return new URL(url).hostname; } catch (e) { return 'DeepSeek'; } })(),
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  externalWindows.add(win);
  win.on('closed', () => externalWindows.delete(win));

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    win.loadURL(target);
    return { action: 'deny' };
  });

  // A redirect back to the local server means the sign-in round-trip finished.
  win.webContents.on('did-navigate', (event, target) => {
    if (isLocal(target)) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 400);
    }
  });

  win.loadURL(url);
}

// MARK: - external URL file

function drainExternalURLs() {
  let stat;
  try { stat = fs.statSync(EXTERNAL_LOG); } catch (e) { return; }
  if (stat.size < externalOffset) externalOffset = 0;
  if (stat.size === externalOffset) return;

  let fd;
  try {
    fd = fs.openSync(EXTERNAL_LOG, 'r');
    const length = stat.size - externalOffset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, externalOffset);
    externalOffset = stat.size;
    for (const line of buffer.toString('utf8').split('\n')) {
      const url = line.trim();
      if (/^https?:\/\//i.test(url)) openInApp(url);
    }
  } catch (e) {
    log(`external url read failed: ${e.message}`);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

// MARK: - engine update

const DSH_PACKAGE = '@deepseek-ai/dsh';
const ENGINE_MODULES = path.join(ENGINE, 'dsh', 'node_modules');
const REGISTRY = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function engineVersion() {
  try {
    const manifest = readJson(path.join(ENGINE_MODULES, '@deepseek-ai', 'dsh', 'package.json'));
    return manifest ? manifest.version : null;
  } catch (e) {
    return null;
  }
}

// Enough of semver to order releases and prereleases; the engine only ever uses x.y.z or x.y.z-tag.n.
function versionKey(version) {
  const [core, pre] = String(version).split('-');
  const nums = core.split('.').map((part) => Number(part) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre: pre || null };
}

function compareVersions(left, right) {
  const a = versionKey(left);
  const b = versionKey(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;          // a release outranks its own prereleases
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

async function fetchLatestVersions() {
  // Plain Node fetch: no Chromium proxy stack in the way, and the request is one small JSON.
  const response = await fetch(REGISTRY, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  const manifest = await response.json();
  const tags = manifest['dist-tags'] || {};
  const versions = Object.keys(manifest.versions || {});
  return {
    latest: tags.latest || null,
    next: tags.next || tags.beta || null,
    versions,
  };
}

function runPnpm(args, cwd, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(path.join(HELPER_BIN, 'pnpm'), args, { cwd, env: engineEnvironment() });
    const pump = (chunk) => {
      const text = chunk.toString();
      log(`pnpm: ${text.trimEnd()}`);
      if (onOutput) onOutput(text);
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (error) => {
      log(`pnpm spawn failed: ${error.message}`);
      resolve(-1);
    });
    child.on('exit', (code) => resolve(code === null ? -1 : code));
  });
}

function progressWindow(title, detail) {
  const escape = (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; margin: 0; -webkit-user-select: none; }
    body { display: flex; align-items: center; justify-content: center; font: 13px -apple-system;
           background: #ffffff; color: #3a3a3a; }
    @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #d8d8d8; } }
    .box { display: flex; gap: 14px; align-items: flex-start; padding: 0 24px; }
    .ring { width: 18px; height: 18px; margin-top: 2px; border-radius: 50%; flex: none;
            border: 2px solid rgba(128,128,128,.28); border-top-color: #4d6bfe;
            animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
    p { margin: 0; font-size: 12px; line-height: 1.5; opacity: .72; }
  </style></head><body><div class="box"><div class="ring"></div><div>
    <h2>${escape(title)}</h2><p id="detail">${escape(detail)}</p></div></div></body></html>`;

  const win = new BrowserWindow({
    width: 460,
    height: 132,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => win.show());

  let pending = detail;
  let ready = false;
  win.webContents.once('did-finish-load', () => {
    ready = true;
    win.webContents.executeJavaScript(
      `document.getElementById('detail').textContent = ${JSON.stringify(pending)}`)
      .catch(() => { /* window went away */ });
  });

  return {
    set(detailText) {
      pending = detailText;
      if (!ready || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        `document.getElementById('detail').textContent = ${JSON.stringify(detailText)}`)
        .catch(() => { /* window went away */ });
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

// The engine is a plain pnpm tree; installing the CLI package pulls its whole dependency
// graph, so a staged install plus a directory swap upgrades dsh without touching the bundle.
async function installEngine(version, onOutput) {
  const staging = path.join(ENGINE, `.update-${version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'),
    JSON.stringify({ name: 'dsh-engine-staging', private: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(staging, '.npmrc'),
    'node-linker=hoisted\nauto-install-peers=false\nnetwork-concurrency=32\nfetch-retries=5\n');

  const code = await runPnpm(
    ['add', `${DSH_PACKAGE}@${version}`, '--reporter=append-only'],
    staging,
    onOutput,
  );
  const entry = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (code !== 0 || !fs.existsSync(entry)) {
    fs.rmSync(staging, { recursive: true, force: true });
    return null;
  }
  return staging;
}

function swapEngine(staging, version) {
  const backup = path.join(ENGINE, 'dsh', `node_modules.bak-${engineVersion() || 'previous'}`);
  fs.rmSync(backup, { recursive: true, force: true });
  fs.renameSync(ENGINE_MODULES, backup);
  try {
    fs.renameSync(path.join(staging, 'node_modules'), ENGINE_MODULES);
  } catch (error) {
    fs.renameSync(backup, ENGINE_MODULES);   // put the working engine back
    throw error;
  }
  fs.rmSync(staging, { recursive: true, force: true });
  log(`engine upgraded to ${version}; previous tree kept at ${backup}`);
  return backup;
}

async function checkForUpdates() {
  const current = engineVersion();
  if (!current) {
    return dialog.showMessageBox({
      type: 'error',
      message: '读不到当前引擎版本',
      detail: `检查路径：\n${ENGINE_MODULES}`,
      buttons: ['好'],
    });
  }

  let info;
  try {
    info = await fetchLatestVersions();
  } catch (error) {
    return dialog.showMessageBox({
      type: 'error',
      message: '无法连接到 npm 仓库',
      detail: `${error.message}\n\n请确认网络可用后重试。`,
      buttons: ['好'],
    });
  }

  const target = info.latest;
  if (!target) {
    return dialog.showMessageBox({
      type: 'error',
      message: '仓库没有可用的稳定版本',
      detail: '未能从 npm 读取 latest 标签，请稍后再试。',
      buttons: ['好'],
    });
  }
  if (compareVersions(target, current) <= 0) {
    return dialog.showMessageBox({
      type: 'info',
      message: '已是最新版本',
      detail: `当前引擎 ${current}\n仓库最新 ${target}`,
      buttons: ['好'],
    });
  }

  const answer = await dialog.showMessageBox({
    type: 'question',
    message: `发现新版本 ${target}`,
    detail: `当前 ${current} → ${target}\n\n升级会重新下载引擎依赖（约 1GB），完成后应用会自动重启。`,
    buttons: ['升级', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;

  const progress = progressWindow(`正在升级到 ${target}`, '准备下载依赖…');
  const started = Date.now();
  let lastNote = '';
  let staging = null;
  try {
    staging = await installEngine(target, (text) => {
      const line = text.trim().split('\n').pop() || '';
      if (!line || line === lastNote) return;
      lastNote = line;
      const seconds = Math.round((Date.now() - started) / 1000);
      progress.set(`${line}（已用 ${seconds} 秒）`);
    });
  } catch (error) {
    log(`engine update failed: ${error.message}`);
  }

  if (!staging) {
    progress.close();
    return dialog.showMessageBox({
      type: 'error',
      message: '升级失败',
      detail: `未能安装 ${DSH_PACKAGE}@${target}。现有引擎未被改动。\n日志：${LOG_FILE}`,
      buttons: ['好'],
    });
  }

  progress.set('安装完成，正在切换引擎…');
  try {
    swapEngine(staging, target);
  } catch (error) {
    progress.close();
    return dialog.showMessageBox({
      type: 'error',
      message: '切换引擎失败',
      detail: `${error.message}\n\n已恢复原引擎。`,
      buttons: ['好'],
    });
  }

  progress.set('正在重启应用…');
  quitting = true;
  stopServer();
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 600);
}

function previousEngines() {
  try {
    return fs.readdirSync(path.join(ENGINE, 'dsh'))
      .filter((name) => name.startsWith('node_modules.bak-'))
      .map((name) => ({
        name,
        version: name.replace('node_modules.bak-', ''),
        full: path.join(ENGINE, 'dsh', name),
      }));
  } catch (e) {
    return [];
  }
}

async function rollbackEngine(entry) {
  const answer = await dialog.showMessageBox({
    type: 'warning',
    message: `回滚到 ${entry.version}？`,
    detail: '当前引擎会被保留为一份备份，应用随后重启。',
    buttons: ['回滚', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;

  const current = engineVersion() || 'current';
  const parked = path.join(ENGINE, 'dsh', `node_modules.bak-${current}`);
  try {
    fs.rmSync(parked, { recursive: true, force: true });
    fs.renameSync(ENGINE_MODULES, parked);
    fs.renameSync(entry.full, ENGINE_MODULES);
  } catch (error) {
    return dialog.showMessageBox({
      type: 'error',
      message: '回滚失败',
      detail: error.message,
      buttons: ['好'],
    });
  }
  log(`engine rolled back to ${entry.version}`);
  quitting = true;
  stopServer();
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 600);
}

// MARK: - menu

function buildMenu() {
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { role: 'about', label: '关于 DeepSeek Harness' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 DeepSeek Harness' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        {
          label: '检查更新…',
          click: () => { checkForUpdates(); },
        },
        {
          label: '回滚引擎版本',
          enabled: previousEngines().length > 0,
          submenu: previousEngines().map((entry) => ({
            label: entry.version,
            click: () => { rollbackEngine(entry); },
          })),
        },
        { type: 'separator' },
        {
          label: '打开日志',
          click: () => shell.openPath(LOG_FILE),
        },
        {
          label: '在浏览器中打开',
          click: () => { if (serverUrl) shell.openExternal(serverUrl); },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出 DeepSeek Harness' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// MARK: - lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    ensureDirs();
    installOpenShim();
    installPnpmShim();
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    externalOffset = fs.existsSync(EXTERNAL_LOG) ? fs.statSync(EXTERNAL_LOG).size : 0;
    externalTimer = setInterval(drainExternalURLs, 500);

    buildMenu();
    createMainWindow();
    sweepOrphanServers();
    await startServer();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    if (externalTimer) clearInterval(externalTimer);
    stopServer();
    if (logStream) logStream.end();
  });

  app.on('window-all-closed', () => app.quit());
}

// Terminal kills and log-outs bypass before-quit; take the server with us either way.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    quitting = true;
    stopServer();
    app.quit();
  });
}
