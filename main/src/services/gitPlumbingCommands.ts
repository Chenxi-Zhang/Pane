import * as fs from 'fs';
import type { CommandRunner } from '../utils/commandRunner';

/**
 * Optimized git commands using plumbing (low-level) commands.
 * All functions are async to avoid blocking the Electron main process.
 */

export interface GitIndexStatus {
  hasModified: boolean;
  hasStaged: boolean;
  hasUntracked: boolean;
  hasConflicts: boolean;
}

/**
 * Fast check if working directory has any changes using git plumbing commands
 * Much faster than running full `git status --porcelain`
 */
export async function fastCheckWorkingDirectory(cwd: string, commandRunner: CommandRunner): Promise<GitIndexStatus> {
  const result: GitIndexStatus = {
    hasModified: false,
    hasStaged: false,
    hasUntracked: false,
    hasConflicts: false
  };

  // Check if the directory exists before attempting git operations
  // This prevents ENOENT errors when worktrees have been deleted (e.g., /tmp cleanup)
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    // Directory doesn't exist - return safe defaults
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return {
      hasModified: true,
      hasStaged: true,
      hasUntracked: true,
      hasConflicts: false
    };
  }

  try {
    // 1. Refresh the index first (very fast, updates git's cache)
    try {
      await commandRunner.execAsync('git update-index --refresh --ignore-submodules', cwd, { silent: true });
    } catch {
      // Some files may have been modified, that's ok
    }

    // 2. Check for unstaged changes (modified files in working directory)
    try {
      await commandRunner.execAsync('git diff-files --quiet --ignore-submodules', cwd, { silent: true });
    } catch {
      result.hasModified = true;
    }

    // 3. Check for staged changes (in index)
    try {
      await commandRunner.execAsync('git diff-index --cached --quiet HEAD --ignore-submodules', cwd, { silent: true });
    } catch {
      result.hasStaged = true;
    }

    // 4. Check for untracked files (more efficient than ls-files for just checking existence)
    const untrackedResult = await commandRunner.execAsync(
      'git ls-files --others --exclude-standard --directory --no-empty-directory',
      cwd
    );
    if (untrackedResult.stdout.trim()) {
      result.hasUntracked = true;
    }

    // 5. Check for merge conflicts
    const conflictResult = await commandRunner.execAsync('git diff --name-only --diff-filter=U', cwd);
    if (conflictResult.stdout.trim()) {
      result.hasConflicts = true;
    }

    return result;
  } catch (error) {
    // If any unexpected error, return safe defaults
    return {
      hasModified: true,
      hasStaged: true,
      hasUntracked: true,
      hasConflicts: false
    };
  }
}

/**
 * Get count of commits ahead/behind using rev-list (faster than rev-parse)
 */
export async function fastGetAheadBehind(cwd: string, baseBranch: string, commandRunner: CommandRunner): Promise<{ ahead: number; behind: number }> {
  // Check if the directory exists before attempting git operations
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return { ahead: 0, behind: 0 };
  }

  try {
    const result = await commandRunner.execAsync(`git rev-list --left-right --count ${baseBranch}...HEAD`, cwd);
    const trimmed = result.stdout.trim();

    const [behind, ahead] = trimmed.split('\t').map(n => parseInt(n, 10));
    return {
      ahead: ahead || 0,
      behind: behind || 0
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

/**
 * Get statistics about changes (additions/deletions) efficiently
 */
export async function fastGetDiffStats(cwd: string, commandRunner: CommandRunner): Promise<{ additions: number; deletions: number; filesChanged: number }> {
  // Check if the directory exists before attempting git operations
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }

  try {
    // Use numstat for machine-readable output (faster to parse)
    const result = await commandRunner.execAsync('git diff --numstat', cwd);
    const trimmed = result.stdout.trim();

    if (!trimmed) {
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }

    const lines = trimmed.split('\n');
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      const [added, deleted] = line.split('\t');
      if (added !== '-') additions += parseInt(added, 10);
      if (deleted !== '-') deletions += parseInt(deleted, 10);
    }

    return {
      additions,
      deletions,
      filesChanged: lines.length
    };
  } catch {
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }
}
