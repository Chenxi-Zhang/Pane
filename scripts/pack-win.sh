#!/usr/bin/env bash
# pack-win.sh — Build Pane Windows installer from WSL2
#
# Usage:
#   ./scripts/pack-win.sh [x64|arm64] [--skip-build]
#
# Flow:
#   1. Build JS in WSL (unless --skip-build)
#   2. Copy artifacts to C:\temp\pane-build (Windows local, not UNC)
#   3. npm install --ignore-scripts on Windows side
#   4. electron-rebuild for better-sqlite3-multiple-ciphers
#   5. electron-builder --win portable on Windows side
#   6. Copy exe back to WSL
#
# Prerequisites:
#   - WSL2 with interop enabled
#   - Windows side: Node.js 22+, npm, Python 3.x
#   - powershell.exe accessible from WSL

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}ℹ️  $*${NC}"; }
ok()    { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()   { echo -e "${RED}❌ $*${NC}" >&2; }
step()  { echo -e "\n${CYAN}━━━ Step $1: $2 ━━━${NC}\n"; }

# ─── Resolve project root ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WIN_TEMP_DIR="C:\\temp\\pane-build"
WSL_TEMP_DIR="/mnt/c/temp/pane-build"

# ─── Parse arguments ────────────────────────────────────────────────────────
ARCH="x64"
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    x64|arm64) ARCH="$arg" ;;
    --skip-build) SKIP_BUILD=true ;;
    -h|--help|help)
      echo "Usage: $0 [x64|arm64] [--skip-build]"
      echo ""
      echo "  x64          Target x64 architecture (default)"
      echo "  arm64        Target ARM64 architecture"
      echo "  --skip-build Skip WSL JS build step (use existing dist/)"
      exit 0
      ;;
    *)
      err "Unknown argument: $arg"
      echo "Usage: $0 [x64|arm64] [--skip-build]"
      exit 1
      ;;
  esac
done

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Pane — Windows Build from WSL2 (${ARCH})          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

START_TIME=$SECONDS

# ─── Step 0: Prerequisite checks ────────────────────────────────────────────
step "0" "Checking prerequisites"

# Check powershell.exe
if ! command -v powershell.exe &>/dev/null; then
  err "powershell.exe not found in PATH."
  err "WSL interop may be disabled. Check /etc/wsl.conf:"
  err "  [interop]"
  err "  enabled=true"
  exit 1
fi
ok "powershell.exe found"

# Check node.exe
if ! cmd.exe /c "node --version" &>/dev/null; then
  err "node.exe not available on Windows side."
  err "Install Node.js 22+ from https://nodejs.org or via nvm-windows."
  exit 1
fi
WIN_NODE_VER=$(cmd.exe /c "node --version" 2>/dev/null | tr -d '\r')
ok "Windows Node.js: ${WIN_NODE_VER}"

# Check npm
if ! cmd.exe /c "npm --version" &>/dev/null; then
  err "npm not available on Windows side."
  err "It should come with Node.js. Reinstall or repair Node.js."
  exit 1
fi
WIN_NPM_VER=$(cmd.exe /c "npm --version" 2>/dev/null | tr -d '\r')
ok "Windows npm: ${WIN_NPM_VER}"

# Check pnpm in WSL (needed for build step)
if ! $SKIP_BUILD; then
  if ! command -v pnpm &>/dev/null; then
    err "pnpm not found in WSL. Install it: npm install -g pnpm"
    exit 1
  fi
  ok "WSL pnpm: $(pnpm --version)"
fi

# ─── Step 1: Build JS in WSL ───────────────────────────────────────────────
if $SKIP_BUILD; then
  step "1" "Skipping WSL JS build (--skip-build)"

  # Verify dist directories exist
  if [ ! -d "$ROOT_DIR/main/dist" ]; then
    err "main/dist/ not found. Run without --skip-build first."
    exit 1
  fi
  if [ ! -d "$ROOT_DIR/frontend/dist" ]; then
    err "frontend/dist/ not found. Run without --skip-build first."
    exit 1
  fi
  ok "Existing build artifacts found"
else
  step "1" "Building JS in WSL"

  info "Building frontend..."
  (cd "$ROOT_DIR" && pnpm run build:frontend)
  ok "Frontend built"

  info "Building main process..."
  (cd "$ROOT_DIR" && pnpm run build:main)
  ok "Main process built"

  info "Injecting build info..."
  (cd "$ROOT_DIR" && pnpm run inject-build-info)
  ok "Build info injected"

  info "Generating notices..."
  (cd "$ROOT_DIR" && pnpm run generate-notices)
  ok "Notices generated"
fi

# ─── Step 2: Prepare Windows temp directory ─────────────────────────────────
step "2" "Preparing Windows temp directory"

if [ -d "$WSL_TEMP_DIR" ]; then
  if [ -d "$WSL_TEMP_DIR/node_modules" ]; then
    info "Reusing existing $WIN_TEMP_DIR (preserving node_modules)..."
    HAS_NODE_MODULES=true
  else
    info "Preparing existing $WIN_TEMP_DIR (no node_modules cache)..."
    HAS_NODE_MODULES=false
  fi

  if ! rm -rf "$WSL_TEMP_DIR/main" "$WSL_TEMP_DIR/frontend" "$WSL_TEMP_DIR/main-dist" "$WSL_TEMP_DIR/frontend-dist" "$WSL_TEMP_DIR/build" "$WSL_TEMP_DIR/dist-electron/win-unpacked" 2>/dev/null; then
    warn "Targeted cleanup failed (NTFS lock), falling back to PowerShell..."
    powershell.exe -NoProfile -Command "Remove-Item -Recurse -Force 'C:\temp\pane-build\main','C:\temp\pane-build\frontend','C:\temp\pane-build\main-dist','C:\temp\pane-build\frontend-dist','C:\temp\pane-build\build','C:\temp\pane-build\dist-electron\win-unpacked' -ErrorAction SilentlyContinue"
  fi
  rm -f "$WSL_TEMP_DIR/package.json" "$WSL_TEMP_DIR/pnpm-lock.yaml" "$WSL_TEMP_DIR/NOTICES" "$WSL_TEMP_DIR/LICENSE" "$WSL_TEMP_DIR/.build-cache.json" "$WSL_TEMP_DIR/dist-electron/builder-debug.yml"
else
  HAS_NODE_MODULES=false
fi

mkdir -p "$WSL_TEMP_DIR"
ok "Created $WIN_TEMP_DIR"

# Copy build artifacts
info "Copying artifacts to Windows..."

# Core build outputs
cp -r "$ROOT_DIR/main/dist" "$WSL_TEMP_DIR/main-dist"
cp -r "$ROOT_DIR/frontend/dist" "$WSL_TEMP_DIR/frontend-dist"

# Package config (has electron-builder "build" field)
cp "$ROOT_DIR/package.json" "$WSL_TEMP_DIR/package.json"

# Lockfile: intentionally NOT copied. pnpm-lock.yaml causes electron-builder
# to detect pnpm mode even though node_modules was installed by npm, resulting
# in "No JSON content found in output". npm install uses package-lock.json
# which it generates on first install.

# Windows icon
mkdir -p "$WSL_TEMP_DIR/main/assets"
cp "$ROOT_DIR/main/assets/icon.ico" "$WSL_TEMP_DIR/main/assets/icon.ico"

# License files
[ -f "$ROOT_DIR/NOTICES" ] && cp "$ROOT_DIR/NOTICES" "$WSL_TEMP_DIR/NOTICES"
[ -f "$ROOT_DIR/LICENSE" ] && cp "$ROOT_DIR/LICENSE" "$WSL_TEMP_DIR/LICENSE"

# Build directory (afterSign.js etc) if it exists
if [ -d "$ROOT_DIR/build" ]; then
  cp -r "$ROOT_DIR/build" "$WSL_TEMP_DIR/build"
fi

ok "Artifacts copied"

# ─── Step 2.5: Patch package.json for Windows ───────────────────────────────
# The WSL package.json has Linux-style paths and pnpm-specific fields.
# We need to restructure it so npm on Windows can install correctly.
# Key changes:
#   1. Replace "main": "main/dist/..." with correct path for our copy
#   2. Keep the "build" field intact (electron-builder reads it)
#   3. Remove pnpm-specific fields that confuse npm
info "Patching package.json for Windows npm..."

# Use Node.js to surgically modify package.json
node -e "
const fs = require('fs');
const pj = JSON.parse(fs.readFileSync('${WSL_TEMP_DIR}/package.json', 'utf8'));

// Remove pnpm-specific fields that npm doesn't understand
delete pj.pnpm;
delete pj.packageManager;

// Keep all other fields including 'build' (electron-builder config), 'dependencies', 'devDependencies'
// npm needs both to install everything electron-builder needs

fs.writeFileSync('${WSL_TEMP_DIR}/package.json', JSON.stringify(pj, null, 2) + '\n');
"
ok "package.json patched"

# Restructure directories to match what electron-builder expects
# electron-builder config has: files: ["main/dist/**/*", "frontend/dist/**/*", ...]
# So we need: main/dist/ and frontend/dist/ in the right place
info "Restructuring directories for electron-builder..."
mkdir -p "$WSL_TEMP_DIR/frontend"
mv "$WSL_TEMP_DIR/main-dist" "$WSL_TEMP_DIR/main/dist"
mv "$WSL_TEMP_DIR/frontend-dist" "$WSL_TEMP_DIR/frontend/dist"
ok "Directories restructured"

# Verify structure
echo ""
info "Windows temp directory structure:"
ls -la "$WSL_TEMP_DIR/"
echo ""
ls -la "$WSL_TEMP_DIR/main/" 2>/dev/null
echo ""
ls -la "$WSL_TEMP_DIR/main/dist/" 2>/dev/null | head -5

# ─── Step 3: npm install on Windows side ────────────────────────────────────
if [ "$HAS_NODE_MODULES" = true ]; then
  step "3" "Refreshing dependencies on Windows (reusing existing node_modules)"
else
  step "3" "Installing dependencies on Windows (npm install --ignore-scripts)"
fi

info "npm will reuse node_modules and the Windows npm cache when possible."
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
  Set-Location '${WIN_TEMP_DIR}'
  Write-Host 'Running: npm install --ignore-scripts'
  npm install --ignore-scripts 2>&1
  if (\$LASTEXITCODE -ne 0) {
    Write-Host 'npm install FAILED' -ForegroundColor Red
    exit \$LASTEXITCODE
  }
  Write-Host 'npm install succeeded' -ForegroundColor Green
"

if [ $? -ne 0 ]; then
  err "npm install failed on Windows side."
  err "Check the output above for errors."
  exit 1
fi
ok "npm install completed"

# ─── Step 4: electron-rebuild for native modules ────────────────────────────
step "4" "Rebuilding native modules for Windows Electron"

info "Rebuilding better-sqlite3-multiple-ciphers for Electron..."
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
  Set-Location '${WIN_TEMP_DIR}'
  Write-Host 'Running: npx electron-rebuild -f -w better-sqlite3-multiple-ciphers'
  npx electron-rebuild -f -w better-sqlite3-multiple-ciphers 2>&1
  if (\$LASTEXITCODE -ne 0) {
    Write-Host 'electron-rebuild FAILED' -ForegroundColor Red
    exit \$LASTEXITCODE
  }
  Write-Host 'electron-rebuild succeeded' -ForegroundColor Green
"

if [ $? -ne 0 ]; then
  err "electron-rebuild failed."
  err "Ensure Windows has: Python 3.x, Visual Studio Build Tools with C++ workload."
  err "Temp directory preserved at ${WSL_TEMP_DIR} for debugging."
  exit 1
fi
ok "Native modules rebuilt for Windows Electron"

# ─── Step 5: electron-builder ───────────────────────────────────────────────
step "5" "Packaging Windows installer (electron-builder)"

info "Patching package.json: disable signing (no certificate, avoids symlink permission error)..."
node -e "
const fs = require('fs');
const pj = JSON.parse(fs.readFileSync('${WSL_TEMP_DIR}/package.json', 'utf8'));
pj.build.win.signAndEditExecutable = false;
fs.writeFileSync('${WSL_TEMP_DIR}/package.json', JSON.stringify(pj, null, 2) + '\n');
"
ok "Signing disabled in config"

# Set Electron download mirror if the env var is provided (avoids GitHub timeouts in China/behind firewalls).
# Export these in your shell to use:
#   export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
#   export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
MIRROR_ENV=""
if [ -n "${ELECTRON_MIRROR:-}" ]; then
  MIRROR_ENV="\$env:ELECTRON_MIRROR = '${ELECTRON_MIRROR}'; "
  info "Using ELECTRON_MIRROR: ${ELECTRON_MIRROR}"
fi
if [ -n "${ELECTRON_BUILDER_BINARIES_MIRROR:-}" ]; then
  MIRROR_ENV="${MIRROR_ENV}\$env:ELECTRON_BUILDER_BINARIES_MIRROR = '${ELECTRON_BUILDER_BINARIES_MIRROR}'; "
  info "Using ELECTRON_BUILDER_BINARIES_MIRROR: ${ELECTRON_BUILDER_BINARIES_MIRROR}"
fi

# Cache Electron and electron-builder downloads so they aren't re-downloaded every build.
CACHE_ENV="\$env:ELECTRON_CACHE = \"\$env:LOCALAPPDATA\\electron\\Cache\"; "
CACHE_ENV="${CACHE_ENV}\$env:ELECTRON_BUILDER_CACHE = \"\$env:LOCALAPPDATA\\electron-builder\\Cache\"; "

info "Running electron-builder --win portable --${ARCH}..."
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
  ${CACHE_ENV}${MIRROR_ENV}\$env:ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES = 'true'
  Set-Location '${WIN_TEMP_DIR}'
  Write-Host 'Running: npx electron-builder --win portable --${ARCH} --publish never --config.npmRebuild=false'
  npx electron-builder --win portable --${ARCH} --publish never --config.npmRebuild=false 2>&1
  if (\$LASTEXITCODE -ne 0) {
    Write-Host 'electron-builder FAILED' -ForegroundColor Red
    exit \$LASTEXITCODE
  }
  Write-Host 'electron-builder succeeded' -ForegroundColor Green
"

if [ $? -ne 0 ]; then
  err "electron-builder failed."
  err "Temp directory preserved at ${WSL_TEMP_DIR} for debugging."
  exit 1
fi
ok "Windows installer packaged"

# ─── Step 6: Verify output ─────────────────────────────────────────────────
step "6" "Verifying output"

EXE_FILES=("$WSL_TEMP_DIR/dist-electron"/*.exe)
if [ ${#EXE_FILES[@]} -eq 0 ] || [ ! -f "${EXE_FILES[0]}" ]; then
  err "No .exe files found in ${WSL_TEMP_DIR}/dist-electron/"
  ls -la "$WSL_TEMP_DIR/dist-electron/" 2>/dev/null || true
  exit 1
fi

# ─── Done ───────────────────────────────────────────────────────────────────
ELAPSED=$(( SECONDS - START_TIME ))
MINUTES=$(( ELAPSED / 60 ))
SECS=$(( ELAPSED % 60 ))

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ Windows build complete!                     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Architecture: ${CYAN}${ARCH}${NC}"
echo -e "  Elapsed:      ${CYAN}${MINUTES}m ${SECS}s${NC}"
echo ""
echo -e "  Output (${WIN_TEMP_DIR}\\dist-electron\\):"
for exe in "${EXE_FILES[@]}"; do
  exe_name=$(basename "$exe")
  exe_size=$(du -h "$exe" | cut -f1)
  echo -e "    ${GREEN}${exe_name} (${exe_size})${NC}"
done
echo ""
