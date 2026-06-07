# Plan: Fix Windows ConPTY vim mouse support in TerminalPanel

## Problem

On Windows, vim with `:set mouse=a` receives DOM `mousedown` in `TerminalPanel`, but xterm.js does not emit `onData`/`onBinary` mouse reports. Diagnostics showed no `ESC[?1000h`, `ESC[?1002h`, or `ESC[?1006h` mouse-mode sequences reached either main-process PTY output or renderer `writeAndAck`.

This matches known upstream ConPTY behavior: older/system ConPTY can swallow mouse-reporting requests and/or mouse reports, preventing xterm.js from entering mouse tracking mode.

## Evidence from research

- `microsoft/terminal#376`: ConPTY swallows mouse reporting escape sequences; vim `set mouse=a` has no effective mouse support.
- `microsoft/vscode#160917`: VS Code integrated terminal mouse interactions fail under ConPTY on affected Windows builds; disabling ConPTY works.
- `microsoft/node-pty#490`: Microsoft/node-pty tracks embedding newer ConPTY because Windows Terminal ships newer ConPTY with mouse support before it reaches system Windows.
- VS Code, Tabby, Hyper, Electerm production patterns:
  - Forward `xterm.raw.onBinary`/`terminal.onBinary` as binary, not text.
  - Pass xterm `windowsPty: { backend, buildNumber }` on Windows.
  - Provide or depend on a ConPTY backend/version switch rather than forcing mouse mode globally.

## Goals

1. Preserve correct mouse/binary input handling for all terminals.
2. Improve Windows ConPTY compatibility using xterm-supported configuration.
3. Provide a practical fallback for affected Windows builds where ConPTY mouse support is absent.
4. Avoid broad hacks that break selection or non-mouse TUIs.

## Non-goals

- Do not implement native Win32 `GetConsoleMode`/`SetConsoleMode` hooks in this change.
- Do not patch or fork node-pty/ConPTY in this change.
- Do not force-enable xterm mouse tracking for all alternate-screen apps by default.

## Implementation steps

### 1. Fix binary input forwarding

**Files:**
- `frontend/src/components/panels/TerminalPanel.tsx`
- `main/src/ipc/panels.ts`
- `main/src/services/terminalPanelManager.ts`
- remote equivalents if needed: `frontend/src/remote/hooks/useRemoteTerminal.ts`, `frontend/src/remote/runtime/remoteRuntimeAdapter.ts`

**Change:**
- Ensure `terminal.onBinary((data) => ...)` invokes `terminal:inputBinary` instead of `terminal:input`.
- Ensure main writes binary input via `Buffer.from(data, 'binary')`.
- Keep normal `onData` path unchanged.

**Expected result:**
- xterm legacy/non-UTF8 mouse reports and other binary input are preserved byte-for-byte.

### 2. Add xterm `windowsPty` option

**Files:**
- `frontend/src/components/panels/TerminalPanel.tsx`
- shared/preload/config plumbing as needed for Windows build/backend info

**Change:**
- On Windows, pass xterm:
  ```ts
  windowsPty: {
    backend: 'conpty',
    buildNumber,
  }
  ```
- Retrieve Windows build number from main/preload, not from renderer-only assumptions.
- If Pane is using a legacy/non-ConPTY backend, set `backend: 'winpty'` where applicable.

**Expected result:**
- xterm applies Windows PTY compatibility heuristics consistently with VS Code/Tabby/Hyper patterns.

### 3. Add a Windows ConPTY fallback setting

**Files:**
- config schema/store files
- settings UI if exposed
- PTY spawn sites:
  - `main/src/services/terminalPanelManager.ts`
  - `main/src/services/panels/cli/AbstractCliManager.ts`
  - `main/src/services/runCommandManager.ts`
  - ptyHost spawn path if applicable

**Change:**
- Add setting such as `terminalUseConpty` / `windowsUseConpty` defaulting to current behavior.
- When false, pass node-pty `useConpty: false` if the current node-pty fork supports it.
- Document that this is a compatibility fallback for vim/tmux mouse on affected Windows builds.

**Expected result:**
- Users on affected Windows builds can disable ConPTY for terminals needing mouse support.

### 4. Add targeted diagnostics, disabled by default

**Files:**
- `TerminalPanel.tsx`
- `terminalPanelManager.ts`

**Change:**
- Optional debug logging for:
  - Windows build number
  - PTY backend
  - whether `onBinary` fired
  - whether mouse DECSET output reached main/renderer
- Gate under existing dev/debug logging to avoid noisy production logs.

**Expected result:**
- Future reports can distinguish:
  - xterm never entered mouse mode
  - xterm emitted binary reports but they were corrupted/dropped
  - ConPTY rejected generated mouse reports

### 5. Optional experiment only: forced local mouse tracking

**Status:** experimental, not default.

**Change:**
- Add a dev-only or hidden setting that writes `ESC[?1002h ESC[?1006h` to xterm when alternate screen is active, and disables them on exit.

**Use only to test:**
- Whether affected ConPTY builds accept generated xterm mouse reports back into vim.

**Do not ship as default** because it can break text selection and non-mouse TUIs.

## Validation plan

### Unit/type checks

- Run `pnpm typecheck`.
- Run `pnpm lint`.
- Run targeted tests if existing IPC/remote terminal tests cover `terminal:inputBinary`.

### Manual QA

On Windows:

1. Start Pane with `PANE_DIR=~/.pane_test pnpm dev`.
2. Open a terminal.
3. Run vim:
   ```sh
   vim test.txt
   :set mouse=a
   ```
4. Click inside vim.
5. Expected by environment:
   - On Windows builds/newer ConPTY where mouse is supported: cursor moves/click is handled.
   - On affected builds: with ConPTY enabled, mouse may still fail; with fallback disabled ConPTY/winpty path, mouse should be retested.
6. Confirm logs:
   - `onBinary` uses `terminal:inputBinary`.
   - No corrupted binary writes.

### Regression checks

- Normal typing still works.
- Paste still works, including image/path paste behavior.
- Drag/drop still works.
- Terminal selection still works when no app has enabled mouse mode.
- TUI apps that do not use mouse still behave normally.

## Recommended order

1. Implement binary forwarding fix.
2. Add `windowsPty` option.
3. Add ConPTY fallback setting if node-pty support is available.
4. Validate vim/tmux on Windows versions available.
5. Only consider newer/bundled ConPTY or forced mouse-mode experiment if steps 1-3 are insufficient.

## Risks

- `useConpty: false` may not be supported by `@lydell/node-pty` or may regress rendering/performance.
- `windowsPty` requires reliable backend/build metadata from main to renderer.
- Forced mouse tracking can break selection and should remain experimental.
- Bundling newer ConPTY affects packaging and native dependency/rebuild complexity.
