import { randomUUID } from 'crypto';
import { ChildProcess, spawn as nodeSpawn } from 'child_process';
import { getShellPath } from './shellPath';
import { escapeForBash } from './wslUtils';

// --- Types ---

export interface WSLPersistentShellExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  silent?: boolean;
}

export interface WSLPersistentShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Creates an error that mimics the shape of a native execFile error
 * for non-zero exits from the persistent shell. Used by commandExecutor
 * integration to preserve error compatibility with existing callers.
 */
export function createExecFileLikeError(
  command: string,
  result: WSLPersistentShellResult,
): Error & { code: number; stdout: string; stderr: string; cmd: string } {
  const error = new Error(`Command failed: ${command}\n${result.stderr}`);
  Object.assign(error, {
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    cmd: command,
  });
  return error as Error & { code: number; stdout: string; stderr: string; cmd: string };
}

export interface BuildWSLPersistentShellCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  markerId?: string;
  maxBuffer?: number;
}

type WSLPersistentShellErrorPhase =
  | 'spawn'
  | 'validate'
  | 'write'
  | 'running'
  | 'protocol'
  | 'dispose';

export class WSLPersistentShellError extends Error {
  code?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  commandStarted: boolean;
  phase: WSLPersistentShellErrorPhase;

  constructor(message: string, opts: {
    code?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    commandStarted: boolean;
    phase: WSLPersistentShellErrorPhase;
  }) {
    super(message);
    this.name = 'WSLPersistentShellError';
    this.code = opts.code;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.commandStarted = opts.commandStarted;
    this.phase = opts.phase;
  }
}

// --- Env validation ---

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateEnvNames(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!ENV_NAME_RE.test(key)) {
      throw new WSLPersistentShellError(
        `Invalid environment variable name: ${key}`,
        { commandStarted: false, phase: 'validate' },
      );
    }
  }
}

// --- Command builder ---

export function buildWSLPersistentShellCommand(
  command: string,
  options: BuildWSLPersistentShellCommandOptions,
): { script: string; markerId: string } {
  const markerId = options.markerId ?? randomUUID();
  const maxBuffer = options.maxBuffer ?? 1024 * 1024; // 1 MiB default

  if (options.env && Object.keys(options.env).length > 0) {
    validateEnvNames(options.env);
  }

  const stderrStartMarker = `__PANE_WSL_STDERR_START_${markerId}__`;
  const stderrEndMarker = `__PANE_WSL_STDERR_END_${markerId}__`;
  const exitMarker = `__PANE_WSL_EXIT_${markerId}`;

  const envExports = options.env
    ? Object.entries(options.env)
        .map(([k, v]) => `export ${k}=${escapeForBash(v)}`)
        .join('\n  ')
    : '';

  const cdSegment = options.cwd
    ? `cd ${escapeForBash(options.cwd)} || exit $?;`
    : '';

  const innerCommand = [
    cdSegment,
    envExports,
    `bash --noprofile --norc -c ${escapeForBash(command)}`,
  ]
    .filter(Boolean)
    .join('\n  ');

  // Build the full wrapper script
  const script = [
    `stderrFile="$(mktemp /tmp/pane-wsl-stderr.XXXXXX)"`,
    `maxBufFlagFile="$(mktemp /tmp/pane-wsl-maxbuf.XXXXXX)"`,
    ``,
    `(`,
    `  ${innerCommand}`,
    `) </dev/null 2> "$stderrFile" &`,
    `cmdPid=$!`,
    ``,
    `# Monitor loop: check stderr size while command is alive`,
    `while kill -0 "$cmdPid" 2>/dev/null; do`,
    `  stderrSize="$(stat -c%s "$stderrFile" 2>/dev/null || echo 0)"`,
    `  if [ "$stderrSize" -gt ${maxBuffer} ]; then`,
    `    echo "1" > "$maxBufFlagFile"`,
    `    kill "$cmdPid" 2>/dev/null`,
    `    wait "$cmdPid" 2>/dev/null`,
    `    break`,
    `  fi`,
    `  sleep 0.1`,
    `done`,
    ``,
    `# Capture final exit code`,
    `wait "$cmdPid" 2>/dev/null`,
    `exitCode=$?`,
    ``,
    `# Compute final stderr size`,
    `finalSize="$(stat -c%s "$stderrFile" 2>/dev/null || echo 0)"`,
    ``,
    `# Emit stderr between markers`,
    `echo '${stderrStartMarker}'`,
    `if [ "$(cat "$maxBufFlagFile" 2>/dev/null)" = "1" ] || [ "$finalSize" -gt ${maxBuffer} ]; then`,
    `  head -c ${maxBuffer} "$stderrFile" 2>/dev/null`,
    `  echo ''`,
    `  echo '__PANE_WSL_STDERR_TRUNCATED__'`,
    `else`,
    `  cat "$stderrFile" 2>/dev/null`,
    `fi`,
    `echo '${stderrEndMarker}'`,
    ``,
    `# Clean up temp files`,
    `rm -f "$stderrFile" "$maxBufFlagFile"`,
    ``,
    `# Emit exit marker`,
    `echo '${exitMarker}_'"\${exitCode}__"`,
  ].join('\n');

  return { script, markerId };
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const STDERR_TRUNCATED_MARKER = '__PANE_WSL_STDERR_TRUNCATED__';

interface WSLPersistentShellQueueItem {
  resolve: (result: WSLPersistentShellResult) => void;
  reject: (error: WSLPersistentShellError) => void;
  command: string;
  options: WSLPersistentShellExecOptions;
  markerId: string;
  script: string;
  timer: ReturnType<typeof setTimeout> | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeShellError(
  message: string,
  opts: {
    code?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    commandStarted: boolean;
    phase: WSLPersistentShellErrorPhase;
  },
): WSLPersistentShellError {
  return new WSLPersistentShellError(message, opts);
}

export class WSLPersistentShell {
  private distro: string;
  private process: ChildProcess | null = null;
  private queue: WSLPersistentShellQueueItem[] = [];
  private currentResolve: ((result: WSLPersistentShellResult) => void) | null = null;
  private currentReject: ((error: WSLPersistentShellError) => void) | null = null;
  private currentItem: WSLPersistentShellQueueItem | null = null;
  private stdoutBuffer = '';
  private shellStderrBuffer = '';
  private disposed = false;
  private commandStarted = false;

  constructor(distro: string) {
    this.distro = distro;
  }

  async exec(command: string, options: WSLPersistentShellExecOptions = {}): Promise<WSLPersistentShellResult> {
    if (this.disposed) {
      throw makeShellError('WSL persistent shell has been disposed', {
        code: 'WSL_SHELL_DISPOSED',
        commandStarted: false,
        phase: 'dispose',
      });
    }

    const execOptions = {
      ...options,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    };
    const { script, markerId } = buildWSLPersistentShellCommand(command, execOptions);

    return new Promise<WSLPersistentShellResult>((resolve, reject) => {
      this.queue.push({
        resolve,
        reject,
        command,
        options: execOptions,
        markerId,
        script,
        timer: null,
      });
      this.processNext();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    const current = this.currentItem;
    if (current) {
      this.rejectItem(current, makeShellError('WSL persistent shell disposed', {
        code: 'WSL_SHELL_DISPOSED',
        commandStarted: this.commandStarted,
        phase: 'dispose',
      }));
      this.currentItem = null;
      this.currentResolve = null;
      this.currentReject = null;
    }

    for (const item of this.queue.splice(0)) {
      this.rejectItem(item, makeShellError('WSL persistent shell disposed', {
        code: 'WSL_SHELL_DISPOSED',
        commandStarted: false,
        phase: 'dispose',
      }));
    }

    this.killProcess();
    this.clearParserState();
  }

  private spawn(): void {
    if (this.process) return;

    const child = nodeSpawn(
      'wsl.exe',
      ['-d', this.distro, '--', 'bash', '--noprofile', '--norc'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PATH: getShellPath() },
      },
    );

    this.process = child;

    child.stdout?.on('data', (data: Buffer) => {
      this.handleStdoutData(data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      this.handleShellStderrData(data);
    });

    child.on('error', (error: Error) => {
      this.handleProcessError(child, error);
    });

    child.on('exit', () => {
      this.handleProcessExit(child);
    });
  }

  private processNext(): void {
    if (this.currentItem || this.queue.length === 0 || this.disposed) return;

    this.spawn();
    const item = this.queue.shift();
    if (!item) return;

    this.currentItem = item;
    this.currentResolve = item.resolve;
    this.currentReject = item.reject;
    this.stdoutBuffer = '';
    this.commandStarted = false;

    item.timer = setTimeout(() => {
      this.rejectCurrentAndReset(makeShellError(`WSL command timed out after ${item.options.timeout}ms`, {
        code: 'ETIMEDOUT',
        commandStarted: true,
        phase: 'running',
      }), true);
    }, item.options.timeout);

    try {
      if (!this.process?.stdin?.writable) {
        throw makeShellError('WSL persistent shell stdin is not writable', {
          code: 'WSL_SHELL_STDIN_CLOSED',
          commandStarted: false,
          phase: 'write',
        });
      }
      this.process.stdin.write(`${item.script}\n`);
      this.commandStarted = true;
    } catch (error: unknown) {
      const shellError = error instanceof WSLPersistentShellError
        ? error
        : makeShellError(error instanceof Error ? error.message : String(error), {
            code: 'WSL_SHELL_WRITE_FAILED',
            commandStarted: this.commandStarted,
            phase: 'write',
          });
      this.rejectCurrentAndReset(shellError, true);
    }
  }

  private handleStdoutData(data: Buffer): void {
    if (!this.currentItem) return;

    this.stdoutBuffer += data.toString('utf8');

    const maxBuffer = this.currentItem.options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const stdoutCandidate = this.getCurrentStdoutCandidate();
    if (Buffer.byteLength(stdoutCandidate, 'utf8') > maxBuffer) {
      this.rejectCurrentAndReset(makeShellError('stdout maxBuffer exceeded', {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        stdout: stdoutCandidate,
        commandStarted: true,
        phase: 'running',
      }), true);
      return;
    }

    const result = this.tryParseCurrentResult();
    if (!result) return;

    if (result.stderr.includes(STDERR_TRUNCATED_MARKER)) {
      this.rejectCurrentAndReset(makeShellError('stderr maxBuffer exceeded', {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        stdout: result.stdout,
        stderr: result.stderr.replace(STDERR_TRUNCATED_MARKER, '').trimEnd(),
        commandStarted: true,
        phase: 'running',
      }), true);
      return;
    }

    this.resolveCurrentAndContinue(result);
  }

  private handleShellStderrData(data: Buffer): void {
    if (!this.isCommandStderrMarkerActive()) {
      this.shellStderrBuffer += data.toString('utf8');
    }
  }

  private handleProcessError(child: ChildProcess, error: Error): void {
    if (this.process !== child) return;
    if (this.currentItem) {
      this.rejectCurrentAndReset(makeShellError(error.message, {
        code: 'WSL_SHELL_SPAWN_FAILED',
        stderr: this.shellStderrBuffer,
        commandStarted: this.commandStarted,
        phase: this.commandStarted ? 'running' : 'spawn',
      }), false);
    }
    this.process = null;
  }

  private handleProcessExit(child: ChildProcess): void {
    if (this.process !== child) return;
    this.process = null;
    if (!this.currentItem) return;

    this.rejectCurrentAndReset(makeShellError('WSL persistent shell exited while command was running', {
      code: 'WSL_SHELL_DIED',
      stdout: this.stdoutBuffer,
      stderr: this.shellStderrBuffer,
      commandStarted: this.commandStarted,
      phase: 'running',
    }), false);
  }

  private tryParseCurrentResult(): WSLPersistentShellResult | null {
    const item = this.currentItem;
    if (!item) return null;

    const stderrStartMarker = `__PANE_WSL_STDERR_START_${item.markerId}__`;
    const stderrEndMarker = `__PANE_WSL_STDERR_END_${item.markerId}__`;
    const exitRegex = new RegExp(`__PANE_WSL_EXIT_${escapeRegExp(item.markerId)}_(-?\\d+)__`);
    const exitMatch = exitRegex.exec(this.stdoutBuffer);
    if (!exitMatch) return null;

    const exitCode = Number(exitMatch[1]);
    const stderrStart = this.stdoutBuffer.indexOf(stderrStartMarker);
    const stderrEnd = this.stdoutBuffer.indexOf(stderrEndMarker);

    if (stderrStart === -1 || stderrEnd === -1 || stderrEnd < stderrStart) {
      this.rejectCurrentAndReset(makeShellError('WSL persistent shell protocol markers were incomplete', {
        code: 'WSL_SHELL_PROTOCOL_ERROR',
        stdout: this.stdoutBuffer,
        commandStarted: true,
        phase: 'protocol',
      }), true);
      return null;
    }

    return {
      stdout: this.stdoutBuffer.slice(0, stderrStart),
      stderr: this.stdoutBuffer.slice(stderrStart + stderrStartMarker.length, stderrEnd),
      exitCode,
    };
  }

  private getCurrentStdoutCandidate(): string {
    const item = this.currentItem;
    if (!item) return '';
    const stderrStartMarker = `__PANE_WSL_STDERR_START_${item.markerId}__`;
    const stderrStart = this.stdoutBuffer.indexOf(stderrStartMarker);
    return stderrStart === -1 ? this.stdoutBuffer : this.stdoutBuffer.slice(0, stderrStart);
  }

  private isCommandStderrMarkerActive(): boolean {
    const item = this.currentItem;
    if (!item) return false;
    const stderrStartMarker = `__PANE_WSL_STDERR_START_${item.markerId}__`;
    const stderrEndMarker = `__PANE_WSL_STDERR_END_${item.markerId}__`;
    const stderrStart = this.stdoutBuffer.indexOf(stderrStartMarker);
    const stderrEnd = this.stdoutBuffer.indexOf(stderrEndMarker);
    return stderrStart !== -1 && (stderrEnd === -1 || stderrEnd < stderrStart);
  }

  private resolveCurrentAndContinue(result: WSLPersistentShellResult): void {
    const item = this.currentItem;
    const resolve = this.currentResolve;
    if (!item || !resolve) return;

    this.clearTimer(item);
    this.currentItem = null;
    this.currentResolve = null;
    this.currentReject = null;
    this.clearParserState();
    resolve(result);
    this.processNext();
  }

  private rejectCurrentAndReset(error: WSLPersistentShellError, killProcess: boolean): void {
    const item = this.currentItem;
    const reject = this.currentReject;
    if (item && reject) {
      this.clearTimer(item);
      reject(error);
    } else if (item) {
      this.rejectItem(item, error);
    }
    this.currentItem = null;
    this.currentResolve = null;
    this.currentReject = null;
    this.clearParserState();

    if (killProcess) {
      this.killProcess();
    }

    this.processNext();
  }

  private rejectItem(item: WSLPersistentShellQueueItem, error: WSLPersistentShellError): void {
    this.clearTimer(item);
    item.reject(error);
  }

  private clearTimer(item: WSLPersistentShellQueueItem): void {
    if (item.timer) {
      clearTimeout(item.timer);
      item.timer = null;
    }
  }

  private clearParserState(): void {
    this.stdoutBuffer = '';
    this.shellStderrBuffer = '';
    this.commandStarted = false;
  }

  private killProcess(): void {
    if (this.process) {
      const child = this.process;
      this.process = null;
      child.kill();
    }
  }
}

export class WSLPersistentShellPool {
  private shells = new Map<string, WSLPersistentShell>();

  getShell(distro: string): WSLPersistentShell {
    let shell = this.shells.get(distro);
    if (!shell) {
      shell = new WSLPersistentShell(distro);
      this.shells.set(distro, shell);
    }
    return shell;
  }

  async disposeAll(): Promise<void> {
    const shells = Array.from(this.shells.values());
    this.shells.clear();
    await Promise.all(shells.map((shell) => shell.dispose()));
  }
}

export const wslPersistentShellPool = new WSLPersistentShellPool();

// --- Feature flag check ---

export function isWSLPersistentShellEnabled(): boolean {
  if (process.env.PANE_USE_WSL_PERSISTENT_SHELL === '1') return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRuntimeConfigManager } = require('../core/runtime') as {
      getRuntimeConfigManager: () => { getUseWSLPersistentShell(): boolean };
    };
    return getRuntimeConfigManager().getUseWSLPersistentShell();
  } catch {
    return false;
  }
}
