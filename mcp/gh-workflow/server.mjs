import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';

const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);

function boundedIntegerEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

const MAX_OUTPUT_BYTES = boundedIntegerEnvironment('GH_WORKFLOW_MCP_MAX_OUTPUT_BYTES', 8 * 1024 * 1024, 1024, 128 * 1024 * 1024);
const isolation = createBundledIsolation();

function validateRepository(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 201 || /[\0\r\n]/.test(value)) {
    throw new Error('repository must be OWNER/REPO');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new Error('repository must be OWNER/REPO using only letters, numbers, dot, underscore, and hyphen');
  }
  if (value.includes('..') || value.endsWith('.git')) throw new Error('repository is invalid');
  return value;
}

function stringOptions(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2)
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
}

const help = process.argv.slice(2).some((value) => value === '--help' || value === '-h');
const repositoryOptions = stringOptions('repository');

for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h' || argument.startsWith('--repository=')) continue;
  throw new Error(`Unknown argument: ${argument}`);
}

if (!help && repositoryOptions.length === 0) {
  throw new Error('At least one --repository=OWNER/REPO is required');
}

const cli = {
  help,
  repositories: help ? ['OWNER/REPO'] : [...new Set(repositoryOptions.map(validateRepository))]
};

export const GH_WORKFLOW_MCP_HELP = `gh-workflow

Usage:
  node mcp/gh-workflow/server.mjs --repository=OWNER/REPO [--repository=OWNER/REPO ...]

GitHub Actions inspection and explicit run cancellation for a repository allowlist.
The server spawns gh directly with shell=false, a fixed subcommand allowlist,
validated arguments, ignored stdin, bounded output, and an explicit cwd.
Gateway calls require an HMAC-signed isolated context, and public root or workspace overrides are rejected.
`;

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false
};
const toolResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError
});
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const cancelRunAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const runIdSchema = {
  type: 'string',
  pattern: '^[1-9][0-9]{0,19}$',
  description: 'GitHub Actions run ID from /actions/runs/RUN_ID, not the job ID from /job/JOB_ID.'
};
const repositorySchema = {
  type: 'string',
  enum: cli.repositories,
  ...(cli.repositories.length === 1 ? { default: cli.repositories[0] } : {})
};
const repositoryRequired = cli.repositories.length > 1 ? ['repository'] : [];
const toolInput = (properties = {}, required = []) => ({
  type: 'object',
  properties: { repository: repositorySchema, ...properties },
  required: [...repositoryRequired, ...required],
  additionalProperties: false
});

const schemas = [
  {
    name: 'list_runs',
    description: 'List recent GitHub Actions runs for the configured repository and branch.',
    inputSchema: toolInput({
        branch: { type: 'string', minLength: 1, maxLength: 255, default: 'main' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 3 }
    }),
    annotations: readOnly
  },
  {
    name: 'watch_run',
    description: 'Watch one workflow run until completion and return an error when the run fails.',
    inputSchema: toolInput({ runId: runIdSchema }, ['runId']),
    annotations: readOnly
  },
  {
    name: 'cancel_run',
    description: 'Immediately request cancellation of one in-progress GitHub Actions run.',
    inputSchema: toolInput({ runId: runIdSchema }, ['runId']),
    annotations: cancelRunAnnotations
  },
  {
    name: 'view_run',
    description: 'View the summary of one workflow run.',
    inputSchema: toolInput({ runId: runIdSchema }, ['runId']),
    annotations: readOnly
  },
  {
    name: 'view_run_jobs',
    description: 'Return the jobs JSON for one workflow run.',
    inputSchema: toolInput({ runId: runIdSchema }, ['runId']),
    annotations: readOnly
  },
  {
    name: 'view_run_logs',
    description: 'Return the complete logs for one workflow run, subject to the output-size limit.',
    inputSchema: toolInput({ runId: runIdSchema }, ['runId']),
    annotations: readOnly
  },
  {
    name: 'view_failed_logs',
    description: 'Return only failed-step logs for one workflow run, subject to the output-size limit.',
    inputSchema: toolInput({ runId: runIdSchema }, ['runId']),
    annotations: readOnly
  },
  {
    name: 'list_workflows',
    description: 'List workflows in the configured repository.',
    inputSchema: toolInput({
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        includeDisabled: { type: 'boolean', default: false }
    }),
    annotations: readOnly
  },
  {
    name: 'view_workflow',
    description: 'View one workflow by name, numeric ID, or workflow file path.',
    inputSchema: toolInput({ workflow: { type: 'string', minLength: 1, maxLength: 255 } }, ['workflow']),
    annotations: readOnly
  },
  {
    name: 'view_workflow_yaml',
    description: 'Return the YAML definition of one workflow by name, numeric ID, or workflow file path.',
    inputSchema: toolInput({ workflow: { type: 'string', minLength: 1, maxLength: 255 } }, ['workflow']),
    annotations: readOnly
  }
].map((schema) => ({ ...schema, outputSchema: TOOL_OUTPUT_SCHEMA }));

function safeRunId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,19}$/.test(text)) throw new Error('runId must be a positive decimal identifier');
  return text;
}

function safeLimit(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be from 1 through 100');
  return String(limit);
}

function safeBranch(value = 'main') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /[\0\r\n]/.test(value)) throw new Error('branch is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value)) throw new Error('branch contains unsupported characters');
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) {
    throw new Error('branch is invalid');
  }
  return value;
}

function safeWorkflow(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new Error('workflow is invalid');
  }
  const numericId = /^[1-9][0-9]{0,19}$/.test(value);
  const safeName = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(value);
  const workflowPath = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.ya?ml$/i.test(value);
  if (!numericId && !safeName && !workflowPath) {
    throw new Error('workflow must be a numeric ID, a simple workflow name, or .github/workflows/FILE.yml');
  }
  return value;
}

function selectedRepository(value) {
  const repository = value ?? (cli.repositories.length === 1 ? cli.repositories[0] : undefined);
  if (typeof repository !== 'string' || !cli.repositories.includes(repository)) {
    throw new Error(`repository must be one of: ${cli.repositories.join(', ')}`);
  }
  return repository;
}

let executionDirectoryPromise;

async function executionDirectory() {
  const context = isolation.current();
  if (context) return context.base;
  executionDirectoryPromise ??= (async () => {
    const cwd = await realpath(process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error('The configured cwd is not a directory');
    return cwd;
  })();
  return executionDirectoryPromise;
}

function commandDescription(args) {
  return JSON.stringify(['gh', ...args]);
}

export async function runGh(args) {
  const cwd = await executionDirectory();
  return new Promise((resolvePromise, reject) => {
    const environment = {
      ...environmentWithoutBundledIsolationKey(),
      GH_PAGER: '',
      GH_PROMPT_DISABLED: '1',
      NO_COLOR: '1',
      PAGER: ''
    };
    delete environment.GH_FORCE_TTY;
    const child = spawn('gh', args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment
    });
    const stdout = [];
    const stderr = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolvePromise(value);
    };
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error(`gh output exceeded ${MAX_OUTPUT_BYTES} bytes for ${commandDescription(args)}`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => finish(new Error(`Unable to start gh for ${commandDescription(args)}: ${error.message}`)));
    child.once('close', (code, signal) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        const detail = err.trim() || out.trim() || `gh exited with code ${code}${signal ? ` after signal ${signal}` : ''}`;
        finish(new Error(`${commandDescription(args)} failed: ${detail}`));
        return;
      }
      const repositoryIndex = args.indexOf('--repo');
      const repository = repositoryIndex >= 0 ? args[repositoryIndex + 1] : undefined;
      finish(null, { cwd, repository, command: ['gh', ...args], stdout: out, stderr: err, exitCode: code });
    });
  });
}

function commandForTool(name, args = {}) {
  const repository = selectedRepository(args.repository);
  switch (name) {
    case 'list_runs':
      return ['run', 'list', '--repo', repository, '--branch', safeBranch(args.branch ?? 'main'), '--limit', safeLimit(args.limit, 3)];
    case 'watch_run':
      return ['run', 'watch', safeRunId(args.runId), '--repo', repository, '--exit-status'];
    case 'cancel_run':
      return ['run', 'cancel', safeRunId(args.runId), '--repo', repository];
    case 'view_run':
      return ['run', 'view', safeRunId(args.runId), '--repo', repository];
    case 'view_run_jobs':
      return ['run', 'view', safeRunId(args.runId), '--repo', repository, '--json', 'jobs'];
    case 'view_run_logs':
      return ['run', 'view', safeRunId(args.runId), '--repo', repository, '--log'];
    case 'view_failed_logs':
      return ['run', 'view', safeRunId(args.runId), '--repo', repository, '--log-failed'];
    case 'list_workflows': {
      const command = ['workflow', 'list', '--repo', repository, '--limit', safeLimit(args.limit, 50)];
      if (args.includeDisabled === true) command.push('--all');
      return command;
    }
    case 'view_workflow':
      return ['workflow', 'view', safeWorkflow(args.workflow), '--repo', repository];
    case 'view_workflow_yaml':
      return ['workflow', 'view', safeWorkflow(args.workflow), '--repo', repository, '--yaml'];
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callTool(name, args, execute) {
  return execute(commandForTool(name, args));
}

export function createServer(options = {}) {
  const execute = options.execute ?? runGh;
  let initialized = false;
  return async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'initialize') {
      initialized = true;
      return response(request.id, {
        protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'gh-workflow', version: '1.2.0' },
        instructions: `GitHub Actions inspection and explicit run cancellation for this repository allowlist: ${cli.repositories.join(', ')}. No shell, arbitrary gh arguments, workflow dispatch, rerun, delete, artifact download, or other repository mutation.`
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const result = await isolation.run(
          request.params?.arguments ?? {},
          (toolArguments) => callTool(request.params?.name, toolArguments, execute)
        );
        return response(request.id, toolResult({ ok: true, result }));
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
      });
    }
  });
}

if (directExecution) {
  if (cli.help) process.stdout.write(GH_WORKFLOW_MCP_HELP);
  else await startStdio();
}
