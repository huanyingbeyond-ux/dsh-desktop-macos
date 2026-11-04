#!/usr/bin/env bash
#
# Provisions the runtime the shell drives: a private Node, a private pnpm, and the dsh CLI.
# Everything lands in ~/Library/Application Support/DeepSeek Harness/, never in the app bundle,
# so upgrading dsh or reinstalling the app never invalidates a signature.
#
#   ./scripts/bootstrap-engine.sh                  install the latest stable dsh
#   ./scripts/bootstrap-engine.sh 0.2.1-rc.5      pin a version
#   ./scripts/bootstrap-engine.sh --check          report what is installed and exit
#
# Roughly 1 GB of dependencies; expect several minutes on a first run.
#
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.22.2}"
PNPM_VERSION="${PNPM_VERSION:-10.34.9}"
DSH_PACKAGE="@deepseek-ai/dsh"

SUPPORT="$HOME/Library/Application Support/DeepSeek Harness"
ENGINE="$SUPPORT/engine"
RUNTIME="$ENGINE/runtime"
WORKSPACE="$ENGINE/dsh"
NODE_BIN="$RUNTIME/node"
PNPM_ENTRY="$RUNTIME/lib/node_modules/pnpm/bin/pnpm.cjs"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "this script only runs on macOS" >&2
  exit 1
fi

engine_version() {
  [ -f "$WORKSPACE/node_modules/$DSH_PACKAGE/package.json" ] || return 1
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$WORKSPACE/node_modules/$DSH_PACKAGE/package.json" | head -1
}

case "${1:-}" in
  -h|--help)
    sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  --check)
    printf 'node     %s\n' "$([ -x "$NODE_BIN" ] && "$NODE_BIN" -v || echo missing)"
    printf 'pnpm     %s\n' "$([ -f "$PNPM_ENTRY" ] && echo "$PNPM_VERSION" || echo missing)"
    printf 'dsh      %s\n' "$(engine_version || echo missing)"
    printf 'engine   %s\n' "$ENGINE"
    exit 0 ;;
esac

TARGET_VERSION="${1:-latest}"

case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$ENGINE"

# --- 1. private Node ----------------------------------------------------------
if [ -x "$NODE_BIN" ] && [ "$("$NODE_BIN" -v)" = "v$NODE_VERSION" ]; then
  echo "==> node v$NODE_VERSION already in place"
else
  echo "==> installing node v$NODE_VERSION ($NODE_ARCH)"
  TARBALL="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fL --retry 3 --progress-bar -o "$TMP/$TARBALL" "$URL"
  tar -xzf "$TMP/$TARBALL" -C "$TMP"
  rm -rf "$RUNTIME"
  mv "$TMP/node-v${NODE_VERSION}-darwin-${NODE_ARCH}" "$RUNTIME"
  # The shell looks for <runtime>/node; the stock layout keeps it at <runtime>/bin/node.
  cp "$RUNTIME/bin/node" "$NODE_BIN"
  chmod +x "$NODE_BIN"
  rm -rf "$TMP"
  trap - EXIT
fi

# --- 2. private pnpm ----------------------------------------------------------
# The plugin market shells out to pnpm. pnpm 9 fails with ERR_PNPM_ADDING_TO_ROOT when the
# workspace root is also the install target, which is exactly our layout; 10 handles it.
if [ -f "$PNPM_ENTRY" ]; then
  echo "==> pnpm already in place"
else
  echo "==> installing pnpm $PNPM_VERSION"
  npm_config_prefix="$RUNTIME" \
  npm_config_update_notifier=false \
    "$RUNTIME/bin/npm" install -g "pnpm@$PNPM_VERSION" --no-fund --no-audit
fi

PNPM=("$NODE_BIN" "$PNPM_ENTRY")

# --- 3. dsh CLI ---------------------------------------------------------------
echo "==> installing $DSH_PACKAGE@$TARGET_VERSION into $WORKSPACE"
mkdir -p "$WORKSPACE"
if [ ! -f "$WORKSPACE/package.json" ]; then
  printf '{\n  "name": "dsh-engine",\n  "private": true\n}\n' > "$WORKSPACE/package.json"
fi
# hoisted keeps a flat node_modules, so the entry point path the shell expects is stable.
printf 'node-linker=hoisted\nauto-install-peers=false\nnetwork-concurrency=32\nfetch-retries=5\n' \
  > "$WORKSPACE/.npmrc"

cd "$WORKSPACE"
PATH="$RUNTIME/bin:$RUNTIME:/usr/bin:/bin:/usr/sbin:/sbin" \
  "${PNPM[@]}" add "$DSH_PACKAGE@$TARGET_VERSION" --reporter=append-only

ENTRY="$WORKSPACE/node_modules/$DSH_PACKAGE/lib/bin.js"
if [ ! -f "$ENTRY" ]; then
  echo "install finished but $ENTRY is missing" >&2
  exit 1
fi

echo
echo "engine ready: $ENGINE"
echo "dsh:    $(engine_version)"
echo "node:   $("$NODE_BIN" -v)"
echo
echo "Launch the app. The helper shims under $SUPPORT/bin are written on first run."
