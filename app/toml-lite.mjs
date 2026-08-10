function syntaxError(lineNumber, message) {
  return new Error(`TOML line ${lineNumber}: ${message}`);
}

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '') return line.slice(0, index);
  }
  return line;
}

function splitTopLevel(value, delimiter, lineNumber) {
  const parts = [];
  let quote = null;
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') depth -= 1;
    else if (character === delimiter && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) throw syntaxError(lineNumber, 'unexpected closing bracket');
  }
  if (quote) throw syntaxError(lineNumber, 'unterminated string');
  if (depth !== 0) throw syntaxError(lineNumber, 'unbalanced array brackets');
  parts.push(value.slice(start).trim());
  return parts;
}

function parseString(value, lineNumber) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw syntaxError(lineNumber, `invalid double-quoted string: ${error.message}`);
    }
  }
  if (!value.endsWith("'")) throw syntaxError(lineNumber, 'unterminated literal string');
  return value.slice(1, -1);
}

function parseValue(value, lineNumber) {
  const trimmed = value.trim();
  if (!trimmed) throw syntaxError(lineNumber, 'missing value');
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseString(trimmed, lineNumber);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) throw syntaxError(lineNumber, 'unterminated array');
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return splitTopLevel(body, ',', lineNumber).map((part) => parseValue(part, lineNumber));
  }
  throw syntaxError(lineNumber, `unsupported value ${trimmed}`);
}

function parseKeyPart(part, lineNumber) {
  const trimmed = part.trim();
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return parseString(trimmed, lineNumber);
  }
  throw syntaxError(lineNumber, `invalid key ${trimmed}`);
}

function parseKeyPath(value, lineNumber) {
  return splitTopLevel(value, '.', lineNumber).map((part) => parseKeyPart(part, lineNumber));
}

function ensureSection(root, path, lineNumber) {
  let current = root;
  for (const part of path) {
    if (current[part] === undefined) current[part] = {};
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      throw syntaxError(lineNumber, `section ${path.join('.')} conflicts with an existing value`);
    }
    current = current[part];
  }
  return current;
}

export function parseToml(text) {
  const root = {};
  let current = root;
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      if (!line.endsWith(']') || line.startsWith('[[')) throw syntaxError(lineNumber, 'only ordinary tables are supported');
      current = ensureSection(root, parseKeyPath(line.slice(1, -1), lineNumber), lineNumber);
      continue;
    }
    const [rawKey, ...rest] = splitTopLevel(line, '=', lineNumber);
    if (rest.length !== 1) throw syntaxError(lineNumber, 'expected one key = value assignment');
    const keyPath = parseKeyPath(rawKey, lineNumber);
    const key = keyPath.pop();
    const target = ensureSection(current, keyPath, lineNumber);
    if (Object.hasOwn(target, key)) throw syntaxError(lineNumber, `duplicate key ${key}`);
    target[key] = parseValue(rest[0], lineNumber);
  }
  return root;
}