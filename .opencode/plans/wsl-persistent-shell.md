# WSL Persistent Shell — Eliminate per-command `wsl.exe` startup overhead

## Problem

Each `execSync`/`execAsync` call with a WSL context spawns a fresh `wsl.exe` process. On Windows, `wsl.exe` startup costs ~300ms per invocation (VM init + bash login). During session creation, `worktreeManager.createWorktree()` runs 6+ sequential git commands → **~1.8s wasted** on wsl.exe startup alone.

## Solution

Keep one `wsl.exe → bash` process alive per WSL distro. Route all WSL commands through its stdin/stdout pipes using subshell isolation + sentinel-delimited output capture.

### Architecture

```
WSLPersistentShellPool (singleton)
├── "Ubuntu"  → WSLPersistentShell
│               spawn: wsl.exe -d Ubuntu -- bash --noprofile --norc -i
│               stdin  ← "(cd '/path' && git rev-parse HEAD) 2>&1; printf '\x01EXIT_%d\x01\n' $?"
│               stdout → "abc123\n\x01EXIT_0\x01\n"
│
└── "Debian"  → WSLPersistentShell
                spawn: wsl.exe -d Debian -- bash --noprofile --norc -i
```

### Expected Performance

| Scenario | Before | After |
|---|---|---|
| Single WSL command | ~300ms | ~10ms (fork only) |
| Worktree creation (6 commands) | ~1.8s | ~360ms |
| First command (shell cold start) | ~300ms | ~300ms (one-time) |

---

## Implementation Plan

### File 1: `main/src/utils/wslPersistentShell.ts` (NEW)

Persistent shell manager. One class per distro instance, pooled by distro name.

```typescript
class WSLPersistentShell {
  private proc: ChildProcess;
  private stdoutBuffer: string;
  private pending: { resolve, reject, regex, output, timer } | null;
  private commandQueue: Array<() => Promise<void>>;

  constructor(distro: string)

  // Run a command in a subshell with cwd isolation
  async exec(command: string, options: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  }): Promise<{ stdout: string; exitCode: number }>

  // Graceful shutdown
  async dispose(): Promise<void>
}
```

**Sentinel protocol** — each command is wrapped:

```bash
# Sent to stdin:
<env exports>; (cd '<escaped-cwd>' && <command>) 2>&1; printf '\x01EXIT_%d\x01\n' "$?"

# Read from stdout until:
/\x01EXIT_(\d+)\x01/
```

- `\x01` (SOH) chosen because it never appears in git/shell output
- Parentheses `(...)` create a subshell so `cd` and `export` don't leak
- `2>&1` merges stderr into stdout (matches current `execFileSync` behavior)
- Exit code embedded in sentinel so caller knows success/failure

**Command queue** — serial execution within one persistent shell:

```
exec(cmd1) → enqueue → run → resolve
exec(cmd2) → enqueue → wait → run → resolve
```

Prevents output interleaving when multiple callers hit the same distro concurrently. If parallelism is needed later, the pool can hand out multiple shells per distro.

**Auto-recovery** — if `wsl.exe` exits unexpectedly:

1. `proc.on('exit')` fires
2. Reject the current `pending` promise with a `WSLShellDiedError`
3. Next `exec()` call spawns a fresh `wsl.exe` (lazy re-init)

**Environment injection** — extra env vars passed per-command:

```bash
# Prepend to the command line before subshell:
export VAR1='val1'; export VAR2='val2'; (cd '/cwd' && command) ...
```

### File 2: `main/src/utils/commandExecutor.ts` (MODIFY)

Route WSL context commands through the persistent shell pool instead of `execFileSync('wsl.exe')`.

**Changes in `execSync()`:**

```typescript
// BEFORE (line 52-90):
if (wslContext) {
  const { file, args } = getWSLExecArgs(command, wslContext.distribution, wslCwd, extraEnv);
  const result = nodeExecFileSync(file, args, wslOptions);
  return result;
}

// AFTER:
if (wslContext) {
  const shell = wslPersistentShellPool.getShell(wslContext.distribution);
  const result = shell.execSync(command, { cwd: wslCwd, env: extraEnv, timeout });
  if (result.exitCode !== 0) throw new Error(result.stderr || `Command failed: ${command}`);
  return result.stdout;
}
```

**Changes in `execAsync()`:** same pattern, using `shell.exec()`.

**Fallback:** if persistent shell init fails (e.g. wsl.exe not found), fall through to existing `execFileSync` path.

### File 3: `main/src/utils/wslUtils.ts` (MODIFY)

Add `escapeForBashSingleQuote()` helper if not already exported (it exists as `escapeForBash` already).

No other changes needed — `getWSLExecArgs()` remains for non-persistent callers (e.g. `gitFileWatcher.ts`'s inotifywait spawn, which needs its own long-lived process anyway).

---

## Edge Cases

### Binary output
Commands like `git diff --binary` produce non-text stdout. The sentinel uses `\x01` which is a valid byte but never in git text output. If binary output is a concern, base64-encode the output before the sentinel. **Not needed for Pane's current usage** — all WSL commands are text-based git/shell commands.

### Large output
Current `maxBuffer` is 10MB. Persistent shell has no Node.js buffer limit (we read from the pipe), but we should add a configurable cap to prevent OOM. Default: 10MB, reject if exceeded.

### Timeout
Per-command timeout via `setTimeout`. On timeout: write `\x03` (Ctrl-C) to stdin to interrupt the subshell, then reject the promise. The persistent bash itself stays alive.

### Bash init scripts
Use `--noprofile --norc` to skip `.bashrc`/`.profile` (fastest). This means `nvm`, `conda`, etc. won't be loaded. Pane already handles PATH via `getShellPath()` and WSLENV, so this is fine for git/system commands. If a user's build script needs nvm, they should `source ~/.nvm/nvm.sh` in the script itself.

### Multiple distros
The pool is keyed by distro name. Each distro gets its own persistent shell. Memory cost: ~30MB per active wsl.exe process (WSL2 VM shares kernel, bash itself is ~5MB).

---

## Testing

### Unit tests (`main/src/utils/wslPersistentShell.test.ts`)

```
- exec returns stdout and exit code
- exec with cwd isolation (cd in subshell doesn't persist)
- exec with env vars
- exec timeout triggers rejection and sends Ctrl-C
- exit code propagation (non-zero exit throws)
- auto-recovery after shell crash
- command queue serialization
- dispose kills process
```

### Manual test

Compare worktree creation time before/after:

```bash
# Before (current):
# 6 × wsl.exe spawns ≈ 1.8s

# After (persistent shell):
# 1 × wsl.exe spawn + 6 × fork ≈ 0.4s
```

---

## Rollback Plan

The persistent shell is behind a feature flag. If it causes issues:

```typescript
// commandExecutor.ts
if (wslContext) {
  if (runtimeConfigManager.getUseWSLPersistentShell()) {
    // new path
  } else {
    // existing execFileSync path (unchanged)
  }
}
```

Setting: `useWSLPersistentShell` in RuntimeConfigManager, default `true`. Users can disable in Settings if needed.

---

## Files Changed

| File | Action | Lines (est.) |
|---|---|---|
| `main/src/utils/wslPersistentShell.ts` | NEW | ~200 |
| `main/src/utils/commandExecutor.ts` | MODIFY | ~30 changed |
| `main/src/utils/wslPersistentShell.test.ts` | NEW | ~150 |

**No frontend changes.** No new IPC channels. No changes to terminal spawn path. The persistent shell is purely an optimization of the command execution layer — transparent to all callers.
