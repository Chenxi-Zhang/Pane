import { execSync as nodeExecSync, execFileSync as nodeExecFileSync, ExecSyncOptions, ExecSyncOptionsWithStringEncoding, ExecSyncOptionsWithBufferEncoding, exec, execFile, ExecOptions, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { getShellPath } from './shellPath';
import { WSLContext, getWSLExecArgs } from './wslUtils';
import { wslPersistentShellPool, isWSLPersistentShellEnabled, createExecFileLikeError, WSLPersistentShellError } from './wslPersistentShell';

const nodeExecAsync = promisify(exec);
const nodeExecFileAsync = promisify(execFile);

/**
 * Compute env vars that differ from the current process.env.
 * These need to be forwarded explicitly into WSL bash sessions
 * since wsl.exe does not automatically pass Windows env vars through.
 */
function getExtraEnvVars(mergedEnv?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!mergedEnv) return undefined;
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (key === 'PATH' || value === undefined) continue;
    if (process.env[key] !== value) {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Extended ExecSyncOptions that includes a custom 'silent' flag
 * to suppress command execution logging
 */
export interface ExtendedExecSyncOptions extends ExecSyncOptions {
  silent?: boolean;
}

export interface ExtendedExecAsyncOptions extends ExecOptions {
  timeout?: number;
  silent?: boolean;
}

class CommandExecutor {
  execSync(command: string, options: ExecSyncOptionsWithStringEncoding & { silent?: boolean }, wslContext?: WSLContext | null): string;
  execSync(command: string, options?: ExecSyncOptionsWithBufferEncoding & { silent?: boolean }, wslContext?: WSLContext | null): Buffer;
  execSync(command: string, options?: ExtendedExecSyncOptions, wslContext?: WSLContext | null): string | Buffer {
    // Log the command being executed (unless silent mode requested)
    const cwd = options?.cwd || process.cwd();

    const extendedOptions = options as ExtendedExecSyncOptions;
    const silentMode = extendedOptions?.silent === true;

    // Get enhanced shell PATH
    const shellPath = getShellPath();

    if (wslContext) {
      // sync WSL intentionally uses execFileSync; persistent shell is async-only
      // Invoke wsl.exe directly via execFileSync — bypasses cmd.exe entirely,
      // avoiding all cmd.exe escaping issues (%, ^, &, etc.)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cwd: _cwd, silent: _silent, ...cleanOptions } = extendedOptions || {};
      const wslCwd = typeof cwd === 'string' ? cwd : undefined;
      const extraEnv = getExtraEnvVars(cleanOptions?.env as Record<string, string | undefined>);
      const { file, args } = getWSLExecArgs(command, wslContext.distribution, wslCwd, extraEnv);

      if (!silentMode) {
        console.log(`[CommandExecutor] Executing (WSL): ${file} ${args.join(' ')} in ${cwd}`);
      }

      const wslOptions = {
        ...cleanOptions,
        maxBuffer: cleanOptions?.maxBuffer || 10 * 1024 * 1024,
        encoding: (cleanOptions?.encoding || 'utf-8') as BufferEncoding,
        env: { ...process.env, ...cleanOptions?.env, PATH: shellPath },
      };

      try {
        const result = nodeExecFileSync(file, args, wslOptions);

        if (result && !silentMode) {
          const resultStr = result.toString();
          const lines = resultStr.split('\n');
          const preview = lines[0].substring(0, 100) +
                          (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
          console.log(`[CommandExecutor] Success: ${preview}`);
        }

        return result;
      } catch (error: unknown) {
        if (!silentMode) {
          console.error(`[CommandExecutor] Failed (WSL): ${command}`);
          console.error(`[CommandExecutor] Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    }

    if (!silentMode) {
      console.log(`[CommandExecutor] Executing: ${command} in ${cwd}`);
    }

    // Merge enhanced PATH into options (but remove our custom silent flag)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { silent: _silent, ...cleanOptions } = extendedOptions || {};
    const enhancedOptions = {
      ...cleanOptions,
      maxBuffer: cleanOptions?.maxBuffer || 10 * 1024 * 1024,
      env: {
        ...process.env,
        ...cleanOptions?.env,
        PATH: shellPath
      }
    };

    try {
      const result = nodeExecSync(command, enhancedOptions as ExecSyncOptions);

      // Log success with a preview of the result (unless silent mode)
      if (result && !silentMode) {
        const resultStr = result.toString();
        const lines = resultStr.split('\n');
        const preview = lines[0].substring(0, 100) +
                        (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
        console.log(`[CommandExecutor] Success: ${preview}`);
      }

      return result;
    } catch (error: unknown) {
      // Log error (unless silent mode)
      if (!silentMode) {
        console.error(`[CommandExecutor] Failed: ${command}`);
        console.error(`[CommandExecutor] Error: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw error;
    }
  }

  async execAsync(command: string, options?: ExtendedExecAsyncOptions, wslContext?: WSLContext | null): Promise<{ stdout: string; stderr: string }> {
    const cwd = options?.cwd || process.cwd();
    const shellPath = getShellPath();
    const silentMode = options?.silent === true;

    if (wslContext) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cwd: _cwd, silent: _silent, ...cleanOptions } = options || {};
      const wslCwd = typeof cwd === 'string' ? cwd : undefined;
      const extraEnv = getExtraEnvVars(cleanOptions?.env as Record<string, string | undefined>);
      const timeout = cleanOptions?.timeout || 60_000;
      const maxBuffer = cleanOptions?.maxBuffer || 10 * 1024 * 1024;

      // Try persistent shell path first if enabled
      if (isWSLPersistentShellEnabled()) {
        if (!silentMode) {
          console.log(`[CommandExecutor] Executing async (WSL persistent): ${command} in ${cwd}`);
        }

        try {
          const result = await wslPersistentShellPool
            .getShell(wslContext.distribution)
            .exec(command, { cwd: wslCwd, env: extraEnv, timeout, maxBuffer, silent: silentMode });

          if (result.exitCode === 0) {
            if (result.stdout && !silentMode) {
              const lines = result.stdout.split('\n');
              const preview = lines[0].substring(0, 100) +
                              (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
              console.log(`[CommandExecutor] Async Success: ${preview}`);
            }
            return { stdout: result.stdout, stderr: result.stderr };
          }

          // Non-zero exit: throw execFile-like error
          throw createExecFileLikeError(command, result);
        } catch (error: unknown) {
          // Fallback: if persistent shell failed BEFORE command was written, use execFile
          if (error instanceof WSLPersistentShellError && !error.commandStarted) {
            if (!silentMode) {
              console.warn('[CommandExecutor] Persistent shell failed before command start, falling back to execFile');
            }
            // Fall through to execFile path below
          } else {
            // Post-start failure or non-WSLPersistentShellError: don't retry
            if (!silentMode) {
              console.error(`[CommandExecutor] Async Failed (WSL persistent): ${command}`);
              console.error(`[CommandExecutor] Async Error: ${error instanceof Error ? error.message : String(error)}`);
            }
            throw error;
          }
        }
      }

      // Existing execFile path (fallback or flag-off)
      const { file, args } = getWSLExecArgs(command, wslContext.distribution, wslCwd, extraEnv);
      if (!silentMode) {
        console.log(`[CommandExecutor] Executing async (WSL): ${file} ${args.join(' ')} in ${cwd}`);
      }
      const wslOptions: ExecFileOptions = {
        ...cleanOptions,
        timeout,
        maxBuffer,
        env: { ...process.env, ...cleanOptions?.env, PATH: shellPath },
      };

      try {
        const result = await nodeExecFileAsync(file, args, wslOptions);

        if (result.stdout && !silentMode) {
          const stdout = String(result.stdout);
          const lines = stdout.split('\n');
          const preview = lines[0].substring(0, 100) +
                          (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
          console.log(`[CommandExecutor] Async Success: ${preview}`);
        }

        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      } catch (error: unknown) {
        if (!silentMode) {
          console.error(`[CommandExecutor] Async Failed (WSL): ${command}`);
          console.error(`[CommandExecutor] Async Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    }

    if (!silentMode) {
      console.log(`[CommandExecutor] Executing async: ${command} in ${cwd}`);
    }

    const timeout = options?.timeout || 60_000;
    const maxBuffer = options?.maxBuffer || 10 * 1024 * 1024;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { silent: _silent, ...cleanOptions } = options || {};

    const enhancedOptions: ExecOptions = {
      ...cleanOptions,
      timeout,
      maxBuffer,
      env: {
        ...process.env,
        ...cleanOptions?.env,
        PATH: shellPath
      }
    };

    try {
      const result = await nodeExecAsync(command, enhancedOptions);

      if (result.stdout && !silentMode) {
        const stdout = String(result.stdout);
        const lines = stdout.split('\n');
        const preview = lines[0].substring(0, 100) +
                        (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
        console.log(`[CommandExecutor] Async Success: ${preview}`);
      }

      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error: unknown) {
      if (!silentMode) {
        console.error(`[CommandExecutor] Async Failed: ${command}`);
        console.error(`[CommandExecutor] Async Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }
}

// Export a singleton instance
export const commandExecutor = new CommandExecutor();

// Export the execSync function as a drop-in replacement
export const execSync = commandExecutor.execSync.bind(commandExecutor);

// Export the execAsync function
export const execAsync = commandExecutor.execAsync.bind(commandExecutor);
