import { spawn } from 'node:child_process';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from '../../app/child-environment.mjs';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const SERVER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_PIXELS = 10 * 1024 * 1024;
const DEFAULT_MAX_DIFF_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_PATH_CODE_UNITS = 1024;
const MAX_PIXEL_DETAILS = 256;
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };

for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  if (argument.startsWith('--magick-executable=')) continue;
  throw new Error(`Unknown argument: ${argument}`);
}

function configuredExecutable() {
  if (cli.help) return null;
  const prefix = '--magick-executable=';
  const values = process.argv.slice(2).filter((value) => value.startsWith(prefix));
  if (values.length > 1) throw new Error(`${prefix}<absolute-path> may be specified only once`);
  if (values.length === 0) {
    if (directExecution) throw new Error(`${prefix}<absolute-path> is required`);
    return null;
  }
  const value = values[0].slice(prefix.length);
  if (!value || !isAbsolute(value)) throw new Error('--magick-executable must be an absolute path');
  const executableName = basename(value).toLowerCase();
  if (process.platform === 'win32' && executableName !== 'magick.exe') throw new Error('--magick-executable must point to magick.exe on Windows');
  if (process.platform !== 'win32' && executableName !== 'magick') throw new Error('--magick-executable must point to the magick executable');
  return value;
}

const magickExecutable = configuredExecutable();

export const IMAGE_MAGICK_HELP = `image-magick MCP
Usage:
  node mcp/image-magick/server.mjs --magick-executable=<absolute-magick.exe-path>
This MCP compares two local PNG/JPEG/WebP images inside the signed Gateway roots. ImageMagick is invoked only as the fixed configured executable with fixed decode/encode operations; callers cannot select an executable, subcommand, environment variable, script, or arbitrary native argument. The comparison itself is published and deterministic: both images are decoded by ImageMagick to sRGB RGBA8, aligned at the top-left on a transparent union canvas, compared channel-by-channel, and visualized as a dim grayscale candidate image with tolerance-exceeding pixels highlighted in magenta. The diff PNG is returned directly as MCP image content and is not persistently written by this server.
`;

function pathArray(name, fallback = []) {
  if (cli.help) return [];
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) throw new Error(`${name} must contain a JSON string array`);
  return parsed;
}

function positiveIntegerEnvironment(name, fallback) {
  if (cli.help) return fallback;
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const allowedDirectories = pathArray('LOCAL_MCP_ALLOWED_DIRECTORIES', [process.cwd()]);
const allowedFiles = pathArray('LOCAL_MCP_ALLOWED_FILES');
const disallowedDirectories = pathArray('LOCAL_MCP_DISALLOWED_DIRECTORIES');
const disallowedFiles = pathArray('LOCAL_MCP_DISALLOWED_FILES');
const disallowedPathGlobs = pathArray('LOCAL_MCP_DISALLOWED_PATH_GLOBS');
const MAX_INPUT_BYTES = positiveIntegerEnvironment('IMAGE_MAGICK_MCP_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES);
const MAX_IMAGE_PIXELS = positiveIntegerEnvironment('IMAGE_MAGICK_MCP_MAX_PIXELS', DEFAULT_MAX_IMAGE_PIXELS);
const MAX_DIFF_IMAGE_BYTES = positiveIntegerEnvironment('IMAGE_MAGICK_MCP_MAX_DIFF_BYTES', DEFAULT_MAX_DIFF_IMAGE_BYTES);
const isolation = createBundledIsolation();
const policy = new ToolPathPolicy({
  serverName: 'image-magick',
  cwd: process.cwd(),
  allowedDirectories,
  allowedFiles,
  disallowedDirectories,
  disallowedFiles,
  disallowedPathGlobs,
  disallowedPathsCanonical: process.env.LOCAL_MCP_DISALLOWED_PATHS_CANONICAL === '1'
});

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const localStateAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const rgbaSchema = {
  type: 'array',
  items: { type: 'integer', minimum: 0, maximum: 255 },
  minItems: 4,
  maxItems: 4
};
const imageDescriptorSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
    bytes: { type: 'integer', minimum: 1 }
  },
  required: ['path', 'width', 'height', 'bytes'],
  additionalProperties: false
};
const comparisonResultSchema = {
  type: 'object',
  properties: {
    reference: imageDescriptorSchema,
    candidate: imageDescriptorSchema,
    canvas: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
        pixels: { type: 'integer', minimum: 1 }
      },
      required: ['width', 'height', 'pixels'],
      additionalProperties: false
    },
    sameDimensions: { type: 'boolean' },
    channelTolerance: { type: 'integer', minimum: 0, maximum: 255 },
    exactDifferentPixels: { type: 'integer', minimum: 0 },
    differentPixels: { type: 'integer', minimum: 0 },
    exactMatchPercent: { type: 'number', minimum: 0, maximum: 100 },
    matchPercent: { type: 'number', minimum: 0, maximum: 100 },
    meanAbsoluteChannelError: { type: 'number', minimum: 0, maximum: 255 },
    meanAbsoluteChannelErrorPercent: { type: 'number', minimum: 0, maximum: 100 },
    rmseChannelError: { type: 'number', minimum: 0, maximum: 255 },
    rmsePercent: { type: 'number', minimum: 0, maximum: 100 },
    maxChannelDelta: { type: 'integer', minimum: 0, maximum: 255 },
    differenceBounds: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 }
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false
        }
      ]
    },
    pixelDetails: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x: { type: 'integer', minimum: 0 },
          y: { type: 'integer', minimum: 0 },
          reference: rgbaSchema,
          candidate: rgbaSchema,
          delta: rgbaSchema,
          maxChannelDelta: { type: 'integer', minimum: 0, maximum: 255 }
        },
        required: ['x', 'y', 'reference', 'candidate', 'delta', 'maxChannelDelta'],
        additionalProperties: false
      },
      maxItems: MAX_PIXEL_DETAILS
    },
    pixelDetailsTruncated: { type: 'boolean' },
    visualization: {
      type: 'object',
      properties: {
        mimeType: { type: 'string', enum: ['image/png'] },
        bytes: { type: 'integer', minimum: 1 },
        rule: { type: 'string' }
      },
      required: ['mimeType', 'bytes', 'rule'],
      additionalProperties: false
    },
    algorithm: {
      type: 'object',
      properties: {
        decoder: { type: 'string' },
        colorSpace: { type: 'string' },
        channels: { type: 'string' },
        alignment: { type: 'string' },
        equality: { type: 'string' },
        metrics: { type: 'string' },
        visualization: { type: 'string' }
      },
      required: ['decoder', 'colorSpace', 'channels', 'alignment', 'equality', 'metrics', 'visualization'],
      additionalProperties: false
    }
  },
  required: [
    'reference', 'candidate', 'canvas', 'sameDimensions', 'channelTolerance', 'exactDifferentPixels', 'differentPixels',
    'exactMatchPercent', 'matchPercent', 'meanAbsoluteChannelError', 'meanAbsoluteChannelErrorPercent', 'rmseChannelError',
    'rmsePercent', 'maxChannelDelta', 'differenceBounds', 'pixelDetails', 'pixelDetailsTruncated', 'visualization', 'algorithm'
  ],
  additionalProperties: false
};

function outputSchema(resultSchema) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      result: resultSchema,
      error: { type: 'string' }
    },
    required: ['ok'],
    additionalProperties: false
  };
}

const rootsResultSchema = {
  type: 'object',
  properties: {
    roots: { type: 'array', items: { type: 'string' }, minItems: 1 },
    workingDirectory: { type: 'string' }
  },
  required: ['roots', 'workingDirectory'],
  additionalProperties: false
};
const workingDirectoryResultSchema = {
  type: 'object',
  properties: { workingDirectory: { type: 'string' } },
  required: ['workingDirectory'],
  additionalProperties: false
};

const schemas = [
  {
    name: 'roots',
    description: 'Return only the verified signed image roots and current base for this call. Outside the Gateway, the configured local allowlist is used. Security: this tool cannot add or override roots.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: outputSchema(rootsResultSchema),
    annotations: readOnlyAnnotations
  },
  {
    name: 'get_working_directory',
    description: 'Return the verified base used for relative image paths. Security: no filesystem mutation or executable invocation occurs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: outputSchema(workingDirectoryResultSchema),
    annotations: readOnlyAnnotations
  },
  {
    name: 'set_working_directory',
    description: 'Select an existing directory inside one signed root as the relative-path base. The complete configured allow/deny policy is applied and public root/workspace overrides are rejected. Security: this changes only MCP path state, not filesystem contents.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CODE_UNITS } },
      required: ['path'],
      additionalProperties: false
    },
    outputSchema: outputSchema(workingDirectoryResultSchema),
    annotations: localStateAnnotations
  },
  {
    name: 'compare_images',
    title: 'Compare local images pixel-by-pixel',
    description: 'Compare exactly two local PNG/JPEG/WebP files. ImageMagick is used only through one fixed configured executable to decode each image to sRGB RGBA8 and to encode the returned PNG visualization; arbitrary commands, scripts, executables, environment variables, native arguments, output paths, network inputs, and persistent writes are not exposed. The published comparison aligns images top-left on a transparent union canvas, computes exact and tolerance-based per-pixel differences, bounds and bounded coordinate/color details, and returns a magenta-highlight diff image directly to the AI.',
    inputSchema: {
      type: 'object',
      properties: {
        referencePath: { type: 'string', minLength: 1, maxLength: MAX_PATH_CODE_UNITS },
        candidatePath: { type: 'string', minLength: 1, maxLength: MAX_PATH_CODE_UNITS },
        channelTolerance: { type: 'integer', minimum: 0, maximum: 255, default: 0, description: 'A pixel counts as different when at least one RGBA8 channel differs by more than this value.' },
        maxPixelDetails: { type: 'integer', minimum: 0, maximum: MAX_PIXEL_DETAILS, default: 64, description: 'Maximum number of differing pixel coordinate/color records returned in structured text. The visualization still covers the entire image.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS }
      },
      required: ['referencePath', 'candidatePath'],
      additionalProperties: false
    },
    outputSchema: outputSchema(comparisonResultSchema),
    annotations: readOnlyAnnotations
  }
];

const toolResult = (value, isError = false, imageBytes = null) => ({
  content: [
    { type: 'text', text: JSON.stringify(value) },
    ...(imageBytes ? [{ type: 'image', data: imageBytes.toString('base64'), mimeType: 'image/png' }] : [])
  ],
  structuredContent: value,
  isError
});

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function rejectPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a non-empty path without NUL or line breaks`);
  if (value.length > MAX_PATH_CODE_UNITS) throw new Error(`${label} exceeds the ${MAX_PATH_CODE_UNITS}-character path limit`);
  if (/^(?:\\\\|\/\/)/.test(value)) throw new Error(`${label} may not be a UNC path`);
  if (/[\[\]]/.test(value)) throw new Error(`${label} may not contain square brackets because ImageMagick interprets them as image selectors`);
  if (process.platform === 'win32') {
    const normalized = value.replace(/\//g, '\\');
    if (/^[A-Za-z]:[^\\]/.test(normalized)) throw new Error(`${label} may not be drive-relative`);
    if (/^\\(?!\\)/.test(normalized)) throw new Error(`${label} may not be root-relative`);
    if (/^\\\\[?.]\\/i.test(normalized)) throw new Error(`${label} may not use Windows namespace paths`);
    if (normalized.replace(/^[A-Za-z]:/, '').includes(':')) throw new Error(`${label} may not use NTFS alternate data streams`);
  }
}

function assertResolvedPathLength(value, label) {
  if (value.length > MAX_PATH_CODE_UNITS) throw new Error(`${label} exceeds the ${MAX_PATH_CODE_UNITS}-character path limit after resolution`);
}

let standaloneBasePromise;
async function roots() {
  const current = isolation.current();
  if (current) return [...current.roots];
  const candidates = allowedDirectories.length > 0
    ? allowedDirectories
    : allowedFiles.length > 0
      ? [...new Set(allowedFiles.map((value) => dirname(value)))]
      : [process.cwd()];
  return policy.selectAllowedDirectories(candidates);
}

async function base() {
  const current = isolation.current();
  if (current) return current.base;
  standaloneBasePromise ??= roots().then(([first]) => first);
  return standaloneBasePromise;
}

async function scopedPolicy(selectedRoots, selectedBase) {
  const scoped = new ToolPathPolicy({ serverName: 'image-magick-isolation', cwd: selectedBase, allowedDirectories: selectedRoots });
  await scoped.allowed();
  return scoped;
}

async function existingPath(value, label, requireDirectory = false) {
  rejectPath(value, label);
  const selectedRoots = await roots();
  const selectedBase = await base();
  const lexical = resolve(isAbsolute(value) ? value : join(selectedBase, value));
  assertResolvedPathLength(lexical, label);
  await policy.assertToolArguments(label, { [label]: lexical }, selectedBase);
  const scoped = await scopedPolicy(selectedRoots, selectedBase);
  await scoped.assertToolArguments(label, { [label]: lexical }, selectedBase);
  const lexicalInfo = await lstat(lexical);
  if (lexicalInfo.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`);
  const actual = await realpath(lexical);
  rejectPath(actual, `${label} resolved path`);
  assertResolvedPathLength(actual, label);
  if (!selectedRoots.some((root) => within(root, actual))) throw new Error(`${label} resolves outside the signed workspace roots`);
  await policy.assertToolArguments(label, { [label]: actual }, selectedBase);
  await scoped.assertToolArguments(label, { [label]: actual }, selectedBase);
  const info = await stat(actual);
  if (requireDirectory && !info.isDirectory()) throw new Error(`${label} must be a directory`);
  if (!requireDirectory && !info.isFile()) throw new Error(`${label} must be a regular file`);
  return { path: actual, info };
}

async function validateImageFile(value, label) {
  const target = await existingPath(value, label, false);
  if (target.info.size <= 0) throw new Error(`${label} is empty`);
  if (target.info.size > MAX_INPUT_BYTES) throw new Error(`${label} exceeds the ${MAX_INPUT_BYTES}-byte input limit`);
  const extension = extname(target.path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error(`${label} must be PNG, JPEG, or WebP`);
  const handle = await open(target.path, 'r');
  const header = Buffer.alloc(16);
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  const bytes = header.subarray(0, bytesRead);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const expected = extension === '.png' ? png : extension === '.jpg' || extension === '.jpeg' ? jpeg : webp;
  if (!expected) throw new Error(`${label} extension does not match its PNG/JPEG/WebP file signature`);
  return target;
}

let executablePromise;
async function executable() {
  if (!magickExecutable) throw new Error('ImageMagick executable is unavailable; configure --magick-executable=<absolute-magick.exe-path>');
  executablePromise ??= (async () => {
    const info = await lstat(magickExecutable);
    if (info.isSymbolicLink()) throw new Error('--magick-executable may not be a symbolic link');
    const actual = await realpath(magickExecutable);
    if (!(await stat(actual)).isFile()) throw new Error('--magick-executable must point to a regular file');
    return actual;
  })();
  const actual = await executablePromise;
  const selectedRoots = await roots();
  if (selectedRoots.some((root) => within(root, actual))) throw new Error('--magick-executable must be outside writable signed workspace roots');
  return actual;
}

function boundedTimeout(value) {
  const resolved = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  return resolved;
}

async function runMagick(args, { cwd, timeoutMs, stdoutLimit, stderrLimit = MAX_DIAGNOSTIC_BYTES, stdinData = null, signal } = {}) {
  const command = await executable();
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let child;
  let timer;
  let settled = false;
  const environment = buildChildEnvironment({
    MAGICK_MEMORY_LIMIT: '256MiB',
    MAGICK_MAP_LIMIT: '512MiB',
    MAGICK_DISK_LIMIT: '0',
    MAGICK_THREAD_LIMIT: '2'
  }, environmentWithoutBundledIsolationKey());
  const append = (chunks, currentBytes, chunk, maximum, name, rejectExit) => {
    const bytes = Buffer.from(chunk);
    const nextBytes = currentBytes + bytes.length;
    if (nextBytes > maximum) {
      if (child && child.exitCode === null && !child.killed) child.kill();
      rejectExit(new Error(`ImageMagick ${name} exceeded ${maximum} bytes`));
      return currentBytes;
    }
    chunks.push(bytes);
    return nextBytes;
  };
  const result = await new Promise((resolveExit, rejectExit) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (child && child.exitCode === null && !child.killed) child.kill();
      rejectExit(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolveExit(value);
    };
    child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    child.stdout.on('data', (chunk) => { stdoutBytes = append(stdoutChunks, stdoutBytes, chunk, stdoutLimit, 'stdout', fail); });
    child.stderr.on('data', (chunk) => { stderrBytes = append(stderrChunks, stderrBytes, chunk, stderrLimit, 'stderr', fail); });
    child.once('error', fail);
    child.once('exit', (code, exitSignal) => succeed({ code, signal: exitSignal }));
    if (stdinData) {
      child.stdin.once('error', (error) => {
        if (error?.code !== 'EPIPE') fail(error);
      });
      child.stdin.end(stdinData);
    }
    if (signal) {
      if (signal.aborted) fail(new Error('ImageMagick operation was cancelled'));
      else signal.addEventListener('abort', () => fail(new Error('ImageMagick operation was cancelled')), { once: true });
    }
    timer = setTimeout(() => fail(new Error(`ImageMagick timed out after ${timeoutMs}ms`)), timeoutMs);
  }).finally(() => clearTimeout(timer));
  const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
  const stderr = Buffer.concat(stderrChunks, stderrBytes);
  if (result.signal || result.code !== 0) {
    const diagnostic = stderr.toString('utf8').trim() || stdout.toString('utf8').trim() || 'no diagnostic output';
    throw new Error(`ImageMagick failed (${result.signal ?? result.code}): ${diagnostic}`);
  }
  return { stdout, stderr };
}

async function identifyImage(target, runner, operation) {
  const result = await runner(
    ['identify', '-ping', '-format', '%w %h', target.path],
    { cwd: await base(), timeoutMs: operation.timeoutMs, stdoutLimit: 4096, signal: operation.signal }
  );
  const match = result.stdout.toString('utf8').trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) throw new Error('ImageMagick returned an unexpected image dimension response');
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(pixels)) {
    throw new Error('ImageMagick returned invalid image dimensions');
  }
  return { path: target.path, width, height, bytes: target.info.size };
}

async function decodeRgba(image, canvas, runner, operation) {
  const expected = canvas.width * canvas.height * 4;
  const geometry = `${canvas.width}x${canvas.height}`;
  const result = await runner(
    [
      image.path,
      '-colorspace', 'sRGB',
      '-alpha', 'on',
      '-background', 'none',
      '-gravity', 'northwest',
      '-extent', geometry,
      '-depth', '8',
      'rgba:-'
    ],
    { cwd: await base(), timeoutMs: operation.timeoutMs, stdoutLimit: expected, signal: operation.signal }
  );
  if (result.stdout.length !== expected) throw new Error(`ImageMagick RGBA output length ${result.stdout.length} did not match expected ${expected}`);
  return result.stdout;
}

function rounded(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function comparePixels(reference, candidate, width, tolerance, maxDetails) {
  const totalPixels = reference.length / 4;
  let exactDifferentPixels = 0;
  let differentPixels = 0;
  let absoluteErrorSum = 0;
  let squaredErrorSum = 0;
  let maximumDelta = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  const details = [];
  const visualization = Buffer.alloc(totalPixels * 3);
  for (let pixel = 0, source = 0, visual = 0; pixel < totalPixels; pixel += 1, source += 4, visual += 3) {
    const dr = Math.abs(reference[source] - candidate[source]);
    const dg = Math.abs(reference[source + 1] - candidate[source + 1]);
    const db = Math.abs(reference[source + 2] - candidate[source + 2]);
    const da = Math.abs(reference[source + 3] - candidate[source + 3]);
    const pixelMax = Math.max(dr, dg, db, da);
    if (pixelMax > 0) exactDifferentPixels += 1;
    absoluteErrorSum += dr + dg + db + da;
    squaredErrorSum += dr * dr + dg * dg + db * db + da * da;
    if (pixelMax > maximumDelta) maximumDelta = pixelMax;
    const gray = Math.round((candidate[source] * 54 + candidate[source + 1] * 183 + candidate[source + 2] * 19) / 256 / 4);
    if (pixelMax > tolerance) {
      differentPixels += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (details.length < maxDetails) {
        details.push({
          x,
          y,
          reference: [reference[source], reference[source + 1], reference[source + 2], reference[source + 3]],
          candidate: [candidate[source], candidate[source + 1], candidate[source + 2], candidate[source + 3]],
          delta: [dr, dg, db, da],
          maxChannelDelta: pixelMax
        });
      }
      visualization[visual] = 255;
      visualization[visual + 1] = 0;
      visualization[visual + 2] = 255;
    } else {
      visualization[visual] = gray;
      visualization[visual + 1] = gray;
      visualization[visual + 2] = gray;
    }
  }
  const channels = totalPixels * 4;
  const meanAbsoluteChannelError = absoluteErrorSum / channels;
  const rmseChannelError = Math.sqrt(squaredErrorSum / channels);
  const differenceBounds = differentPixels === 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return {
    exactDifferentPixels,
    differentPixels,
    exactMatchPercent: rounded((1 - exactDifferentPixels / totalPixels) * 100),
    matchPercent: rounded((1 - differentPixels / totalPixels) * 100),
    meanAbsoluteChannelError: rounded(meanAbsoluteChannelError),
    meanAbsoluteChannelErrorPercent: rounded(meanAbsoluteChannelError / 255 * 100),
    rmseChannelError: rounded(rmseChannelError),
    rmsePercent: rounded(rmseChannelError / 255 * 100),
    maxChannelDelta: maximumDelta,
    differenceBounds,
    pixelDetails: details,
    pixelDetailsTruncated: differentPixels > details.length,
    visualization
  };
}

async function encodeVisualization(rgb, canvas, runner, operation) {
  const geometry = `${canvas.width}x${canvas.height}`;
  const result = await runner(
    ['-size', geometry, '-depth', '8', 'rgb:-', '-strip', 'png:-'],
    {
      cwd: await base(),
      timeoutMs: operation.timeoutMs,
      stdoutLimit: MAX_DIFF_IMAGE_BYTES,
      stdinData: rgb,
      signal: operation.signal
    }
  );
  if (result.stdout.length === 0) throw new Error('ImageMagick returned an empty PNG visualization');
  return result.stdout;
}

function validateKeys(args, allowed, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`Unexpected argument: ${key}`);
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`Missing required argument: ${key}`);
}

async function compareImages(args, runner, operation) {
  validateKeys(args, new Set(['referencePath', 'candidatePath', 'channelTolerance', 'maxPixelDetails', 'timeoutMs']), ['referencePath', 'candidatePath']);
  const tolerance = args.channelTolerance ?? 0;
  const maxDetails = args.maxPixelDetails ?? 64;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new Error('channelTolerance must be an integer from 0 through 255');
  if (!Number.isSafeInteger(maxDetails) || maxDetails < 0 || maxDetails > MAX_PIXEL_DETAILS) throw new Error(`maxPixelDetails must be an integer from 0 through ${MAX_PIXEL_DETAILS}`);
  operation.timeoutMs = boundedTimeout(args.timeoutMs);
  const referenceTarget = await validateImageFile(args.referencePath, 'referencePath');
  const candidateTarget = await validateImageFile(args.candidatePath, 'candidatePath');
  const referenceImage = await identifyImage(referenceTarget, runner, operation);
  const candidateImage = await identifyImage(candidateTarget, runner, operation);
  const canvas = {
    width: Math.max(referenceImage.width, candidateImage.width),
    height: Math.max(referenceImage.height, candidateImage.height)
  };
  canvas.pixels = canvas.width * canvas.height;
  if (!Number.isSafeInteger(canvas.pixels) || canvas.pixels > MAX_IMAGE_PIXELS) {
    throw new Error(`Union comparison canvas exceeds the ${MAX_IMAGE_PIXELS}-pixel limit`);
  }
  const referenceRgba = await decodeRgba(referenceImage, canvas, runner, operation);
  const candidateRgba = await decodeRgba(candidateImage, canvas, runner, operation);
  const metrics = comparePixels(referenceRgba, candidateRgba, canvas.width, tolerance, maxDetails);
  const diffPng = await encodeVisualization(metrics.visualization, canvas, runner, operation);
  const result = {
    reference: referenceImage,
    candidate: candidateImage,
    canvas,
    sameDimensions: referenceImage.width === candidateImage.width && referenceImage.height === candidateImage.height,
    channelTolerance: tolerance,
    exactDifferentPixels: metrics.exactDifferentPixels,
    differentPixels: metrics.differentPixels,
    exactMatchPercent: metrics.exactMatchPercent,
    matchPercent: metrics.matchPercent,
    meanAbsoluteChannelError: metrics.meanAbsoluteChannelError,
    meanAbsoluteChannelErrorPercent: metrics.meanAbsoluteChannelErrorPercent,
    rmseChannelError: metrics.rmseChannelError,
    rmsePercent: metrics.rmsePercent,
    maxChannelDelta: metrics.maxChannelDelta,
    differenceBounds: metrics.differenceBounds,
    pixelDetails: metrics.pixelDetails,
    pixelDetailsTruncated: metrics.pixelDetailsTruncated,
    visualization: {
      mimeType: 'image/png',
      bytes: diffPng.length,
      rule: 'Candidate image is shown as dim grayscale context; pixels whose maximum RGBA8 channel delta exceeds channelTolerance are pure magenta.'
    },
    algorithm: {
      decoder: 'The fixed locally configured ImageMagick executable decodes each permitted local file; no caller-controlled executable, command, delegate, or native argument is accepted.',
      colorSpace: 'Each image is converted to sRGB before comparison.',
      channels: 'Pixels are normalized to 8-bit RGBA and all four channels participate in error metrics.',
      alignment: 'Images are anchored at top-left on a transparent canvas sized to max(reference width, candidate width) by max(reference height, candidate height).',
      equality: 'Exact difference means any RGBA8 channel delta is nonzero. Tolerance difference means max(abs(channel delta)) is greater than channelTolerance.',
      metrics: 'Match percentage counts pixels, while MAE and RMSE are computed across all RGBA channels on the full union canvas.',
      visualization: 'The full candidate canvas is dim grayscale; tolerance-different pixels are highlighted magenta and the PNG is returned directly as MCP image content.'
    }
  };
  return toolResult({ ok: true, result }, false, diffPng);
}

async function callTool(name, args, runner, operation) {
  if (name === 'roots') {
    validateKeys(args, new Set());
    return toolResult({ ok: true, result: { roots: await roots(), workingDirectory: await base() } });
  }
  if (name === 'get_working_directory') {
    validateKeys(args, new Set());
    return toolResult({ ok: true, result: { workingDirectory: await base() } });
  }
  if (name === 'set_working_directory') {
    validateKeys(args, new Set(['path']), ['path']);
    const target = await existingPath(args.path, 'path', true);
    if (!isolation.current()) standaloneBasePromise = Promise.resolve(target.path);
    return toolResult({ ok: true, result: { workingDirectory: target.path } });
  }
  if (name === 'compare_images') return compareImages(args, runner, operation);
  throw new Error(`Unknown tool: ${name}`);
}

export function createServer({ runner = runMagick } = {}) {
  let initialized = false;
  const active = new Map();
  return async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'notifications/cancelled') {
      const controller = active.get(request.params?.requestId);
      if (controller) controller.abort();
      return null;
    }
    if (request.method === 'initialize') {
      initialized = true;
      return response(request.id, {
        protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'image-magick', version: SERVER_VERSION },
        instructions: 'Read-only local pixel comparison. Every tools/call is isolated by the bundled signed-root envelope in Gateway mode. Only PNG/JPEG/WebP files inside the signed/configured path policy are accepted. ImageMagick is a fixed local executable with fixed decode/encode operations; this MCP exposes no arbitrary code, shell, script, native argument, output path, environment, network, or persistent-write capability.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const result = await isolation.run(request.params?.arguments ?? {}, async (toolArguments) => {
          const controller = new AbortController();
          if (request.id !== undefined) active.set(request.id, controller);
          try {
            return await callTool(
              request.params?.name,
              toolArguments,
              runner,
              { signal: controller.signal, timeoutMs: DEFAULT_TIMEOUT_MS }
            );
          } finally {
            if (request.id !== undefined) active.delete(request.id);
          }
        });
        return response(request.id, result);
      } catch (error) {
        return response(request.id, toolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true));
      }
    }
    return protocolError(request.id, -32601, 'Method not found');
  };
}

export async function startStdio(input = process.stdin, output = process.stdout) {
  const handle = createServer();
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(protocolError(null, -32700, 'Parse error'))}\n`);
        continue;
      }
      void handle(request).then((reply) => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      }).catch((error) => {
        process.stderr.write(`[image-magick] unhandled request error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      });
    }
  });
}

if (directExecution) {
  if (cli.help) process.stdout.write(IMAGE_MAGICK_HELP);
  else await startStdio();
}
