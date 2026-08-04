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
const HEADER = `# External MCP tool annotations.
# The Gateway creates this file and appends sections only for prefixes that do not already exist.
# Existing prefix sections and tool assignments are never replaced.
# Omit default/tool assignments to preserve annotations supplied by the child MCP.
# Missing child fields use MCP defaults; read-only tools infer destructiveHint=false and idempotentHint=true unless explicitly supplied.
# READ_ONLY_ANNOTATIONS = readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false
# LOCAL_STATE_ANNOTATIONS = readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=false
# LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = readOnlyHint=false, destructiveHint=true, idempotentHint=true, openWorldHint=false
# LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS = readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=false
# LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS = readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=false
# [tool_annotations.example]
# default = "READ_ONLY_ANNOTATIONS"
# open_world_hint = true
# [tool_annotations.example.tools]
# inspect = "READ_ONLY_ANNOTATIONS"
# mutate = "LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS"
# [tool_annotations.example.open_world_tools]
# inspect = true
# mutate = false
`;

function assertPresetName(value, context) {
  if (typeof value !== 'string' || !PRESET_NAMES.has(value)) throw new Error(`${context} must be one of: ${[...PRESET_NAMES].join(', ')}`);
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
  return new Map(Object.entries(value).map(([name, preset]) => [name, assertPresetName(preset, `${context}.${name}`)]));
}

function normalizePrefixConfig(prefix, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`tool_annotations.${prefix} must be a table`);
  if (value.default !== undefined) assertPresetName(value.default, `tool_annotations.${prefix}.default`);
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

function prefixTemplate(prefix) {
  const key = /^[A-Za-z0-9_-]+$/.test(prefix) ? prefix : JSON.stringify(prefix);
  return `\n[tool_annotations.${key}]\n# default = "READ_ONLY_ANNOTATIONS"\n# open_world_hint = true\n[tool_annotations.${key}.tools]\n# tool_name = "READ_ONLY_ANNOTATIONS"\n[tool_annotations.${key}.open_world_tools]\n# tool_name = true\n`;
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
  if (presetName) Object.assign(annotations, ANNOTATION_PRESETS[presetName]);
  const openWorldHint = prefixConfig?.openWorldTools.get(tool.name) ?? prefixConfig?.openWorldHint;
  if (openWorldHint !== undefined) annotations.openWorldHint = openWorldHint;
  return { ...tool, annotations };
}
