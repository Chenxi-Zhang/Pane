import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWSLPersistentShellCommand,
  createExecFileLikeError,
  isWSLPersistentShellEnabled,
  WSLPersistentShell,
  WSLPersistentShellError,
  WSLPersistentShellPool,
} from './wslPersistentShell';

const { spawnMock, mockProcess } = vi.hoisted(() => {
  type DataCallback = (data: Buffer) => void;
  type ErrorCallback = (error: Error) => void;
  type VoidCallback = () => void;

  interface MockStream {
    on: ReturnType<typeof vi.fn>;
    emitData: (data: string) => void;
  }

  interface MockChildProcess {
    stdout: MockStream;
    stderr: MockStream;
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
    };
    on: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    emitExit: () => void;
    emitError: (error: Error) => void;
  }

  const processes: MockChildProcess[] = [];

  const createStream = (): MockStream => {
    const dataCallbacks: DataCallback[] = [];
    return {
      on: vi.fn((event: string, callback: DataCallback) => {
        if (event === 'data') dataCallbacks.push(callback);
        return undefined;
      }),
      emitData: (data: string) => {
        for (const callback of dataCallbacks) callback(Buffer.from(data));
      },
    };
  };

  const createProcess = (): MockChildProcess => {
    const exitCallbacks: VoidCallback[] = [];
    const errorCallbacks: ErrorCallback[] = [];
    const process = {
      stdout: createStream(),
      stderr: createStream(),
      stdin: {
        writable: true,
        write: vi.fn(),
      },
      on: vi.fn((event: string, callback: VoidCallback | ErrorCallback) => {
        if (event === 'exit') exitCallbacks.push(callback as VoidCallback);
        if (event === 'error') errorCallbacks.push(callback as ErrorCallback);
        return undefined;
      }),
      kill: vi.fn(),
      emitExit: () => {
        for (const callback of exitCallbacks) callback();
      },
      emitError: (error: Error) => {
        for (const callback of errorCallbacks) callback(error);
      },
    };
    processes.push(process);
    return process;
  };

  return {
    spawnMock: vi.fn(() => createProcess()),
    mockProcess: {
      all: () => processes,
      latest: () => processes[processes.length - 1],
      reset: () => {
        processes.splice(0);
      },
    },
  };
});

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: spawnMock,
}));

function markerIdFor(processIndex: number): string {
  const process = mockProcess.all()[processIndex];
  const writeCall = process.stdin.write.mock.calls.at(-1)?.[0];
  const script = typeof writeCall === 'string' ? writeCall : String(writeCall);
  const match = /__PANE_WSL_STDERR_START_(.*?)__/.exec(script);
  if (!match) throw new Error('Missing stderr start marker in written script');
  return match[1];
}

function emitCommandResult(processIndex: number, stdout: string, stderr: string, exitCode = 0): void {
  const markerId = markerIdFor(processIndex);
  mockProcess.all()[processIndex].stdout.emitData(
    `${stdout}__PANE_WSL_STDERR_START_${markerId}__${stderr}__PANE_WSL_STDERR_END_${markerId}__\n__PANE_WSL_EXIT_${markerId}_${exitCode}__\n`,
  );
}

describe('wslPersistentShell', () => {
  const prevEnv = process.env.PANE_USE_WSL_PERSISTENT_SHELL;

  beforeEach(() => {
    delete process.env.PANE_USE_WSL_PERSISTENT_SHELL;
    vi.useRealTimers();
    spawnMock.mockClear();
    mockProcess.reset();
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.PANE_USE_WSL_PERSISTENT_SHELL;
    } else {
      process.env.PANE_USE_WSL_PERSISTENT_SHELL = prevEnv;
    }
    vi.useRealTimers();
  });

  describe('buildWSLPersistentShellCommand', () => {
    it('produces correct script with cwd, env, and markers', () => {
      const { script, markerId } = buildWSLPersistentShellCommand('echo hello', {
        cwd: '/home/user/project',
        env: { FOO: 'bar', BAZ: 'qux' },
      });

      expect(markerId).toBeTruthy();
      expect(script).toContain(`/home/user/project`);
      expect(script).toContain(`export FOO='bar'`);
      expect(script).toContain(`export BAZ='qux'`);
      expect(script).toContain(`__PANE_WSL_STDERR_START_${markerId}__`);
      expect(script).toContain(`__PANE_WSL_STDERR_END_${markerId}__`);
      expect(script).toContain(`__PANE_WSL_EXIT_${markerId}_`);
    });

    it('escapes env values using escapeForBash', () => {
      const { script } = buildWSLPersistentShellCommand('true', {
        env: { KEY: "it's a test" },
      });

      // escapeForBash produces: 'it'\''s a test'
      expect(script).toContain(`export KEY='it'\\''s a test'`);
    });

    it('rejects invalid env names with WSLPersistentShellError', () => {
      expect(() =>
        buildWSLPersistentShellCommand('true', {
          env: { 'BAD-NAME': 'value' },
        }),
      ).toThrow(WSLPersistentShellError);

      try {
        buildWSLPersistentShellCommand('true', {
          env: { 'BAD-NAME': 'value' },
        });
      } catch (e) {
        const err = e as WSLPersistentShellError;
        expect(err.commandStarted).toBe(false);
        expect(err.phase).toBe('validate');
        expect(err.message).toContain('BAD-NAME');
      }
    });

    it('produces unique marker IDs on each call', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const { markerId } = buildWSLPersistentShellCommand('true', {});
        ids.add(markerId);
      }
      expect(ids.size).toBe(50);
    });

    it('uses separate marker strings for stderr vs exit', () => {
      const { script, markerId } = buildWSLPersistentShellCommand('true', {});

      const stderrStart = `__PANE_WSL_STDERR_START_${markerId}__`;
      const stderrEnd = `__PANE_WSL_STDERR_END_${markerId}__`;
      const exitPrefix = `__PANE_WSL_EXIT_${markerId}_`;

      expect(script).toContain(stderrStart);
      expect(script).toContain(stderrEnd);
      expect(script).toContain(exitPrefix);
      expect(stderrStart).not.toBe(exitPrefix);
      expect(stderrEnd).not.toBe(exitPrefix);
      expect(stderrStart).not.toBe(stderrEnd);
    });

    it('embeds custom maxBuffer value in monitor logic', () => {
      const { script } = buildWSLPersistentShellCommand('true', {
        maxBuffer: 1024,
      });

      expect(script).toContain('-gt 1024');
      expect(script).toContain('head -c 1024');
    });

    it('redirects stdin with </dev/null on the command subshell', () => {
      const { script } = buildWSLPersistentShellCommand('cat', {});
      expect(script).toContain('</dev/null');
    });

    it('wraps user command in bash --noprofile --norc -c', () => {
      const userCommand = 'echo "test command"';
      const { script } = buildWSLPersistentShellCommand(userCommand, {});

      // escapeForBash wraps in single quotes: 'echo "test command"'
      expect(script).toContain(`bash --noprofile --norc -c 'echo "test command"'`);
    });

    it('fail-closes: cd failure exits before user command runs', () => {
      const { script } = buildWSLPersistentShellCommand('whoami', {
        cwd: '/nonexistent/path',
      });

      // The cd segment must use `|| exit $?` so a failed cd aborts before the command
      expect(script).toContain(`cd '/nonexistent/path' || exit $?`);
      expect(script).toContain('bash --noprofile --norc -c');
    });

    it('omits cd segment when cwd is not provided', () => {
      const { script } = buildWSLPersistentShellCommand('echo hi', {});
      expect(script).not.toMatch(/^cd /m);
      expect(script).not.toContain('|| exit $?');
    });

    it('uses mktemp for stderr temp file', () => {
      const { script } = buildWSLPersistentShellCommand('true', {});
      expect(script).toContain('mktemp /tmp/pane-wsl-stderr.XXXXXX');
    });

    it('always cleans up temp files with rm -f', () => {
      const { script } = buildWSLPersistentShellCommand('true', {});
      expect(script).toContain('rm -f');
    });

    it('uses stat -c%s for stderr size monitoring', () => {
      const { script } = buildWSLPersistentShellCommand('true', {});
      expect(script).toContain('stat -c%s');
    });

    it('respects provided markerId instead of generating one', () => {
      const { markerId } = buildWSLPersistentShellCommand('true', {
        markerId: 'custom-id-123',
      });
      expect(markerId).toBe('custom-id-123');
    });

    it('does not export a Windows shell PATH when no PATH env is provided', () => {
      const { script } = buildWSLPersistentShellCommand('true', {
        env: { FOO: 'bar' },
      });

      expect(script).not.toContain('getShellPath');
      expect(script).not.toMatch(/^\s*export PATH=/m);
    });

    it('exports a caller-provided PATH as a normal bash env var', () => {
      const { script } = buildWSLPersistentShellCommand('true', {
        env: { PATH: '/custom/bin:/usr/bin' },
      });

      expect(script).toContain(`export PATH='/custom/bin:/usr/bin'`);
    });
  });

  describe('isWSLPersistentShellEnabled', () => {
    it('returns false by default when no env or config is set', () => {
      delete process.env.PANE_USE_WSL_PERSISTENT_SHELL;
      expect(isWSLPersistentShellEnabled()).toBe(false);
    });

    it('returns true when PANE_USE_WSL_PERSISTENT_SHELL=1', () => {
      process.env.PANE_USE_WSL_PERSISTENT_SHELL = '1';
      expect(isWSLPersistentShellEnabled()).toBe(true);
    });

    it('returns false when PANE_USE_WSL_PERSISTENT_SHELL is not "1"', () => {
      process.env.PANE_USE_WSL_PERSISTENT_SHELL = '0';
      expect(isWSLPersistentShellEnabled()).toBe(false);

      process.env.PANE_USE_WSL_PERSISTENT_SHELL = 'true';
      expect(isWSLPersistentShellEnabled()).toBe(false);
    });
  });

  describe('WSLPersistentShell', () => {
    it('queues concurrent exec calls and resolves them in FIFO order', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resolutionOrder: number[] = [];

      const first = shell.exec('echo first').then((result) => {
        resolutionOrder.push(1);
        return result;
      });
      const second = shell.exec('echo second').then((result) => {
        resolutionOrder.push(2);
        return result;
      });
      const third = shell.exec('echo third').then((result) => {
        resolutionOrder.push(3);
        return result;
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(mockProcess.latest().stdin.write).toHaveBeenCalledTimes(1);

      emitCommandResult(0, 'first\n', '', 0);
      await expect(first).resolves.toMatchObject({ stdout: 'first\n', stderr: '', exitCode: 0 });
      expect(mockProcess.latest().stdin.write).toHaveBeenCalledTimes(2);

      emitCommandResult(0, 'second\n', '', 0);
      await expect(second).resolves.toMatchObject({ stdout: 'second\n', stderr: '', exitCode: 0 });
      expect(mockProcess.latest().stdin.write).toHaveBeenCalledTimes(3);

      emitCommandResult(0, 'third\n', '', 0);
      await expect(third).resolves.toMatchObject({ stdout: 'third\n', stderr: '', exitCode: 0 });
      expect(resolutionOrder).toEqual([1, 2, 3]);
    });

    it('parses stdout markers split across multiple chunks', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('echo chunked');
      const markerId = markerIdFor(0);

      mockProcess.latest().stdout.emitData('stdout before\n__PANE_WSL_STD');
      mockProcess.latest().stdout.emitData(`ERR_START_${markerId}__err`);
      mockProcess.latest().stdout.emitData(` text__PANE_WSL_STDERR_END_${markerId}__\n__PANE_WSL_EXIT_${markerId}_7__\n`);

      await expect(resultPromise).resolves.toEqual({
        stdout: 'stdout before\n',
        stderr: 'err text',
        exitCode: 7,
      });
    });

    it('returns command stdout and marker-captured stderr separately', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('mixed output');

      emitCommandResult(0, 'only stdout\n', 'only stderr\n', 2);

      await expect(resultPromise).resolves.toEqual({
        stdout: 'only stdout\n',
        stderr: 'only stderr\n',
        exitCode: 2,
      });
    });

    it('separates stdout and stderr for normal mixed output', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('mixed streams');

      emitCommandResult(0, 'stdout line 1\nstdout line 2\n', 'stderr line 1\nstderr line 2\n', 0);

      await expect(resultPromise).resolves.toEqual({
        stdout: 'stdout line 1\nstdout line 2\n',
        stderr: 'stderr line 1\nstderr line 2\n',
        exitCode: 0,
      });
    });

    it('keeps stderr-only output in stderr on exit zero', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('stderr only');

      emitCommandResult(0, '', 'warning only\n', 0);

      await expect(resultPromise).resolves.toEqual({
        stdout: '',
        stderr: 'warning only\n',
        exitCode: 0,
      });
    });

    it('keeps stderr-like text emitted before stderr markers in stdout', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('stderr text in stdout');

      emitCommandResult(0, 'stderr: this is normal stdout\n', 'real stderr\n', 0);

      await expect(resultPromise).resolves.toEqual({
        stdout: 'stderr: this is normal stdout\n',
        stderr: 'real stderr\n',
        exitCode: 0,
      });
    });

    it('keeps stdout-like text emitted between stderr markers in stderr', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('stdout text in stderr');

      emitCommandResult(0, 'real stdout\n', 'stdout: this is real stderr\n', 0);

      await expect(resultPromise).resolves.toEqual({
        stdout: 'real stdout\n',
        stderr: 'stdout: this is real stderr\n',
        exitCode: 0,
      });
    });

    it('ignores generic exit marker text with a different marker ID in command output', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('marker-like output');

      emitCommandResult(0, 'before __PANE_WSL_EXIT_other-marker_99__ after\n', '', 0);

      await expect(resultPromise).resolves.toEqual({
        stdout: 'before __PANE_WSL_EXIT_other-marker_99__ after\n',
        stderr: '',
        exitCode: 0,
      });
    });

    it('resolves non-zero exits without throwing', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('exit 42');

      emitCommandResult(0, '', 'failure details\n', 42);

      await expect(resultPromise).resolves.toEqual({
        stdout: '',
        stderr: 'failure details\n',
        exitCode: 42,
      });
    });

    it('rejects with ETIMEDOUT and kills the process on timeout', async () => {
      vi.useFakeTimers();
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('sleep forever', { timeout: 25 });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        commandStarted: true,
        phase: 'running',
      });

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(mockProcess.all()[0].kill).toHaveBeenCalledTimes(1);
    });

    it('rejects the running command when the shell exits', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('echo dies');
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: 'WSL_SHELL_DIED',
        commandStarted: true,
        phase: 'running',
      });

      mockProcess.latest().emitExit();

      await rejection;
    });

    it('lazy-respawns a new process after shell exit', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const first = shell.exec('first dies');
      const firstRejection = expect(first).rejects.toMatchObject({ code: 'WSL_SHELL_DIED' });

      mockProcess.latest().emitExit();
      await firstRejection;

      const second = shell.exec('second lives');
      expect(spawnMock).toHaveBeenCalledTimes(2);
      emitCommandResult(1, 'respawned\n', '', 0);

      await expect(second).resolves.toMatchObject({ stdout: 'respawned\n', exitCode: 0 });
    });

    it('rejects with maxBuffer error when wrapper reports stderr truncation', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('too much stderr');
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        commandStarted: true,
        phase: 'running',
        stdout: '',
        stderr: 'large stderr',
      });

      emitCommandResult(0, '', `large stderr\n__PANE_WSL_STDERR_TRUNCATED__\n`, 143);

      await rejection;
      expect(mockProcess.all()[0].kill).toHaveBeenCalledTimes(1);
    });

    it('rejects when stderr exceeds custom maxBuffer even with empty stdout', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const resultPromise = shell.exec('stderr flood', { maxBuffer: 1024 });
      const truncatedStderr = `${'x'.repeat(1024)}\n__PANE_WSL_STDERR_TRUNCATED__\n`;

      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        commandStarted: true,
        phase: 'running',
        stdout: '',
        stderr: 'x'.repeat(1024),
      });

      emitCommandResult(0, '', truncatedStderr, 143);

      await rejection;
      expect(mockProcess.all()[0].kill).toHaveBeenCalledTimes(1);
    });

    it('rejects queued commands when disposed', async () => {
      const shell = new WSLPersistentShell('Ubuntu');
      const first = shell.exec('first');
      const second = shell.exec('second');
      const third = shell.exec('third');
      const firstRejection = expect(first).rejects.toMatchObject({ code: 'WSL_SHELL_DISPOSED', phase: 'dispose' });
      const secondRejection = expect(second).rejects.toMatchObject({
        code: 'WSL_SHELL_DISPOSED',
        commandStarted: false,
        phase: 'dispose',
      });
      const thirdRejection = expect(third).rejects.toMatchObject({
        code: 'WSL_SHELL_DISPOSED',
        commandStarted: false,
        phase: 'dispose',
      });

      await shell.dispose();

      await firstRejection;
      await secondRejection;
      await thirdRejection;
      expect(mockProcess.all()[0].kill).toHaveBeenCalledTimes(1);
    });
  });

  describe('WSLPersistentShellPool', () => {
    it('returns the same shell for a distro and different shells for different distros', () => {
      const pool = new WSLPersistentShellPool();
      expect(pool.getShell('Ubuntu')).toBe(pool.getShell('Ubuntu'));
      expect(pool.getShell('Ubuntu')).not.toBe(pool.getShell('Debian'));
    });
  });

  describe('WSLPersistentShellError', () => {
    it('captures all error fields correctly', () => {
      const err = new WSLPersistentShellError('test error', {
        code: 'ETIMEDOUT',
        exitCode: 124,
        stdout: 'output',
        stderr: 'error output',
        commandStarted: true,
        phase: 'running',
      });

      expect(err.message).toBe('test error');
      expect(err.name).toBe('WSLPersistentShellError');
      expect(err.code).toBe('ETIMEDOUT');
      expect(err.exitCode).toBe(124);
      expect(err.stdout).toBe('output');
      expect(err.stderr).toBe('error output');
      expect(err.commandStarted).toBe(true);
      expect(err.phase).toBe('running');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('createExecFileLikeError', () => {
    it('creates an execFile-shaped error with non-zero result fields', () => {
      const result = {
        stdout: 'output\n',
        stderr: 'fatal\n',
        exitCode: 17,
      };

      const error = createExecFileLikeError('false', result);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Command failed: false\nfatal\n');
      expect(error.code).toBe(17);
      expect(error.stdout).toBe('output\n');
      expect(error.stderr).toBe('fatal\n');
      expect(error.cmd).toBe('false');
    });
  });
});
