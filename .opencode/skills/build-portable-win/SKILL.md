---
name: build-portable-win
description: Build a portable Windows EXE for Pane — a standalone single-file executable that runs without installation. Use when the user wants to create a portable .exe instead of the NSIS installer.
argument-hint: "[optional: x64 or arm64, defaults to x64]"
---

# Build Portable Windows EXE

Run `scripts/pack-win.sh` from WSL2. Output: `/mnt/c/temp/pane-build/dist-electron/Pane-{version}-Windows-{arch}.exe`.

## Mirror (REQUIRED in China / behind firewall)

electron-builder downloads Electron, NSIS, 7zip, and winCodeSign from GitHub. Without a mirror, the connection can hang indefinitely (near-zero CPU, no progress). Set both env vars — they are part of the cache key, so keep them consistent across builds.

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
./scripts/pack-win.sh x64
```

Add to `~/.bashrc` for persistence.

## Usage

```bash
./scripts/pack-win.sh              # x64 (default), full build
./scripts/pack-win.sh arm64        # ARM64
./scripts/pack-win.sh x64 --skip-build  # reuse existing frontend/dist + main/dist
```

`--skip-build` skips the ~20s WSL JS build. Use it when re-running after a failed packaging step.

## Troubleshooting

### electron-builder hangs (no progress, low CPU)

`winCodeSign` downloads from GitHub even when signing is disabled. Kill the stuck process and retry with mirrors:

```bash
powershell.exe -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -match 'electron-builder' } | Stop-Process -Force"
./scripts/pack-win.sh x64 --skip-build
```

### Permission denied on temp directory

Windows file lock. Manual cleanup preserving caches:

```bash
powershell.exe -NoProfile -Command "Remove-Item -Recurse -Force 'C:\temp\pane-build\main','C:\temp\pane-build\frontend','C:\temp\pane-build\build','C:\temp\pane-build\dist-electron\win-unpacked' -ErrorAction SilentlyContinue"
./scripts/pack-win.sh x64 --skip-build
```

## Portable data location

User data goes to `%APPDATA%/Pane/` by default. Set `PANE_DIR` env var to make it fully portable (data next to the EXE).
