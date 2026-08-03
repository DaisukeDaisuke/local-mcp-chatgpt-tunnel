const MAX_GLOBS = 100;
const MAX_GLOB_LENGTH = 512;
const REGEXP_SPECIAL = new Set(['\\', '^', '$', '+', '.', '(', ')', '|', '{', '}', '[', ']']);
const cache = new Map();

function isWindows(platform) {
  return platform === 'win32';
}

function normalizeSeparators(value, platform) {
  return isWindows(platform) ? String(value).replace(/\\/g, '/') : String(value);
}

export function normalizeDisallowedPathGlobs(value, name = 'disallowed_path_globs') {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  if (value.length > MAX_GLOBS) throw new Error(`${name} may contain at most ${MAX_GLOBS} entries`);
  const output = [];
  const seen = new Set();
  for (const item of value) {
    if (item.length === 0) throw new Error(`${name} entries must be non-empty`);
    if (item.length > MAX_GLOB_LENGTH) throw new Error(`${name} entries must be at most ${MAX_GLOB_LENGTH} characters`);
    if (/[\u0000-\u001f\u007f]/.test(item)) throw new Error(`${name} entries may not contain control characters`);
    if (!seen.has(item)) {
      seen.add(item);
      output.push(item);
    }
  }
  return output;
}

function compile(pattern, platform) {
  const key = `${platform}\0${pattern}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const normalized = normalizeSeparators(pattern, platform);
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        while (normalized[index + 1] === '*') index += 1;
        source += '.*';
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += REGEXP_SPECIAL.has(character) ? `\\${character}` : character;
  }
  source += '$';
  const expression = new RegExp(source, isWindows(platform) ? 'iu' : 'u');
  cache.set(key, expression);
  return expression;
}

export function normalizePathForGlob(path, platform = process.platform) {
  return normalizeSeparators(path, platform);
}

export function findDisallowedPathGlob(path, patterns, platform = process.platform) {
  const candidate = normalizePathForGlob(path, platform);
  for (const pattern of patterns) {
    if (compile(pattern, platform).test(candidate)) return { pattern, path: candidate };
  }
  return null;
}

export function disallowedPathGlobError(context, match) {
  return new Error(`${context} was refused by glob filter disallowed_path_globs=${JSON.stringify(match.pattern)}; matched path: ${match.path}`);
}
