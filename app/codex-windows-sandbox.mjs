import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep, win32 } from 'node:path';
import { codexAppServerInternals } from './codex-app-server.mjs';

const CODEX_PERMISSION_PROFILE_ID = 'local_mcp_gateway';
const SANITIZED_CHILD_ENVIRONMENT_OVERRIDE = "shell_environment_policy={inherit='all',ignore_default_excludes=true,exclude=[],set={},include_only=[],use_profile=false}";

function within(root, candidate) {
  const path = win32.relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${win32.sep}`) && !win32.isAbsolute(path));
}

async function canonicalRegularFile(path, label) {
  const info = await lstat(path);
  const actual = await realpath(path);
  const actualInfo = info.isSymbolicLink() ? await stat(actual) : info;
  if (!actualInfo.isFile()) throw new Error(`${label} must point to a regular file`);
  return actual;
}

function windowsSandboxOverride(mode) {
  if (mode !== 'elevated' && mode !== 'unelevated') {
    throw new Error(`unsupported Windows Codex sandbox mode: ${mode}`);
  }
  return `windows.sandbox='${mode}'`;
}

function commandInterpreterFor(env) {
  const configuredInterpreter = env.ComSpec || env.COMSPEC;
  if (configuredInterpreter && win32.isAbsolute(configuredInterpreter)) return configuredInterpreter;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return win32.join(systemRoot, 'System32', 'cmd.exe');
}

function renderCmdArgument(argument) {
  const text = String(argument);
  if (/[\r\n"%^]/.test(text)) {
    throw new Error('Codex .cmd launch arguments contain characters that cannot be passed safely through cmd.exe');
  }
  return `"${text}"`;
}

export function codexWindowsSandboxLaunchSpec(codexExecutable, config, childEnvironment, { env = childEnvironment } = {}) {
  if (typeof codexExecutable !== 'string' || !win32.isAbsolute(codexExecutable)) {
    throw new Error('codexExecutable must be an absolute Windows path');
  }
  if (!config?.cwd || !win32.isAbsolute(config.cwd)) {
    throw new Error(`${config?.name ?? 'MCP'} cwd must be an absolute Windows path for Codex sandbox`);
  }

  const permissionProfileOverride = codexAppServerInternals.permissionProfileOverrideFor(config);
  const sandboxArgs = [
    '-c', permissionProfileOverride,
    '-c', windowsSandboxOverride(config.sandbox),
    '-c', SANITIZED_CHILD_ENVIRONMENT_OVERRIDE,
    'sandbox',
    '--permission-profile', CODEX_PERMISSION_PROFILE_ID,
    '-C', config.cwd,
    '--',
    config.command,
    ...(config.args ?? [])
  ];
  const options = {
    cwd: config.cwd,
    env: childEnvironment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  };

  if (/\.(?:cmd|bat)$/i.test(codexExecutable)) {
    const commandLine = [codexExecutable, ...sandboxArgs].map(renderCmdArgument).join(' ');
    return {
      command: commandInterpreterFor(env),
      args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
      options: { ...options, windowsVerbatimArguments: true }
    };
  }

  return { command: codexExecutable, args: sandboxArgs, options };
}

function spawnCodexWindowsSandbox(codexExecutable, config, childEnvironment) {
  const launch = codexWindowsSandboxLaunchSpec(codexExecutable, config, childEnvironment);
  return spawn(launch.command, launch.args, launch.options);
}

export class CodexWindowsSandboxedProcess {
  constructor(config, {
    env,
    onStdout,
    onStderr,
    onExit,
    onFailure,
    stderr = process.stderr,
    spawnSandbox = spawnCodexWindowsSandbox,
    canonicalize = canonicalRegularFile
  } = {}) {
    this.config = config;
    this.env = env ?? process.env;
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.onFailure = onFailure;
    this.stderr = stderr;
    this.spawnSandbox = spawnSandbox;
    this.canonicalize = canonicalize;
    this.child = null;
    this.closed = false;
    this.ready = false;
  }

  get writable() {
    return this.ready && !this.closed && Boolean(this.child?.stdin?.writable);
  }

  async start() {
    if (this.ready) return;
    const codexExecutable = await this.canonicalize(this.config.codexExecutable, 'codexExecutable');
    const command = this.config.sandbox === 'elevated'
      ? await this.canonicalize(this.config.command, `${this.config.name} command`)
      : this.config.command;
    const roots = this.config.allowedDirectories ?? [];
    if (roots.some((root) => within(root, codexExecutable))) {
      throw new Error(`${this.config.name} codexExecutable resolves inside a writable sandbox root`);
    }
    if (this.config.sandbox === 'elevated' && roots.some((root) => within(root, command))) {
      throw new Error(`${this.config.name} command resolves inside a writable sandbox root`);
    }

    const executionConfig = { ...this.config, command };
    this.child = this.spawnSandbox(codexExecutable, executionConfig, this.env);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout?.(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.#writeStderr(chunk));
    this.child.once('error', (error) => this.#fail(error));
    this.child.once('exit', (code, signal) => {
      this.ready = false;
      if (!this.closed) this.onExit?.(code, signal);
    });
    this.ready = true;
  }

  write(chunk) {
    if (!this.writable) throw new Error(`${this.config.name} sandboxed process is not ready`);
    this.child.stdin.write(String(chunk));
  }

  async closeStdin() {
    if (!this.child?.stdin?.writable) return;
    await new Promise((resolvePromise) => this.child.stdin.end(resolvePromise));
  }

  async close() {
    this.closed = true;
    this.ready = false;
    if (!this.child) return;
    if (this.child.stdin?.writable) this.child.stdin.end();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  #writeStderr(chunk) {
    if (this.onStderr) this.onStderr(chunk);
    else this.stderr.write(`[${this.config.name}:codex-sandbox] ${String(chunk)}`);
  }

  #fail(error) {
    this.ready = false;
    if (!this.closed) this.onFailure?.(error);
  }
}

export const codexWindowsSandboxInternals = {
  SANITIZED_CHILD_ENVIRONMENT_OVERRIDE,
  windowsSandboxOverride
};