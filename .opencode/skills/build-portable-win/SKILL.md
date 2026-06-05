---
name: build-portable-win
description: Build a portable Windows EXE for Pane — a standalone single-file executable that runs without installation. Use when the user wants to create a portable .exe instead of the NSIS installer.
argument-hint: "[optional: x64 or arm64, defaults to x64]"
---

# Build Portable Windows EXE

Pane already has a script for this: `scripts/pack-win.sh`. Run it from WSL2.

## Steps

1. Run from WSL2 inside the project root:

   ```bash
   ./scripts/pack-win.sh          # x64 (default)
   ./scripts/pack-win.sh arm64    # ARM64
   ./scripts/pack-win.sh --skip-build  # reuse existing main/dist + frontend/dist
   ```

2. The script does everything:
   - Builds JS in WSL (`pnpm run build:frontend && build:main && inject-build-info && generate-notices`)
   - Copies artifacts to `C:\temp\pane-build` (NTFS, not UNC)
   - Runs `npm install --ignore-scripts` + `electron-rebuild` on Windows side via `powershell.exe`
   - Runs `electron-builder --win portable --{arch}` on Windows side
   - Copies the `.exe` back to `dist-electron/`

3. Output is at `/mnt/c/temp/pane-build/dist-electron/Pane-portable-{version}-Windows-{arch}.exe`.

## Prerequisites

- WSL2 with interop enabled (`/etc/wsl.conf` → `[interop] enabled=true`)
- Windows side: Node.js 22+, npm, Python 3.x, Visual Studio Build Tools (C++ workload)
- WSL side: pnpm

## Portable data location

The portable EXE stores user data in `%APPDATA%/Pane/` by default. Set `PANE_DIR` environment variable to make it fully portable (data next to the EXE).
