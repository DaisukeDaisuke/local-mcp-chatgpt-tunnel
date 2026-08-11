import { lstat, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { disallowedPathGlobError, findDisallowedPathGlob, normalizeDisallowedPathGlobs } from './path-glob.mjs';

const PATH_KEY_PATTERN = /(?:^|_)(?:path|paths|file|files|filename|filenames|directory|directories|dir|dirs|folder|folders|cwd)(?:$|_)/;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_ABSOLUTE_PATTERN = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i;

function platformStyle(platform) {
  return platform === 'win32' ? 'windows' : 'posix';
}

function pathApi(style) {
  return style === 'windows' ? win32 : posix;
}

function normalizedKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

export function isPathArgumentKey(key) {
  return PATH_KEY_PATTERN.test(`_${normalizedKey(key)}_`);
}

function unwrapJsonString(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Treat malformed JSON quoting as an ordinary string.
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function stripWindowsNamespace(value, style) {
  if (style !== 'windows') return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\[?.]\\/.test(value)) return value.slice(4);
  return value;
}

function decodeFileUrl(value, style) {
  if (!/^file:\/\//i.test(value)) return value;
  const parsed = new URL(value);
  let pathname = decodeURIComponent(parsed.pathname);
  if (parsed.hostname) pathname = `//${parsed.hostname}${pathname}`;
  if (style === 'windows' && /^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

function normalizeLexical(value, base, platform = process.platform) {
  const style = platformStyle(platform);
  const api = pathApi(style);
  let candidate = unwrapJsonString(value);
  if (candidate.includes('\0')) throw new Error('Path arguments may not contain NUL bytes');
  if (/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(candidate)) {
    throw new Error('Environment-variable paths are not supported; pass the resolved path explicitly');
  }
  candidate = decodeFileUrl(candidate, style);
  candidate = stripWindowsNamespace(candidate, style);
  const normalizedBase = api.normalize(base);
  const normalized = api.isAbsolute(candidate) ? api.normalize(candidate) : api.resolve(normalizedBase, candidate);
  return { style, path: normalized };
}

function comparable(style, value) {
  const api = pathApi(style);
  const trailingSeparators = style === 'windows' ? /[\\/]+$/ : /\/+$/;
  const normalized = api.normalize(value).replace(trailingSeparators, '');
  return style === 'windows' ? normalized.toLowerCase() : normalized;
}

function isWithin(style, directory, candidate) {
  const api = pathApi(style);
  const base = comparable(style, directory);
  const target = comparable(style, candidate);
  return target === base || target.startsWith(`${base}${api.sep}`);
}

function scopeError(message, allowed) {
  const accessScope = {
    allowedDirectories: allowed.directories.map((entry) => entry.canonical),
    allowedFiles: allowed.files.map((entry) => entry.canonical)
  };
  const error = new Error([
    message,
    `Allowed directories (absolute): ${accessScope.allowedDirectories.length > 0 ? accessScope.allowedDirectories.join(', ') : '(none)'}`,
    `Allowed files (absolute): ${accessScope.allowedFiles.length > 0 ? accessScope.allowedFiles.join(', ') : '(none)'}`
  ].join('\n'));
  error.code = 'PATH_ACCESS_SCOPE_REJECTED';
  error.accessScope = accessScope;
  return error;
}

function isProtectedFileTarget(entry, normalized, canonical) {
  const protectedLexical = comparable(entry.style, entry.lexical);
  const protectedCanonical = comparable(entry.style, entry.canonical);
  const candidateLexical = comparable(normalized.style, normalized.path);
  const candidateCanonical = comparable(normalized.style, canonical);
  if (protectedLexical === candidateLexical || protectedCanonical === candidateCanonical) return true;
  if (entry.style !== 'windows') return false;
  return candidateLexical.startsWith(`${protectedLexical}:`)
    || candidateCanonical.startsWith(`${protectedCanonical}:`);
}

async function canonicalizeExistingPrefix(style, value) {
  const nativeStyle = process.platform === 'win32' ? 'windows' : 'posix';
  if (style !== nativeStyle) return value;
  const api = pathApi(style);
  let cursor = value;
  const missing = [];
  while (true) {
    try {
      const info = await lstat(cursor);
      const actual = await realpath(cursor);
      if (info.isSymbolicLink() || missing.length > 0) return api.join(actual, ...missing.reverse());
      return actual;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = api.dirname(cursor);
      if (parent === cursor) return value;
      missing.push(api.basename(cursor));
      cursor = parent;
    }
  }
}

function looksLikePath(value, platform = process.platform) {
  const candidate = unwrapJsonString(value);
  if (!candidate || URL_PATTERN.test(candidate) && !/^file:\/\//i.test(candidate)) return false;
  if (/^file:\/\//i.test(candidate)) return true;
  if (platformStyle(platform) === 'windows') {
    return WINDOWS_ABSOLUTE_PATTERN.test(candidate)
      || win32.isAbsolute(candidate)
      || /^(?:\.{1,2}|~)[\\/]/.test(candidate);
  }
  return posix.isAbsolute(candidate) || /^(?:\.{1,2}|~)\//.test(candidate);
}

function collectPathArguments(value, keyPath = [], inheritedPathKey = false, output = [], platform = process.platform) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectPathArguments(value[index], [...keyPath, index], inheritedPathKey, output, platform);
    }
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectPathArguments(child, [...keyPath, key], isPathArgumentKey(key), output, platform);
    }
    return output;
  }
  if (typeof value !== 'string') return output;
  const candidate = unwrapJsonString(value);
  if (candidate.includes('\n') || candidate.includes('\r')) return output;
  if (URL_PATTERN.test(candidate) && !/^file:\/\//i.test(candidate)) return output;
  if (inheritedPathKey || looksLikePath(candidate, platform)) output.push({ keyPath, value });
  return output;
}

function displayKeyPath(parts) {
  return parts.reduce((text, part) => typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${part}` : part, '');
}

async function normalizeAllowedEntries(values, base, kind, platform) {
  const entries = [];
  for (const value of values) {
    const normalized = normalizeLexical(value, base, platform);
    const api = pathApi(normalized.style);
    if (!api.isAbsolute(decodeFileUrl(unwrapJsonString(value), normalized.style))) {
      throw new Error(`${kind} entries must be absolute paths: ${value}`);
    }
    entries.push({
      style: normalized.style,
      lexical: normalized.path,
      canonical: await canonicalizeExistingPrefix(normalized.style, normalized.path)
    });
  }
  return entries;
}

export class ToolPathPolicy {
  constructor({
    serverName,
    cwd,
    allowedDirectories = [],
    allowedFiles = [],
    disallowedDirectories = [],
    disallowedFiles = [],
    protectedFiles = [],
    disallowedPathGlobs = [],
    platform = process.platform
  }) {
    this.serverName = serverName;
    this.cwd = cwd;
    this.allowedDirectoriesInput = allowedDirectories;
    this.allowedFilesInput = allowedFiles;
    this.disallowedDirectoriesInput = disallowedDirectories;
    this.disallowedFilesInput = disallowedFiles;
    this.protectedFilesInput = protectedFiles;
    this.disallowedPathGlobs = normalizeDisallowedPathGlobs(disallowedPathGlobs);
    this.platform = platform;
    this.allowedPromise = null;
  }

  async allowed() {
    this.allowedPromise ??= Promise.all([
      normalizeAllowedEntries(this.allowedDirectoriesInput, this.cwd, 'allowed_directories', this.platform),
      normalizeAllowedEntries(this.allowedFilesInput, this.cwd, 'allowed_files', this.platform),
      normalizeAllowedEntries(this.disallowedDirectoriesInput, this.cwd, 'disallowed_directories', this.platform),
      normalizeAllowedEntries(this.disallowedFilesInput, this.cwd, 'disallowed_files', this.platform),
      normalizeAllowedEntries(this.protectedFilesInput, this.cwd, 'protected_files', this.platform)
    ]).then(([directories, files, disallowedDirectories, disallowedFiles, protectedFiles]) => {
      const relevantDisallowedDirectories = disallowedDirectories.filter((entry) => directories.some((allowed) => allowed.style === entry.style
        && isWithin(allowed.style, allowed.canonical, entry.canonical)));
      const relevantDisallowedFiles = disallowedFiles.filter((entry) => {
        const coveredByDirectory = directories.some((allowed) => allowed.style === entry.style
          && isWithin(allowed.style, allowed.canonical, entry.canonical));
        const coveredByFile = files.some((allowed) => allowed.style === entry.style
          && comparable(allowed.style, allowed.canonical) === comparable(entry.style, entry.canonical));
        return coveredByDirectory || coveredByFile;
      });
      return {
        directories,
        files,
        disallowedDirectories: relevantDisallowedDirectories,
        disallowedFiles: relevantDisallowedFiles,
        protectedFiles
      };
    });
    return this.allowedPromise;
  }

  setCwd(cwd) {
    this.cwd = cwd;
  }

  async selectAllowedDirectories(values, cwd = this.cwd) {
    if (!Array.isArray(values) || values.length < 1) throw new Error('Workspace list must contain at least one directory');
    const allowed = await this.allowed();
    const selected = [];
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error('Workspace paths must be non-empty strings without NUL or line breaks');
      const normalized = normalizeLexical(value, cwd, this.platform);
      const canonical = await canonicalizeExistingPrefix(normalized.style, normalized.path);
      const nativeStyle = this.platform === 'win32' ? 'windows' : 'posix';
      if (normalized.style === nativeStyle && !(await stat(canonical)).isDirectory()) throw new Error(`Workspace is not a directory: ${value}`);
      const protectedFile = allowed.protectedFiles.some((entry) => entry.style === normalized.style
        && isProtectedFileTarget(entry, normalized, canonical));
      if (protectedFile) continue;
      const globMatch = findDisallowedPathGlob(canonical, this.disallowedPathGlobs, this.platform);
      if (globMatch) continue;
      const directoryAllowed = allowed.directories.some((entry) => entry.style === normalized.style
        && isWithin(entry.style, entry.canonical, canonical));
      if (!directoryAllowed) continue;
      const fileDenied = allowed.disallowedFiles.some((entry) => entry.style === normalized.style
        && comparable(entry.style, entry.canonical) === comparable(normalized.style, canonical));
      const directoryDenied = allowed.disallowedDirectories.some((entry) => entry.style === normalized.style
        && isWithin(entry.style, entry.canonical, canonical));
      if (fileDenied || directoryDenied) continue;
      if (!selected.some((entry) => comparable(normalized.style, entry) === comparable(normalized.style, canonical))) selected.push(canonical);
    }
    return selected;
  }

  async describe(cwd = this.cwd) {
    const allowed = await this.allowed();
    const entries = (values) => values.map((entry) => ({
      configuredPath: entry.lexical,
      canonicalPath: entry.canonical
    }));
    return {
      serverName: this.serverName,
      workingDirectory: cwd,
      relativePathBase: cwd,
      configured: {
        allowedDirectories: [...this.allowedDirectoriesInput],
        allowedFiles: [...this.allowedFilesInput],
        disallowedDirectories: [...this.disallowedDirectoriesInput],
        disallowedFiles: [...this.disallowedFilesInput],
        protectedFiles: [...this.protectedFilesInput],
        disallowedPathGlobs: [...this.disallowedPathGlobs]
      },
      effective: {
        allowedDirectories: entries(allowed.directories),
        allowedFiles: entries(allowed.files),
        disallowedDirectories: entries(allowed.disallowedDirectories),
        disallowedFiles: entries(allowed.disallowedFiles),
        protectedFiles: entries(allowed.protectedFiles),
        disallowedPathGlobs: [...this.disallowedPathGlobs]
      }
    };
  }

  async describeForAllowedDirectories(values, cwd = this.cwd) {
    const selectedPaths = await this.selectAllowedDirectories(values, cwd);
    const style = this.platform === 'win32' ? 'windows' : 'posix';
    const selected = selectedPaths.map((canonical) => ({ lexical: canonical, canonical, style }));
    const allowed = await this.allowed();
    const insideSelection = (entry) => selected.some((root) => entry.style === root.style
      && isWithin(root.style, root.canonical, entry.canonical));
    const selectedDisallowedDirectories = allowed.disallowedDirectories.filter(insideSelection);
    const selectedDisallowedFiles = allowed.disallowedFiles.filter(insideSelection);
    const selectedProtectedFiles = allowed.protectedFiles.filter(insideSelection);
    const entries = (items) => items.map((entry) => ({
      configuredPath: entry.lexical,
      canonicalPath: entry.canonical
    }));
    return {
      serverName: this.serverName,
      workingDirectory: cwd,
      relativePathBase: cwd,
      configured: {
        allowedDirectories: [...selectedPaths],
        allowedFiles: [],
        disallowedDirectories: selectedDisallowedDirectories.map((entry) => entry.canonical),
        disallowedFiles: selectedDisallowedFiles.map((entry) => entry.canonical),
        protectedFiles: selectedProtectedFiles.map((entry) => entry.canonical),
        disallowedPathGlobs: [...this.disallowedPathGlobs]
      },
      effective: {
        allowedDirectories: entries(selected),
        allowedFiles: [],
        disallowedDirectories: entries(selectedDisallowedDirectories),
        disallowedFiles: entries(selectedDisallowedFiles),
        protectedFiles: entries(selectedProtectedFiles),
        disallowedPathGlobs: [...this.disallowedPathGlobs]
      }
    };
  }

  async assertToolArguments(toolName, args, cwd = this.cwd) {
    const candidates = collectPathArguments(args, [], false, [], this.platform);
    if (candidates.length === 0) return;
    const allowed = await this.allowed();
    for (const candidate of candidates) {
      let normalized;
      try {
        normalized = normalizeLexical(candidate.value, cwd, this.platform);
      } catch (error) {
        throw new Error(`${this.serverName}.${toolName} path argument ${displayKeyPath(candidate.keyPath)} is invalid: ${error.message}`);
      }
      const canonical = await canonicalizeExistingPrefix(normalized.style, normalized.path);
      const protectedFile = allowed.protectedFiles.some((entry) => entry.style === normalized.style
        && isProtectedFileTarget(entry, normalized, canonical));
      if (protectedFile) {
        throw new Error(`${this.serverName}.${toolName} path argument ${displayKeyPath(candidate.keyPath)} targets the gateway configuration; direct reads and edits are disabled`);
      }
      const globMatch = findDisallowedPathGlob(canonical, this.disallowedPathGlobs, this.platform);
      if (globMatch) {
        throw disallowedPathGlobError(
          `${this.serverName}.${toolName} path argument ${displayKeyPath(candidate.keyPath)}`,
          globMatch
        );
      }
      const fileAllowed = allowed.files.some((entry) => entry.style === normalized.style
        && comparable(entry.style, entry.canonical) === comparable(normalized.style, canonical));
      const directoryAllowed = allowed.directories.some((entry) => entry.style === normalized.style
        && isWithin(entry.style, entry.canonical, canonical));
      if (!fileAllowed && !directoryAllowed) {
        throw scopeError(
          `${this.serverName}.${toolName} path argument ${displayKeyPath(candidate.keyPath)} is outside allowed_directories and allowed_files: ${normalized.path}`,
          allowed
        );
      }
      const fileDenied = allowed.disallowedFiles.some((entry) => entry.style === normalized.style
        && comparable(entry.style, entry.canonical) === comparable(normalized.style, canonical));
      const directoryDenied = allowed.disallowedDirectories.some((entry) => entry.style === normalized.style
        && isWithin(entry.style, entry.canonical, canonical));
      if (fileDenied || directoryDenied) {
        throw new Error(`${this.serverName}.${toolName} path argument ${displayKeyPath(candidate.keyPath)} is denied by disallowed_directories or disallowed_files: ${normalized.path}`);
      }
    }
  }
}

export const pathPolicyInternals = {
  collectPathArguments,
  looksLikePath,
  normalizeLexical
};