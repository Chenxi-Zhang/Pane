import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mock factories ---

const { execFileAsyncMock, execFileSyncMock, poolMock, enabledMock, shellPathMock, wslExecArgsMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  poolMock: { getShell: vi.fn() },
  enabledMock: vi.fn(),
  shellPathMock: vi.fn().mockReturnValue('/usr/bin:/bin'),
  wslExecArgsMock: vi.fn(),
}));

// --- Module mocks ---

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: execFileSyncMock,
  exec: vi.fn(),
  execFile: vi.fn(() => execFileAsyncMock()),
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => execFileAsyncMock),
}));

vi.mock('./shellPath', () => ({
  getShellPath: shellPathMock,
}));

vi.mock('./wslUtils', () => ({
  WSLContext: undefined,
  getWSLExecArgs: wslExecArgsMock,
}));

vi.mock('./wslPersistentShell', () => ({
  wslPersistentShellPool: poolMock,
  isWSLPersistentShellEnabled: enabledMock,
  createExecFileLikeError: vi.fn((command: string, result: { exitCode: number; stdout: string; stderr: string }) => {
    const error = new Error(`Command failed: ${command}\n${result.stderr}`);
    Object.assign(error, {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      cmd: command,
    });
    return error;
  }),
  WSLPersistentShellError: class WSLPersistentShellError extends Error {
    code?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    commandStarted: boolean;
    phase: string;
    constructor(message: string, opts: { commandStarted: boolean; phase: string; code?: string; exitCode?: number; stdout?: string; stderr?: string }) {
      super(message);
      this.name = 'WSLPersistentShellError';
      this.commandStarted = opts.commandStarted;
      this.phase = opts.phase;
      this.code = opts.code;
      this.exitCode = opts.exitCode;
      this.stdout = opts.stdout;
      this.stderr = opts.stderr;
    }
  },
}));

// --- Import SUT after mocks are set up ---

import { execAsync, execSync } from './commandExecutor';
import { WSLPersistentShellError } from './wslPersistentShell';

const WSL_CONTEXT = { enabled: true, distribution: 'Ubuntu', linuxPath: '/home/user' };

// --- Tests ---

describe('commandExecutor WSL persistent shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolMock.getShell.mockReturnValue({ exec: vi.fn() });
    wslExecArgsMock.mockReturnValue({ file: 'wsl.exe', args: ['-d', 'Ubuntu', '--', 'bash', '-c', 'echo hi'] });
    shellPathMock.mockReturnValue('/usr/bin:/bin');
  });

  it('flag-off async WSL calls nodeExecFileAsync', async () => {
    enabledMock.mockReturnValue(false);
    execFileAsyncMock.mockResolvedValue({ stdout: 'hello', stderr: '' });

    const result = await execAsync('echo hello', { silent: true }, WSL_CONTEXT);

    expect(result).toEqual({ stdout: 'hello', stderr: '' });
    expect(wslExecArgsMock).toHaveBeenCalledWith('echo hello', 'Ubuntu', expect.any(String), undefined);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-c', 'echo hi'],
      expect.objectContaining({ timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }),
    );
    expect(poolMock.getShell).not.toHaveBeenCalled();
  });

  it('flag-on async WSL calls persistent shell exec with correct params', async () => {
    enabledMock.mockReturnValue(true);
    const execMock = vi.fn().mockResolvedValue({ stdout: 'world', stderr: '', exitCode: 0 });
    poolMock.getShell.mockReturnValue({ exec: execMock });

    const result = await execAsync('echo world', {
      silent: true,
      cwd: '/home/user/project',
      env: { MY_VAR: 'val' },
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    }, WSL_CONTEXT);

    expect(result).toEqual({ stdout: 'world', stderr: '' });
    expect(poolMock.getShell).toHaveBeenCalledWith('Ubuntu');
    expect(execMock).toHaveBeenCalledWith('echo world', {
      cwd: '/home/user/project',
      env: { MY_VAR: 'val' },
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
      silent: true,
    });
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('sync WSL always uses execFileSync, never persistent shell', () => {
    enabledMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue('sync-result');

    const result = execSync('echo sync', { silent: true, encoding: 'utf-8' }, WSL_CONTEXT);

    expect(result).toBe('sync-result');
    expect(execFileSyncMock).toHaveBeenCalled();
    expect(poolMock.getShell).not.toHaveBeenCalled();
  });

  it('falls back to execFile on pre-start persistent shell failure', async () => {
    enabledMock.mockReturnValue(true);
    const execMock = vi.fn().mockRejectedValue(new WSLPersistentShellError('spawn failed', {
      commandStarted: false,
      phase: 'spawn',
    }));
    poolMock.getShell.mockReturnValue({ exec: execMock });
    execFileAsyncMock.mockResolvedValue({ stdout: 'fallback', stderr: '' });

    const result = await execAsync('echo fallback', { silent: true }, WSL_CONTEXT);

    expect(result).toEqual({ stdout: 'fallback', stderr: '' });
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on post-start persistent shell failure', async () => {
    enabledMock.mockReturnValue(true);
    const execMock = vi.fn().mockRejectedValue(new WSLPersistentShellError('protocol error', {
      commandStarted: true,
      phase: 'protocol',
    }));
    poolMock.getShell.mockReturnValue({ exec: execMock });

    await expect(execAsync('echo fail', { silent: true }, WSL_CONTEXT))
      .rejects.toThrow('protocol error');

    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('non-zero persistent exit throws error with stdout/stderr', async () => {
    enabledMock.mockReturnValue(true);
    const execMock = vi.fn().mockResolvedValue({
      stdout: 'partial output',
      stderr: 'some error',
      exitCode: 1,
    });
    poolMock.getShell.mockReturnValue({ exec: execMock });

    await expect(execAsync('bad-cmd', { silent: true }, WSL_CONTEXT))
      .rejects.toThrow('Command failed: bad-cmd');

    try {
      await execAsync('bad-cmd', { silent: true }, WSL_CONTEXT);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      const err = error as Error & { code: number; stdout: string; stderr: string; cmd: string };
      expect(err.code).toBe(1);
      expect(err.stdout).toBe('partial output');
      expect(err.stderr).toBe('some error');
      expect(err.cmd).toBe('bad-cmd');
    }

    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('flag-off sync WSL produces same result as before', () => {
    enabledMock.mockReturnValue(false);
    execFileSyncMock.mockReturnValue(Buffer.from('sync-output'));

    const result = execSync('echo sync', { silent: true }, WSL_CONTEXT);

    expect(result.toString()).toBe('sync-output');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(poolMock.getShell).not.toHaveBeenCalled();
  });
});
