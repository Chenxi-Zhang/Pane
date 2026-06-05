import { execFileSync } from 'child_process';
import { IpcMain, dialog } from 'electron';
import type { AppServices } from './types';

export function registerDialogHandlers(ipcMain: IpcMain, { getMainWindow }: AppServices): void {
  ipcMain.handle('dialog:open-file', async (_event, options?: Electron.OpenDialogOptions) => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { success: false, error: 'No main window available' };
      }

      const defaultOptions: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        ...options
      };

      const result = await dialog.showOpenDialog(mainWindow, defaultOptions);

      if (result.canceled) {
        return { success: true, data: null };
      }

      return { success: true, data: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to open file dialog:', error);
      return { success: false, error: 'Failed to open file dialog' };
    }
  });

  ipcMain.handle('dialog:open-directory', async (_event, options?: Electron.OpenDialogOptions) => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { success: false, error: 'No main window available' };
      }

      const defaultOptions: Electron.OpenDialogOptions = {
        properties: ['openDirectory'],
        ...options
      };

      const result = await dialog.showOpenDialog(mainWindow, defaultOptions);

      if (result.canceled) {
        return { success: true, data: null };
      }

      return { success: true, data: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
      return { success: false, error: 'Failed to open directory dialog' };
    }
  });

  // --- WSL directory browsing (win32 only) ---

  ipcMain.handle('wsl:list-distros', async () => {
    if (process.platform !== 'win32') {
      return { success: true, data: [] as string[] };
    }
    try {
      const output = execFileSync('wsl.exe', ['-l', '-q'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      const distros = output
        .replace(/\0/g, '')
        .split('\n')
        .map(d => d.trim())
        .filter(Boolean);
      return { success: true, data: distros };
    } catch {
      return { success: true, data: [] as string[] };
    }
  });

  ipcMain.handle('wsl:list-directory', async (_event, distro: string, dirPath: string) => {
    if (process.platform !== 'win32' || !distro) {
      return { success: false, error: 'WSL is not available on this platform' };
    }
    try {
      const script = `find ${escapeShellArg(dirPath)} -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort`;

      const output = execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-c', script], {
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
      });

      const entries = output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(fullPath => {
          const name = fullPath.split('/').pop() || fullPath;
          return { name, path: fullPath };
        });

      return { success: true, data: entries };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to list WSL directory: ${msg}` };
    }
  });

  ipcMain.handle('wsl:validate-path', async (_event, distro: string, linuxPath: string) => {
    if (process.platform !== 'win32' || !distro) {
      return { success: false, error: 'WSL is not available on this platform' };
    }
    try {
      execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-c', `test -d ${escapeShellArg(linuxPath)}`], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      return { success: true, data: true };
    } catch {
      return { success: true, data: false };
    }
  });

  ipcMain.handle('wsl:get-home', async (_event, distro: string) => {
    if (process.platform !== 'win32' || !distro) {
      return { success: false, error: 'WSL is not available on this platform' };
    }
    try {
      const output = execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-c', 'echo "$HOME"'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      return { success: true, data: output.trim() };
    } catch {
      return { success: true, data: '/root' };
    }
  });
}

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
} 