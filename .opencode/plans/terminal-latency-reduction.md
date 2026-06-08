# Terminal Input/Output Latency Reduction

## Problem

Typing in Pane terminals feels noticeably laggier than VS Code's integrated terminal. End-to-end keystroke-to-echo latency is ~10-40ms in Pane vs ~2ms in VS Code.

### Root Causes (ordered by impact)

| # | Cause | Extra Latency | Location |
|---|---|---|---|
| 1 | Input uses `ipcRenderer.invoke()` (request-response) for a fire-and-forget operation | +1-3ms per keystroke | `TerminalPanel.tsx:1278-1283` |
| 2 | All `terminal:*` channels routed through `daemon:invoke` bridge (channel validation + async indirection) | +0.5-2ms | `preload.ts:405-406` → `daemon.ts:25-34` |
| 3 | PTY echo output waits in 32ms batch window before being sent back to renderer | +0-32ms | `terminalPanelManager.ts:1065-1073` |
| 4 | `force_low_power_gpu` forces weak iGPU for WebGL rendering | continuous (slower frame renders) | `index.ts:25` |
| 5 | WebGL renderer destroyed+rebuilt on every tab switch | ~30ms stutter per switch | `TerminalPanel.tsx:348-360` |

### Data Flow Comparison

**VS Code (local terminal):**
```
xterm.onData → processManager.write(data) → process.input(data) → pty
                                                                        ↓ echo
xterm.write(data) ← Emitter event ← pty.onData                        │
```
Everything in the same process. Zero IPC. ~0-1ms each way.

**Pane (current):**
```
xterm.onData
  → interceptor.handleInput(data)
    → ipcRenderer.invoke('daemon:invoke', 'terminal:input', ...)
      → main: daemon:invoke handler
        → bridgeRouter.invoke()
          → remotePaneClientController (checks remote mode)
            → commandRegistry.invoke()
              → terminalPanelManager.writeToTerminal()
                → pty.write(data)
                    ↓ echo
                    pty.onData → outputBuffer → 32ms batch timer → flush
                      → ipcMain send → ipcRenderer on → terminal.write()
```
Two IPC round-trips + 32ms batch window = ~10-40ms.

---

## Implementation Plan

### Fix 1: Add `ipcRenderer.send()` fast path for terminal input (HIGH IMPACT)

`terminal:input` handler returns `void` — there is nothing to await. Use `send` instead of `invoke`.

**Files to change:**

#### `main/src/preload.ts`

Add a dedicated `send` method alongside the existing `invoke`:

```typescript
// Add near the existing invokeIpc function (~line 404)
function sendIpc(channel: string, ...args: unknown[]): void {
  ipcRenderer.send(channel, ...args);
}

// Expose on electronAPI (~line 414)
send: (channel: string, ...args: unknown[]) => sendIpc(channel, ...args),
```

#### `frontend/src/components/panels/TerminalPanel.tsx`

Replace all `window.electronAPI.invoke('terminal:input', ...)` with `window.electronAPI.send('terminal:input', ...)`:

- Line ~1278: `window.electronAPI.invoke('terminal:input', panel.id, data);`
  → `window.electronAPI.send('terminal:input', panel.id, data);`
- Line ~1283: `window.electronAPI.invoke('terminal:input', panel.id, data);`
  → `window.electronAPI.send('terminal:input', panel.id, data);`
- Line ~1296: `window.electronAPI.invoke('terminal:input', panel.id, data);`
  → `window.electronAPI.send('terminal:input', panel.id, data);`
- Line ~1183 (interceptor flush): same change

#### `main/src/ipc/panels.ts`

Add an `ipcMain.on('terminal:input', ...)` listener alongside the existing `commandRegistry.register` handler. The `on` handler fires synchronously without creating a response promise:

```typescript
// Add after the commandRegistry.register('terminal:input', ...) block (~line 548)
// Fire-and-forget listener for low-latency input from renderer's ipcRenderer.send()
ipcMain.on('terminal:input', (_event, panelId: string, data: string) => {
  terminalPanelManager.writeToTerminal(panelId, data);
});
```

**Why keep both?** `commandRegistry.register` still handles the `daemon:invoke` path (remote mode, HTTP API, Unix socket daemon). The `ipcMain.on` is a parallel fast path for local renderer input only.

**Expected improvement:** Input IPC overhead drops from ~2-5ms to ~0.2-0.5ms (fire-and-forget, no Promise creation, no response serialization).

---

### Fix 2: Immediate flush for small echo responses (HIGH IMPACT)

When the PTY echoes back a small response (typical for typed characters: 1-50 bytes), flush immediately instead of waiting for the 32ms batch window.

**File to change:**

#### `main/src/services/terminalPanelManager.ts`

In the PTY `onData` handler (~line 1056-1074), add a fast-flush heuristic:

```typescript
// Current code (line 1056-1074):
terminal.outputBuffer += filtered;
const sizeThreshold = terminal.isVisible ? OUTPUT_BATCH_SIZE : OUTPUT_BATCH_SIZE_HIDDEN;
if (terminal.outputBuffer.length >= sizeThreshold) {
  this.flushOutputBuffer(terminal);
} else if (!terminal.outputFlushTimer) {
  const interval = terminal.isVisible ? OUTPUT_BATCH_INTERVAL : OUTPUT_BATCH_INTERVAL_HIDDEN;
  terminal.outputFlushTimer = setTimeout(() => {
    this.flushOutputBuffer(terminal);
  }, interval);
}

// New code — add immediate flush for small, likely-echo chunks:
terminal.outputBuffer += filtered;

if (!terminal.isVisible) {
  // Hidden panels: existing batch logic unchanged
  if (terminal.outputBuffer.length >= OUTPUT_BATCH_SIZE_HIDDEN) {
    this.flushOutputBuffer(terminal);
  } else if (!terminal.outputFlushTimer) {
    terminal.outputFlushTimer = setTimeout(() => {
      this.flushOutputBuffer(terminal);
    }, OUTPUT_BATCH_INTERVAL_HIDDEN);
  }
  return;
}

// Visible panel: flush immediately if the chunk is small enough to be
// an interactive echo response (typed character, cursor move, etc.)
// rather than a bulk output burst from an agent.
const INPUT_ECHO_THRESHOLD = 256; // bytes — single keystroke echo is ~1-20 bytes
if (filtered.length <= INPUT_ECHO_THRESHOLD) {
  // Accumulate into the buffer first (for scrollback tracking),
  // then flush immediately without waiting for the batch timer.
  this.flushOutputBuffer(terminal);
} else if (terminal.outputBuffer.length >= OUTPUT_BATCH_SIZE) {
  this.flushOutputBuffer(terminal);
} else if (!terminal.outputFlushTimer) {
  terminal.outputFlushTimer = setTimeout(() => {
    this.flushOutputBuffer(terminal);
  }, OUTPUT_BATCH_INTERVAL);
}
```

**Key insight:** PTY echo for a single keystroke is typically 1-20 bytes (the character + maybe ANSI cursor positioning). Agent output bursts are 500+ bytes. The 256-byte threshold reliably distinguishes interactive echo from bulk output.

**Expected improvement:** Echo latency drops from 0-32ms to ~0-2ms for interactive typing. Bulk output (agent streaming) still batches at 32ms for IPC efficiency.

---

### Fix 3: Remove `force_low_power_gpu` or make it configurable (MEDIUM IMPACT)

**File to change:**

#### `main/src/index.ts`

```typescript
// Line 25: Current
app.commandLine.appendSwitch('force_low_power_gpu');

// Option A: Remove entirely (simplest, best for performance)
// (delete the line)

// Option B: Make it conditional on battery saver terminal power mode
const configManager = getRuntimeConfigManager(); // may not be available this early
// → Better: read from a file/env var, or expose as a setting
```

**Caveat:** This was added intentionally for ARM Windows dual-GPU battery life (see `briefs/wsl-performance-bg-cost.md`). Removing it helps rendering speed but hurts battery on dual-GPU laptops.

**Recommended approach:** Add a `terminal.useHighPerformanceGpu` boolean to the existing `AppConfig` settings. Default to `true` (matches VS Code's behavior). When `false`, keep `force_low_power_gpu`. The setting applies on next app launch (Electron command-line switches must be set before `app.ready`).

#### `frontend/src/components/settings/` (wherever terminal settings are rendered)

Add a toggle: "High performance GPU rendering" with description "Uses discrete GPU for faster terminal rendering. Disable to improve battery life on laptops."

**Expected improvement:** WebGL rendering frame time drops significantly on dual-GPU systems (dGPU is 3-10x faster than iGPU for WebGL texture ops).

---

### Fix 4: Delay WebGL detach on tab switch (MEDIUM IMPACT)

Currently, WebGL is destroyed the instant a panel becomes inactive and rebuilt when it becomes active again. Each rebuild costs ~30ms (context creation + shader compilation + glyph atlas upload).

**File to change:**

#### `frontend/src/components/panels/TerminalPanel.tsx`

In the WebGL policy effect (~line 316-346), add a delay before detaching:

```typescript
// Current: immediate detach when panel hides
useEffect(() => {
  if (blurDetachTimerRef.current) {
    clearTimeout(blurDetachTimerRef.current);
    blurDetachTimerRef.current = null;
  }
}, [panelVisible, windowFocused, disposeWebglRenderer]);

// New: delay detach by 2 seconds so quick tab switches don't trigger rebuild
const WEBGL_DETACH_DELAY_MS = 2000;

useEffect(() => {
  if (blurDetachTimerRef.current) {
    clearTimeout(blurDetachTimerRef.current);
    blurDetachTimerRef.current = null;
  }

  if (panelVisible) {
    // Panel became visible — cancel any pending detach, keep/reattach WebGL
    return;
  }

  // Panel became hidden — schedule delayed detach
  blurDetachTimerRef.current = setTimeout(() => {
    blurDetachTimerRef.current = null;
    disposeWebglRenderer('panel-hidden-delayed');
  }, WEBGL_DETACH_DELAY_MS);

  return () => {
    if (blurDetachTimerRef.current) {
      clearTimeout(blurDetachTimerRef.current);
      blurDetachTimerRef.current = null;
    }
  };
}, [panelVisible, disposeWebglRenderer]);
```

**Expected improvement:** Tab switching between 2-3 terminals within 2 seconds has zero WebGL rebuild cost. The existing `webglAllowed` state logic (~line 350) needs updating to not set `false` on hide (which triggers dispose).

---

## What NOT to Change

These are already well-optimized (confirmed in `briefs/wsl-performance-bg-cost.md`):

- `cursorBlink: false` — no continuous redraw
- `minimumContrastRatio: 1` — no expensive color math
- `allowTransparency: false` — no compositing overhead
- `scrollback: 2500` — reasonable
- Hidden panel PTY batch = 250ms — already optimized
- ACK backpressure — correctly mirrors VS Code FlowControlConstants
- FitAddon debounce (300ms) — already done
- `display: none` for hidden panels — DOM paint correctly skipped
- SerializeAddon snapshot on deactivate-only — already optimized

## Validation Plan

### Before/After Measurements

On the dev machine (Windows), with one active Claude panel streaming tokens:

1. **Perceived input latency**: Type rapidly in the terminal — measure time from keypress to character appearing
   - Before: ~30-40ms (visible as slight drag)
   - After Fix 1+2: ~5-10ms (should feel instant)

2. **Tab switch stutter**: Switch between 2 active terminal tabs
   - Before: ~30ms flash of stale content
   - After Fix 4: ~0ms (WebGL survives the switch)

3. **GPU usage**: Check `chrome://gpu` or Task Manager GPU engine %
   - Before Fix 3: Low GPU % but slow renders
   - After Fix 3: Higher GPU % but faster renders

### Regression Guards

- Remote Pane mode must still work: `terminal:input` through `daemon:invoke` path is unchanged
- Background panel battery cost: Fix 2 only applies to visible panels; hidden panels keep 250ms batching
- Flow control: Fix 2 does not affect ACK/backpressure — `flushOutputBuffer` updates flow control counters regardless of flush timing
- ptyHost UtilityProcess: Fixes are transparent to the ptyHost — they only affect the IPC layer above it

## Execution Order

1. **Fix 1** (input send) — 3 files, ~30 min, biggest bang for buck
2. **Fix 2** (echo immediate flush) — 1 file, ~15 min, eliminates the 32ms batch delay
3. **Fix 3** (GPU setting) — 2 files, ~30 min, involves settings UI
4. **Fix 4** (WebGL detach delay) — 1 file, ~20 min, needs careful state management

Fixes 1+2 together should reduce perceived input latency by ~80%. Fixes 3+4 are polish.
