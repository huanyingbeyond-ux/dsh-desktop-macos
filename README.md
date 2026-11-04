# DeepSeek Harness — macOS Desktop Shell

一个独立运行的 **DeepSeek Harness（dsh）** 桌面客户端，为 **macOS 11 / 12 的 Intel Mac**（以及 Apple Silicon）而做。

它不重写 dsh，只给它套一层自带 Chromium 的外壳：登录、升级、装插件、看外链，全部留在 App 里完成，不再跳 Safari。

> A standalone macOS shell for the DeepSeek Harness web UI. It ships its own Chromium so the app
> runs on systems whose WebKit is too old for the dsh front-end, and it keeps sign-in, upgrades,
> and external links inside the app window instead of handing them to Safari.

---

## 为什么需要这层壳

上游桌面端用的是系统 `WKWebView`。macOS 12 自带的 WebKit 停在 Safari 15.6 级别，而 dsh 的前端产物用到了两类**语法层**特性：

| 特性 | 老 WebKit 的表现 |
| --- | --- |
| class static initialization blocks (`static { … }`) | 整块脚本直接抛 `SyntaxError`，页面白屏 |
| import attributes (`import x from "y" with { type: "json" }`) | 同上，解析阶段就失败 |

这两件事发生在**解析阶段**，任何 polyfill、任何 `compat.js` 都补不上——补丁只能在语法通过之后运行。唯一的出路是把渲染引擎换掉。

所以外壳改为 **Electron 31.7.7（Chromium 126）**。官方二进制的部署目标本来就是 `minos 10.15`，因此 macOS 11 / 12 可以原生加载，**不需要**改动 Mach-O 的 `LC_BUILD_VERSION`，也不需要 vtool 之类的后处理。

## 这个外壳做了什么

- **自带 Chromium**：渲染与系统 WebKit 版本彻底解耦。
- **引擎与外壳分离**：dsh 装在 `~/Library/Application Support/DeepSeek Harness/engine`，升级 dsh 从不改动 App 包内的文件，签名不会失效。
- **App 内升级 + 回滚**：菜单里「检查更新…」对比 npm `latest`，暂存安装后整目录 swap；旧版本保留为 `node_modules.bak-<ver>`，「回滚引擎版本」一键退回。
- **登录不跳浏览器**：dsh 通过 `open` 命令拉起登录页。外壳在 PATH 前置了一个 `open` 垫片，把 URL 写进日志，主进程再开一个 App 内窗口加载它；授权完成回跳本地端口时自动关闭该窗口并刷新主界面。
- **插件市场可用**：内置 pnpm 10 垫片。pnpm 9 在「工作区根目录同时是安装目标」的布局下会报 `ERR_PNPM_ADDING_TO_ROOT`，10 不会。
- **干净的子进程环境**：显式清掉 `NODE_OPTIONS` / `NODE_PATH` / `NODE_EXTRA_CA_CERTS`，避免终端里的注入让 node 静默卡死。
- **孤儿进程回收**：崩溃或强退会留下监听 3080–3090 的引擎进程。启动时只回收父进程已是 launchd、且命令行指向本引擎的那些，绝不误杀你自己终端里的 dsh。
- **单实例锁**、菜单本地化、日志落在 `~/Library/Logs/deepseek-harness-desktop.log`。

## 目录结构

```
.
├── build.sh                     # 下载 Electron、组装 .app、签名
├── scripts/
│   └── bootstrap-engine.sh      # 装私有 Node + pnpm + dsh 引擎
├── src/
│   └── main.js                  # 主进程，全部外壳逻辑都在这里
└── assets/
    └── AppIcon.icns
```

## 构建

只需要 macOS 自带的 `curl`、`ditto`、`PlistBuddy`、`codesign`，不需要 Node、不需要 npm install。

```bash
chmod +x build.sh scripts/bootstrap-engine.sh

./build.sh --arch x64        # Intel
./build.sh --arch arm64      # Apple Silicon
./build.sh --install         # 构建并替换 /Applications 里的旧版本
```

产物在 `build/DeepSeek Harness.app`。首次构建会下载约 98 MB 的 Electron 包并缓存到 `build/cache/`，之后的构建直接复用。

可覆盖的变量：

```bash
ELECTRON_VERSION=31.7.7 ./build.sh --arch x64
```

**国内网络提示**：官方 Releases 经常被限速到 20 KB/s 量级，下载会卡十几分钟。换 npmmirror 镜像能跑到 9 MB/s：

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron ./build.sh --arch x64
```

## 首次准备引擎

外壳本身不含 dsh。第一次运行若提示「找不到运行引擎」，执行：

```bash
./scripts/bootstrap-engine.sh            # 安装 npm 上的 latest
./scripts/bootstrap-engine.sh 0.2.1-rc.5 # 或锁定某个版本
./scripts/bootstrap-engine.sh --check    # 查看当前装了什么
```

它会下载一份私有 Node 22 到 `engine/runtime/`，在其中安装 pnpm 10，再用 pnpm 16 把 dsh 及其依赖装到 `engine/dsh/`。首次约 1 GB，视网络需要几分钟到二十分钟。

装完后路径应长这样：

```
~/Library/Application Support/DeepSeek Harness/
├── engine/
│   ├── runtime/node                              # 私有 Node
│   ├── runtime/lib/node_modules/pnpm/            # 私有 pnpm
│   └── dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
└── bin/{open,pnpm}                               # 首次启动时由 App 写入的垫片
```

## 使用

正常双击即可。菜单栏里几个不常见的项：

| 菜单项 | 作用 |
| --- | --- |
| 检查更新… | 对比 npm registry 的 `latest`，暂存安装后切换并自动重启 |
| 回滚引擎版本 | 退回任意一份 `node_modules.bak-*` |
| 打开日志 | 打开 `~/Library/Logs/deepseek-harness-desktop.log` |
| 在浏览器中打开 | 兜底：把当前地址交给默认浏览器 |

## 已知限制

- **ad-hoc 签名**。不是 Developer ID 构建，无法公证。从网络下载后首次打开，macOS 会拦一次，需右键 →「打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"`。
- **辅助进程仍叫 Electron Helper**。为降低破坏签名与二进制路径的风险，`Frameworks/` 下的 Helper 未改名，活动监视器里会看到 `Electron Helper (Renderer)` 之类的条目。功能无影响。
- **升级是重装而非增量**。dsh 的依赖图约 600 个包，每次升级都要重新下载，缓慢但保证干净。
- **只服务本地回环**。引擎监听 `127.0.0.1:3080+`，没有对外暴露的端口，也没有远程访问。

## 与上游的关系

本仓库只包含**桌面外壳**，不含 dsh 自身的任何代码。dsh 由 npm 包 `@deepseek-ai/dsh` 提供，按它自己的许可分发；外壳在运行时才去调用它。

## License

MIT，见 [LICENSE](LICENSE)。
