#!/usr/bin/env bash
#
# Builds "DeepSeek Harness.app" from the official Electron runtime plus src/main.js.
#
# No Electron toolchain, no node_modules, no network beyond one Electron zip download.
# Everything the script touches lives under build/ except the optional --install step.
#
#   ./build.sh              build for the host architecture
#   ./build.sh --arch x64   build for Intel
#   ./build.sh --arch arm64 build for Apple Silicon
#   ./build.sh --install    build, then replace /Applications/DeepSeek Harness.app
#
# Slow or throttled connection to GitHub? Point it at a mirror:
#   ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron ./build.sh --arch x64
#
set -euo pipefail

ELECTRON_VERSION="${ELECTRON_VERSION:-31.7.7}"
APP_NAME="DeepSeek Harness"
BUNDLE_ID="io.github.superboyyy.deepseek-harness-desktop"
APP_VERSION="1.1.0"
MIN_MACOS="11.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$ROOT/build"
CACHE="$BUILD/cache"

ARCH=""
INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)    ARCH="${2:-}"; shift 2 ;;
    --arch=*)  ARCH="${1#*=}"; shift ;;
    --install) INSTALL=1; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *) echo "unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
fi
case "$ARCH" in
  x64|arm64) ;;
  *) echo "--arch must be x64 or arm64" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "this build script only runs on macOS" >&2
  exit 1
fi

for tool in curl ditto plutil /usr/libexec/PlistBuddy codesign; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

ZIP="electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip"

# Three ways to name the download, most specific first. ELECTRON_MIRROR takes the npmmirror
# layout (<mirror>/<version>/<zip>) and is worth setting on a slow link to GitHub: the official
# release host is frequently throttled to dial-up speeds from mainland China.
if [ -n "${ELECTRON_URL:-}" ]; then
  URL="$ELECTRON_URL"
elif [ -n "${ELECTRON_MIRROR:-}" ]; then
  URL="${ELECTRON_MIRROR%/}/${ELECTRON_VERSION}/${ZIP}"
else
  URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP}"
fi

mkdir -p "$CACHE"

# --- 1. Electron runtime ------------------------------------------------------
if [ ! -f "$CACHE/$ZIP" ]; then
  echo "==> downloading Electron ${ELECTRON_VERSION} (${ARCH})"
  echo "    $URL"
  curl -fL --retry 3 --progress-bar -o "$CACHE/$ZIP.part" "$URL" \
    || { rm -f "$CACHE/$ZIP.part"; echo "download failed; try ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron" >&2; exit 1; }
  mv "$CACHE/$ZIP.part" "$CACHE/$ZIP"
else
  echo "==> using cached $ZIP"
fi

# A truncated archive from an interrupted run would look cached but fail in ditto.
if ! unzip -tq "$CACHE/$ZIP" >/dev/null 2>&1; then
  echo "cached archive is corrupt, re-downloading" >&2
  rm -f "$CACHE/$ZIP"
  curl -fL --retry 3 --progress-bar -o "$CACHE/$ZIP" "$URL"
fi

echo "==> unpacking"
rm -rf "$BUILD/unpacked"
mkdir -p "$BUILD/unpacked"
# ditto, not unzip: unzip drops the resource forks and symlinks the bundle relies on.
ditto -x -k "$CACHE/$ZIP" "$BUILD/unpacked"

SRC_APP="$BUILD/unpacked/Electron.app"
[ -d "$SRC_APP" ] || { echo "unexpected archive layout: $SRC_APP missing" >&2; exit 1; }

# --- 2. assemble the bundle ---------------------------------------------------
APP="$BUILD/$APP_NAME.app"
echo "==> assembling $APP_NAME.app"
rm -rf "$APP"
ditto "$SRC_APP" "$APP"

RES="$APP/Contents/Resources"
rm -rf "$RES/app"
mkdir -p "$RES/app"
cp "$ROOT/src/main.js" "$RES/app/main.js"
cat > "$RES/app/package.json" <<JSON
{
  "name": "deepseek-harness-desktop",
  "productName": "$APP_NAME",
  "version": "$APP_VERSION",
  "description": "Desktop shell for the DeepSeek Harness (dsh) web UI",
  "main": "main.js",
  "private": true
}
JSON

# The stock bundle ships a stub app plus an integrity hash that only covers that stub.
# Electron prefers Resources/app whenever it exists, so the stub becomes inert on its own;
# we still try to drop it, but a locked-down filesystem may refuse, and that is harmless.
if ! rm -rf "$RES/default_app.asar" 2>/dev/null; then
  echo "    note: default_app.asar could not be removed here; leaving it (inert)"
fi
cp "$ROOT/assets/AppIcon.icns" "$RES/AppIcon.icns"

# --- 3. Info.plist ------------------------------------------------------------
echo "==> rewriting Info.plist"
PLIST="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST"; }
pb "Delete :ElectronAsarIntegrity" 2>/dev/null || true
pb "Set :CFBundleDisplayName $APP_NAME"
pb "Set :CFBundleName $APP_NAME"
pb "Set :CFBundleIdentifier $BUNDLE_ID"
pb "Set :CFBundleShortVersionString $APP_VERSION"
pb "Set :CFBundleIconFile AppIcon"
pb "Set :LSMinimumSystemVersion $MIN_MACOS"
pb "Set :LSApplicationCategoryType public.app-category.developer-tools"
pb "Set :NSHighResolutionCapable true"
plutil -lint "$PLIST" >/dev/null

# --- 4. sign ------------------------------------------------------------------
# Ad-hoc only: this is not a Developer ID build and cannot be notarized. Gatekeeper will
# still ask the user to confirm the first launch after download.
echo "==> signing (ad-hoc)"
codesign --force --deep --sign - --timestamp=none "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP"
echo "    $(codesign -dv "$APP" 2>&1 | grep -E '^Identifier=' || true)"

# --- 5. install ---------------------------------------------------------------
echo
echo "built: $APP"
echo "size:  $(du -sh "$APP" | cut -f1)"

if [ "$INSTALL" -eq 1 ]; then
  DEST="/Applications/$APP_NAME.app"
  echo "==> installing to $DEST"
  if pgrep -f "$DEST/Contents/MacOS/Electron" >/dev/null 2>&1; then
    echo "    quitting the running copy first"
    osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
    sleep 2
  fi
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "installed. The engine under ~/Library/Application Support/\"$APP_NAME\" is untouched."
fi
