import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_MAX_SCAN_DIRECTORIES = 100_000;
const ALWAYS_READ_ONLY_GIT_DIRECTORIES = [
  ['hooks'],
  ['objects', 'info'],
  ['modules']
];
const ALWAYS_READ_ONLY_GIT_FILES = ['config', 'config.worktree', 'commondir', 'gitdir'];

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function insideAny(roots, candidate) {
  return roots.some((root) => within(root, candidate));
}

async function canonicalExistingDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  const actual = await realpath(path);
  return (await stat(actual)).isDirectory() ? actual : null;
}

async function resolveGitPointer(dotGitFile, allowedRoots) {
  const info = await lstat(dotGitFile);
  if (info.isSymbolicLink() || !info.isFile()) return null;
  const text = await readFile(dotGitFile, 'utf8');
  const match = /^\s*gitdir\s*:\s*(.+?)\s*$/i.exec(text);
  if (!match) return null;
  const raw = match[1];
  if (!raw || /[\0\r\n]/.test(raw)) return null;
  const lexical = resolve(dirname(dotGitFile), raw);
  let actual;
  try {
    actual = await canonicalExistingDirectory(lexical);
  } catch {
    return null;
  }
  if (!actual || !insideAny(allowedRoots, actual)) return null;
  return actual;
}

async function policyForGitDirectory(gitDirectory) {
  const deniedDirectories = ALWAYS_READ_ONLY_GIT_DIRECTORIES.map((parts) => join(gitDirectory, ...parts));
  const deniedFiles = [];
  for (const name of ALWAYS_READ_ONLY_GIT_FILES) {
    const candidate = join(gitDirectory, name);
    try {
      const info = await lstat(candidate);
      if (!info.isSymbolicLink() && info.isFile()) deniedFiles.push(await realpath(candidate));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { deniedDirectories, deniedFiles };
}

/**
 * Discover existing Git metadata below writable workspace roots without invoking Git.
 *
 * Codex's filesystem policy intentionally protects `.git` below a writable project root.
 * Its current permission implementation (`is_metadata_write_denied` /
 * `has_explicit_write_entry_for_metadata_path`) permits metadata mutation only when a more
 * specific explicit write entry exists inside that protected metadata root. The Gateway
 * therefore discovers already-existing metadata once, before the child sandbox starts, and
 * adds only those concrete paths to the Codex permission profile.
 *
 * This deliberately does not support `git init` or a clone that creates a new `.git` after
 * sandbox startup. Restarting the child/Gateway after creation performs a fresh scan.
 */
export async function scanGitMetadataPolicy(writableRoots, {
  maxScanDirectories = DEFAULT_MAX_SCAN_DIRECTORIES
} = {}) {
  if (!Array.isArray(writableRoots) || writableRoots.some((root) => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('Git metadata scanner requires absolute writable roots');
  }
  if (!Number.isSafeInteger(maxScanDirectories) || maxScanDirectories < 1) {
    throw new Error('maxScanDirectories must be a positive safe integer');
  }

  const roots = [];
  for (const root of writableRoots) {
    try {
      const actual = await canonicalExistingDirectory(root);
      if (actual && !roots.includes(actual)) roots.push(actual);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const queue = [...roots];
  const visited = new Set();
  const gitDirectories = new Set();
  let scannedDirectories = 0;
  let truncated = false;
  let skippedGitPointers = 0;

  while (queue.length > 0) {
    if (scannedDirectories >= maxScanDirectories) {
      truncated = true;
      break;
    }
    const directory = queue.shift();
    if (visited.has(directory)) continue;
    visited.add(directory);
    scannedDirectories += 1;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOENT'].includes(error?.code)) continue;
      throw error;
    }

    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.name === '.git') {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          try {
            const actual = await canonicalExistingDirectory(candidate);
            if (actual && insideAny(roots, actual)) gitDirectories.add(actual);
          } catch (error) {
            if (!['EACCES', 'EPERM', 'ENOENT'].includes(error?.code)) throw error;
          }
        } else if (entry.isFile() && !entry.isSymbolicLink()) {
          const target = await resolveGitPointer(candidate, roots);
          if (target) gitDirectories.add(target);
          else skippedGitPointers += 1;
        } else {
          skippedGitPointers += 1;
        }
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      queue.push(candidate);
    }
  }

  const deniedDirectories = new Set();
  const deniedFiles = new Set();
  for (const gitDirectory of gitDirectories) {
    const policy = await policyForGitDirectory(gitDirectory);
    for (const path of policy.deniedDirectories) deniedDirectories.add(path);
    for (const path of policy.deniedFiles) deniedFiles.add(path);
  }

  return {
    writableDirectories: [...gitDirectories],
    deniedDirectories: [...deniedDirectories],
    deniedFiles: [...deniedFiles],
    scannedDirectories,
    truncated,
    skippedGitPointers
  };
}

export const gitMetadataPolicyInternals = {
  ALWAYS_READ_ONLY_GIT_DIRECTORIES,
  ALWAYS_READ_ONLY_GIT_FILES,
  within
};
