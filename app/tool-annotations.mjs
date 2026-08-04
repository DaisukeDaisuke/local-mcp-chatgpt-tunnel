import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseToml } from './toml-lite.mjs';

export const ANNOTATION_PRESETS = Object.freeze({
  READ_ONLY_ANNOTATIONS: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  LOCAL_STATE_ANNOTATIONS: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
  LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
  LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })
});

const MCP_DEFAULT_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
const ANNOTATION_KEYS = Object.freeze(Object.keys(MCP_DEFAULT_ANNOTATIONS));
const PRESET_NAMES = new Set(Object.keys(ANNOTATION_PRESETS));
const UNCLASSIFIED = 'UNCLASSIFIED';
const ASSIGNMENT_NAMES = new Set([...PRESET_NAMES, UNCLASSIFIED]);
const CONFIG_UPDATES = new WeakMap();
const HEADER = `# External MCP tool annotations.
# The Gateway creates this file, appends missing prefix sections, and records newly discovered tools as UNCLASSIFIED.
# Existing prefix sections and tool assignments are never replaced or removed.
# Omit default/tool assignments to preserve annotations supplied by the child MCP.
# Missing child fields use MCP defaults; read-only tools infer destructiveHint=false and idempotentHint=true unless explicitly supplied.
# UNCLASSIFIED = preserve annotations supplied by the child MCP and only complete missing hints
# READ_ONLY_ANNOTATIONS = readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false
# LOCAL_STATE_ANNOTATIONS = readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=false
# LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = readOnlyHint=false, destructiveHint=true, idempotentHint=true, openWorldHint=false
# LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS = readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=false
# LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS = readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=false
# [tool_annotations.example]
# default = "READ_ONLY_ANNOTATIONS"
# open_world_hint = true
# [tool_annotations.example.tools]
# inspect = "UNCLASSIFIED"
# mutate = "LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS"
# [tool_annotations.example.open_world_tools]
# inspect = true
# mutate = false
`;

function assertAssignmentName(value, context) {
  if (typeof value !== 'string' || !ASSIGNMENT_NAMES.has(value)) throw new Error(`${context} must be one of: ${[...ASSIGNMENT_NAMES].join(', ')}`);
  return value;
}

function booleanMap(value, context) {
  if (value === undefined) return new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be a table`);
  const result = new Map();
  for (const [name, hint] of Object.entries(value)) {
    if (typeof hint !== 'boolean') throw new Error(`${context}.${name} must be boolean`);
    result.set(name, hint);
  }
  return result;
}

function presetMap(value, context) {
  if (value === undefined) return new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be a table`);
  return new Map(Object.entries(value).map(([name, preset]) => [name, assertAssignmentName(preset, `${context}.${name}`)]));
}

function normalizePrefixConfig(prefix, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`tool_annotations.${prefix} must be a table`);
  if (value.default !== undefined) assertAssignmentName(value.default, `tool_annotations.${prefix}.default`);
  if (value.open_world_hint !== undefined && typeof value.open_world_hint !== 'boolean') throw new Error(`tool_annotations.${prefix}.open_world_hint must be boolean`);
  return {
    defaultPreset: value.default,
    openWorldHint: value.open_world_hint,
    tools: presetMap(value.tools, `tool_annotations.${prefix}.tools`),
    openWorldTools: booleanMap(value.open_world_tools, `tool_annotations.${prefix}.open_world_tools`)
  };
}

function parseAnnotationConfig(text) {
  const parsed = parseToml(text);
  const table = parsed.tool_annotations ?? {};
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('tool_annotations must be a table');
  return new Map(Object.entries(table).map(([prefix, value]) => [prefix, normalizePrefixConfig(prefix, value)]));
}

function tomlKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function prefixTemplate(prefix) {
  const key = tomlKey(prefix);
  return `\n[tool_annotations.${key}]\n# default = "READ_ONLY_ANNOTATIONS"\n# open_world_hint = true\n[tool_annotations.${key}.tools]\n# Discovered tools are inserted here as UNCLASSIFIED.\n[tool_annotations.${key}.open_world_tools]\n# tool_identifier = true\n`;
}

function isTableHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return false;
  try {
    parseToml(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isToolTableHeader(line, prefix) {
  if (!isTableHeader(line)) return false;
  const marker = '__gateway_tool_annotation_marker__';
  try {
    const parsed = parseToml(`${line}\n${marker} = true`);
    return parsed.tool_annotations?.[prefix]?.tools?.[marker] === true;
  } catch {
    return false;
  }
}

function addDiscoveredTools(text, prefix, toolNames) {
  let parsed = parseAnnotationConfig(text);
  if (!parsed.has(prefix)) {
    text += prefixTemplate(prefix);
    parsed = parseAnnotationConfig(text);
  }
  const existing = parsed.get(prefix).tools;
  const missing = [...new Set(toolNames)]
    .filter((name) => typeof name === 'string' && name.length > 0 && !existing.has(name));
  if (missing.length === 0) return text;

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => isToolTableHeader(line, prefix));
  const assignments = missing.map((name) => `${tomlKey(name)} = "${UNCLASSIFIED}"`);
  if (sectionStart < 0) {
    const separator = text.endsWith('\n') ? newline : `${newline}${newline}`;
    return `${text}${separator}[tool_annotations.${tomlKey(prefix)}.tools]${newline}${assignments.join(newline)}${newline}`;
  }
  let insertionIndex = sectionStart + 1;
  while (insertionIndex < lines.length && !isTableHeader(lines[insertionIndex])) insertionIndex += 1;
  lines.splice(insertionIndex, 0, ...assignments);
  return lines.join(newline);
}

async function readOrCreate(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, HEADER, { encoding: 'utf8', flag: 'wx' });
    return HEADER;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readFile(path, 'utf8');
  }
}

export async function loadToolAnnotationConfig(path, prefixes) {
  const uniquePrefixes = [...new Set(prefixes)];
  if (uniquePrefixes.length === 0) return { path, prefixes: new Map() };
  let text = await readOrCreate(path);
  let parsed = parseAnnotationConfig(text);
  const missing = uniquePrefixes.filter((prefix) => !parsed.has(prefix));
  if (missing.length > 0) {
    const addition = missing.map(prefixTemplate).join('');
    await appendFile(path, addition, 'utf8');
    text += addition;
    parsed = parseAnnotationConfig(text);
  }
  return { path, prefixes: parsed };
}

export async function syncDiscoveredToolAnnotations(config, prefix, toolNames) {
  const previous = CONFIG_UPDATES.get(config) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const text = await readOrCreate(config.path);
    const updated = addDiscoveredTools(text, prefix, toolNames);
    if (updated !== text) await writeFile(config.path, updated, 'utf8');
    config.prefixes = parseAnnotationConfig(updated);
    return config;
  });
  CONFIG_UPDATES.set(config, current);
  try {
    return await current;
  } finally {
    if (CONFIG_UPDATES.get(config) === current) CONFIG_UPDATES.delete(config);
  }
}

function completeAnnotations(value, context) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${context} annotations must be an object`);
  const result = { ...MCP_DEFAULT_ANNOTATIONS };
  for (const key of ANNOTATION_KEYS) {
    if (value?.[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') throw new Error(`${context} annotations.${key} must be boolean`);
    result[key] = value[key];
  }
  if (result.readOnlyHint === true) {
    if (value?.destructiveHint === undefined) result.destructiveHint = false;
    if (value?.idempotentHint === undefined) result.idempotentHint = true;
  }
  return result;
}

export function applyConfiguredAnnotations(tool, prefix, config) {
  const prefixConfig = config.prefixes.get(prefix);
  const annotations = completeAnnotations(tool.annotations, `${prefix}.${tool.name}`);
  const presetName = prefixConfig?.tools.get(tool.name) ?? prefixConfig?.defaultPreset;
  if (presetName && presetName !== UNCLASSIFIED) Object.assign(annotations, ANNOTATION_PRESETS[presetName]);
  const openWorldHint = prefixConfig?.openWorldTools.get(tool.name) ?? prefixConfig?.openWorldHint;
  if (openWorldHint !== undefined) annotations.openWorldHint = openWorldHint;
  return { ...tool, annotations };
}
