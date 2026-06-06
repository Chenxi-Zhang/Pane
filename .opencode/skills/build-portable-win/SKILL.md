---
name: build-portable-win
description: Build a portable Windows EXE for Pane — a standalone single-file executable that runs without installation. Use when the user wants to create a portable .exe instead of the NSIS installer.
argument-hint: "[optional: x64 or arm64, defaults to x64]"
---

# Build Portable Windows EXE

Pane already has a script for this: `scripts/pack-win.sh`. Run it from WSL2.

## Pre-flight Checks (MANDATORY — run before pack-win.sh)

These checks prevent build failures. Run them every time.

### Check 1: Stale temp directory lock

`pack-win.sh` now uses targeted cleanup and preserves reusable resources (`node_modules`, `package-lock.json`, previous `.exe`). WSL can still fail to delete specific NTFS files locked by Windows (antivirus, Explorer, running Pane instance), in which case the script falls back to PowerShell for those generated paths.

```bash
ls /mnt/c/temp/pane-build/node_modules >/dev/null 2>&1 && echo "node_modules: reusable" || echo "node_modules: missing"
ls /mnt/c/temp/pane-build/dist-electron/*.exe >/dev/null 2>&1 && echo "previous exe: preserved" || echo "previous exe: none"
```

If targeted cleanup via WSL fails, let the script's PowerShell fallback handle it. Avoid manually deleting `C:\temp\pane-build\*` unless you intentionally want a cold build.

### Check 2: Electron download mirror (optional)

`electron-builder` downloads from `github.com`. If you're in China or behind a restrictive firewall, set mirror env vars before running `pack-win.sh` — the script will forward them to the Windows side automatically:

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
./scripts/pack-win.sh x64
```

Add to `~/.bashrc` for persistence. The downloaded binaries are cached at `%LOCALAPPDATA%\electron\Cache\` and reused across builds.

### Check 3: pnpm-lock.yaml (FIXED in script)

~~Historically `pack-win.sh` copied `pnpm-lock.yaml` to the temp directory, causing electron-builder to detect pnpm mode and fail.~~ This is now fixed in the script — `pnpm-lock.yaml` is intentionally NOT copied. No manual action needed.

### Quick all-in-one check

```bash
echo "=== Check 1: Temp dir ===" && \
(ls /mnt/c/temp/pane-build/node_modules >/dev/null 2>&1 && echo "node_modules: REUSABLE" || echo "node_modules: missing") && \
echo "=== Check 2: GitHub ===" && \
curl -sf --connect-timeout 5 -o /dev/null https://github.com && echo "curl: OK (may still need mirror)" || echo "curl: BLOCKED (MUST set ELECTRON_MIRROR)" && \
echo "=== Check 3: Lockfile ===" && \
(ls /mnt/c/temp/pane-build/pnpm-lock.yaml >/dev/null 2>&1 && echo "pnpm-lock.yaml: PRESENT (remove before electron-builder)" || echo "pnpm-lock.yaml: OK")
```

## Steps

1. Run pre-flight checks (see above).

2. Run from WSL2 inside the project root:

   ```bash
   ./scripts/pack-win.sh          # x64 (default)
   ./scripts/pack-win.sh arm64    # ARM64
   ./scripts/pack-win.sh --skip-build  # reuse existing main/dist + frontend/dist
   ```

3. The script does everything:
   - Builds JS in WSL (`pnpm run build:frontend && build:main && inject-build-info && generate-notices`)
   - Copies artifacts to `C:\temp\pane-build` (NTFS, not UNC)
   - Runs `npm install --ignore-scripts` + `electron-rebuild` on Windows side via `powershell.exe`
   - Runs `electron-builder --win portable --{arch}` on Windows side
   - Copies the `.exe` back to `dist-electron/`

4. Output is at `/mnt/c/temp/pane-build/dist-electron/Pane-{version}-Windows-{arch}.exe`.

## Resource Reuse

The build downloads ~150MB of binaries on first run. The script relies on tool-native caches instead of maintaining a custom cache key.

### Cache mechanism

`pack-win.sh` preserves `C:\temp\pane-build\node_modules\` and `package-lock.json`, then runs `npm install --ignore-scripts` every time. npm decides what is already current and reuses both `node_modules` and `%LOCALAPPDATA%\npm-cache\`.

The script also runs `electron-rebuild` every time for correctness. Do not replace this with a custom dependency hash unless the key includes Electron version, ABI, architecture, native module list, and install flags.

### What gets cached where

| Resource | Cache Location | Controlled By |
|----------|---------------|---------------|
| npm packages + native modules | `C:\temp\pane-build\node_modules\` | preserved by script, refreshed by npm |
| npm lockfile | `C:\temp\pane-build\package-lock.json` | npm generated/reused |
| npm download cache | `%LOCALAPPDATA%\npm-cache\` | npm built-in |
| Electron binary (~136MB) | `%LOCALAPPDATA%\electron\Cache\` | `ELECTRON_MIRROR` env var |
| NSIS toolkit + resources | `%LOCALAPPDATA%\electron-builder\Cache\` | electron-builder built-in |
| 7zip | `%LOCALAPPDATA%\electron-builder\Cache\7zip\` | electron-builder built-in |
| WSL build artifacts | `frontend/dist/`, `main/dist/` | `--skip-build` flag |
| Previous portable EXE | `C:\temp\pane-build\dist-electron\*.exe` | preserved by targeted cleanup |

### Typical incremental build (after first build)

With `ELECTRON_MIRROR` set in shell profile:
```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
./scripts/pack-win.sh x64
# Step 1: WSL build (~20s)
# Step 2: Copy artifacts (~2s)
# Step 3: npm install refreshes existing node_modules using cache
# Step 4: electron-rebuild refreshes native modules
# Step 5: electron-builder packaging uses cached Electron/NSIS/7zip binaries
```

### Cache consistency

The `ELECTRON_MIRROR` URL is part of the Electron cache key. If you switch between mirror and direct GitHub downloads, the binary is re-downloaded. Keep the mirror setting consistent — add to `~/.bashrc`.

## Prerequisites

- WSL2 with interop enabled (`/etc/wsl.conf` → `[interop] enabled=true`)
- Windows side: Node.js 22+, npm, Python 3.x, Visual Studio Build Tools (C++ workload)
- WSL side: pnpm

## Troubleshooting

### `rm: cannot remove '/mnt/c/temp/pane-build': Permission denied`

Windows file lock. The script now falls back to targeted PowerShell cleanup automatically. If you need to clean manually, delete only generated payloads and preserve caches:
```bash
powershell.exe -NoProfile -Command "Remove-Item -Recurse -Force 'C:\temp\pane-build\main','C:\temp\pane-build\frontend','C:\temp\pane-build\main-dist','C:\temp\pane-build\frontend-dist','C:\temp\pane-build\build','C:\temp\pane-build\dist-electron\win-unpacked' -ErrorAction SilentlyContinue"
./scripts/pack-win.sh x64 --skip-build
```

### `connect ETIMEDOUT 20.x.x.x:443` during electron-builder

GitHub unreachable. Set mirror env vars (the script passes them through automatically):
```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
./scripts/pack-win.sh x64
```

### `No JSON content found in output` from PnpmNodeModulesCollector

This should no longer happen — the script skips copying `pnpm-lock.yaml`. If you see this, check that no stale `pnpm-lock.yaml` exists in `C:\temp\pane-build\`:
```bash
rm -f /mnt/c/temp/pane-build/pnpm-lock.yaml
```

### npm install hangs / times out (>10 minutes)

Windows npm can be slow on first install. If the tool timeout hits, re-run with `--skip-build` — the partially installed `node_modules` will be detected and reused.

### Electron re-downloaded every build

Check that `ELECTRON_MIRROR` is consistent across builds. The cache key includes the URL. If you set the mirror once but not the next time, it downloads again. Add to your shell profile for persistence:
```bash
# ~/.bashrc or ~/.zshrc
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## Portable data location

The portable EXE stores user data in `%APPDATA%/Pane/` by default. Set `PANE_DIR` environment variable to make it fully portable (data next to the EXE).
