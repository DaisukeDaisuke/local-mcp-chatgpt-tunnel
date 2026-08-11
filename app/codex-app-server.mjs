import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentWithoutBundledIsolationKey } from './bundled-isolation.mjs';

const DEFAULT_APP_SERVER_STARTUP_TIMEOUT_MS = Number(process.env.CODEX_APP_SERVER_STARTUP_TIMEOUT_MS ?? 30_000);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryAppRoot = resolve(repositoryRoot, 'app');

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function canonicalRegularFile(path, label) {
  const info = await lstat(path);
  const actual = await realpath(path);
  const actualInfo = info.isSymbolicLink() ? await stat(actual) : info;
  if (!actualInfo.isFile()) throw new Error(`${label} must point to a regular file`);
  return actual;
}

function codexAppServerLaunchSpec(codexExecutable, cwd, { platform = process.platform, env = process.env } = {}) {
  if (typeof codexExecutable !== 'string') {
    throw new Error('codexExecutable must be an absolute path');
  }
  const pathIsAbsolute = platform === 'win32' ? win32.isAbsolute(codexExecutable) : isAbsolute(codexExecutable);
  if (!pathIsAbsolute) {
    throw new Error('codexExecutable must be an absolute path');
  }
  const options = {
    cwd,
    env: environmentWithoutBundledIsolationKey(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  };
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(codexExecutable)) {
    const configuredInterpreter = env.ComSpec || env.COMSPEC;
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    const commandInterpreter = configuredInterpreter && win32.isAbsolute(configuredInterpreter)
      ? configuredInterpreter
      : win32.join(systemRoot, 'System32', 'cmd.exe');
    return {
      command: commandInterpreter,
      args: ['/d', '/v:off', '/s', '/c', `""${codexExecutable}" app-server --listen stdio://"`],
      options: { ...options, windowsVerbatimArguments: true }
    };
  }
  return { command: codexExecutable, args: ['app-server', '--listen', 'stdio://'], options };
}

function spawnCodexAppServer(codexExecutable, cwd) {
  const launch = codexAppServerLaunchSpec(codexExecutable, cwd);
  return spawn(launch.command, launch.args, launch.options);
}

function sandboxPolicyFor(config) {
  const writableRoots = [...new Set(config.allowedDirectories ?? [])];
  const executableName = typeof config.command === 'string' ? basename(config.command).toLowerCase() : '';
  const interpreterEntryDirectory = [
    'node', 'node.exe', 'python', 'python.exe', 'python3', 'python3.exe', 'php', 'php.exe'
  ].includes(executableName) && typeof config.args?.[0] === 'string' && isAbsolute(config.args[0])
    ? dirname(config.args[0])
    : null;
  const readableRoots = [...new Set([
    ...writableRoots,
    ...(config.allowedFiles ?? []),
    ...(config.sandboxReadOnlyDirectories ?? []),
    ...(typeof config.command === 'string' && isAbsolute(config.command) ? [dirname(config.command)] : []),
    ...(interpreterEntryDirectory ? [interpreterEntryDirectory] : []),
    ...(config.isBundled ? [repositoryAppRoot] : [])
  ])];
  return {
    type: 'workspaceWrite',
    writableRoots,
    readOnlyAccess: {
      type: 'restricted',
      includePlatformDefaults: true,
      readableRoots
    },
    networkAccess: false
  };
}

export class CodexAppServerSandboxedProcess {
  constructor(config, { env, onStdout, onStderr, onExit, onFailure, stderr = process.stderr, spawnAppServer = spawnCodexAppServer } = {}) {
    this.config = config;
    this.env = env ?? {};
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.onFailure = onFailure;
    this.stderr = stderr;
    this.spawnAppServer = spawnAppServer;
    this.appServer = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.writeQueue = Promise.resolve();
    this.processId = `mcp-${config.name}-${randomUUID()}`;
    this.processPromise = null;
    this.closed = false;
    this.ready = false;
    this.exitReported = false;
    this.failureReported = false;
    this.decodersFlushed = false;
    this.sawStdoutDelta = false;
    this.sawStderrDelta = false;
    this.notifiedExit = null;
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    this.exitPromise = new Promise((resolveExit, rejectExit) => {
      this.resolveExit = resolveExit;
      this.rejectExit = rejectExit;
    });
    void this.exitPromise.catch(() => {});
  }

  get writable() {
    return this.ready && !this.notifiedExit && !this.closed && Boolean(this.appServer?.stdin?.writable);
  }

  async start() {
    if (this.ready) return;
    const codexExecutable = await canonicalRegularFile(this.config.codexExecutable, 'codexExecutable');
    const command = this.config.sandbox === 'elevated'
      ? await canonicalRegularFile(this.config.command, `${this.config.name} command`)
      : this.config.command;
    if (this.config.sandbox !== 'never') {
      const roots = this.config.allowedDirectories ?? [];
      if (roots.some((root) => within(root, codexExecutable))) {
        throw new Error(`${this.config.name} codexExecutable resolves inside a writable sandbox root`);
      }
      if (this.config.sandbox === 'elevated' && roots.some((root) => within(root, command))) {
        throw new Error(`${this.config.name} command resolves inside a writable sandbox root`);
      }
    }
    const executionConfig = { ...this.config, command };
    this.appServer = this.spawnAppServer(codexExecutable, this.config.cwd);
    this.appServer.stdout.setEncoding('utf8');
    this.appServer.stdout.on('data', (chunk) => this.#accept(chunk));
    this.appServer.stderr.setEncoding('utf8');
    this.appServer.stderr.on('data', (chunk) => this.#writeStderr(chunk));
    this.appServer.once('error', (error) => this.#fatal(error));
    this.appServer.once('exit', (code, signal) => {
      if (!this.closed) this.#fatal(new Error(`${this.config.name} codex app-server exited (${signal ?? code ?? 'unknown'})`));
    });

    await this.#request('initialize', {
      clientInfo: { name: 'local-mcp-gateway', version: '0.6.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'thread/status/changed',
          'fs/changed',
          'skills/changed'
        ]
      }
    }, this.config.startupTimeoutMs ?? DEFAULT_APP_SERVER_STARTUP_TIMEOUT_MS);
    this.#notify('initialized', {});

    if (process.platform === 'win32' && this.config.sandbox !== 'never') {
      await this.#request('windowsSandbox/setupStart', { mode: this.config.sandbox }, this.config.startupTimeoutMs ?? DEFAULT_APP_SERVER_STARTUP_TIMEOUT_MS);
    }

    const commandParams = {
      command: [command, ...(this.config.args ?? [])],
      cwd: this.config.cwd,
      env: { ...this.env, LOCAL_MCP_CODEX_SANDBOX_MODE: this.config.sandbox },
      sandboxPolicy: sandboxPolicyFor(executionConfig),
      processId: this.processId,
      streamStdoutStderr: true
    };
    if (Number.isSafeInteger(this.config.commandTimeoutMs) && this.config.commandTimeoutMs > 0) {
      commandParams.timeoutMs = this.config.commandTimeoutMs;
    }
    this.processPromise = this.#request('command/exec', commandParams, null).then((result) => {
      if (!this.sawStdoutDelta && typeof result?.stdout === 'string' && result.stdout.length > 0) this.onStdout?.(result.stdout);
      if (!this.sawStderrDelta && typeof result?.stderr === 'string' && result.stderr.length > 0) this.onStderr?.(result.stderr);
      const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : this.notifiedExit?.exitCode ?? null;
      this.#markExited(exitCode, this.notifiedExit?.signal ?? null);
      return result;
    }).catch((error) => {
      if (!this.closed) this.#fatal(error);
      return undefined;
    });
    this.ready = true;
  }

  waitForExit() {
    return this.exitPromise;
  }

  write(chunk) {
    if (!this.writable) throw new Error(`${this.config.name} sandboxed process is not ready`);
    const deltaBase64 = Buffer.from(chunk, 'utf8').toString('base64');
    void this.#enqueueWrite({ processId: this.processId, deltaBase64 }, this.config.requestTimeoutMs).catch(() => {});
  }

  async closeStdin(timeoutMs = 5_000) {
    if (this.notifiedExit) return;
    if (!this.writable) throw new Error(`${this.config.name} sandboxed process is not ready`);
    await this.#enqueueWrite({ processId: this.processId, closeStdin: true }, timeoutMs);
  }

  async close() {
    this.closed = true;
    if (!this.appServer) return;
    await this.#request('command/exec/write', { processId: this.processId, closeStdin: true }, 5_000).catch(() => {});
    await this.#request('command/exec/terminate', { processId: this.processId }, 5_000).catch(() => {});
    this.appServer.stdin.end();
    if (this.appServer.exitCode === null && !this.appServer.killed) this.appServer.kill();
    this.#failAll(new Error(`${this.config.name} closed`));
    if (!this.exitReported && !this.failureReported) this.rejectExit(new Error(`${this.config.name} closed`));
  }

  #request(method, params = {}, timeoutMs = DEFAULT_APP_SERVER_STARTUP_TIMEOUT_MS) {
    if (!this.appServer?.stdin?.writable) return Promise.reject(new Error(`${this.config.name} codex app-server is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.name} codex app-server timed out handling ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.appServer.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  #enqueueWrite(params, timeoutMs) {
    const operation = this.writeQueue.then(() => {
      if (!this.appServer?.stdin?.writable || this.closed) throw new Error(`${this.config.name} codex app-server is not writable`);
      return this.#request('command/exec/write', params, timeoutMs);
    });
    this.writeQueue = operation.catch((error) => {
      this.#fatal(error);
      throw error;
    });
    void this.writeQueue.catch(() => {});
    return operation;
  }

  #notify(method, params = {}) {
    if (this.appServer?.stdin?.writable) this.appServer.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #accept(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.#writeStderr(`invalid JSON on codex app-server stdout: ${line}\n`); continue; }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (message && Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${this.config.name} codex app-server: ${message.error.message ?? 'error'}`));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method === 'command/exec/outputDelta') {
      const params = message.params ?? {};
      if (params.processId !== this.processId) return;
      const bytes = Buffer.from(String(params.deltaBase64 ?? ''), 'base64');
      if (params.stream === 'stderr') {
        this.sawStderrDelta = true;
        const text = this.stderrDecoder.write(bytes);
        if (text) this.onStderr?.(text);
      } else {
        this.sawStdoutDelta = true;
        const text = this.stdoutDecoder.write(bytes);
        if (text) this.onStdout?.(text);
      }
      return;
    }
    if (message?.method === 'command/exec/exited') {
      const params = message.params ?? {};
      if (params.processId === this.processId) {
        this.notifiedExit = { exitCode: params.exitCode ?? null, signal: null };
      }
      return;
    }
    if (message?.method === 'windowsSandbox/setupCompleted') {
      this.#writeStderr(`windows sandbox setup completed: ${JSON.stringify(message.params ?? {})}\n`);
    }
  }

  #writeStderr(chunk) {
    const prefix = `[${this.config.name}:codex] `;
    for (const line of String(chunk).split(/(?<=\n)/)) {
      if (line) this.stderr.write(`${prefix}${line}`);
    }
  }

  #flushDecoders() {
    if (this.decodersFlushed) return;
    this.decodersFlushed = true;
    const stdoutTail = this.stdoutDecoder.end();
    const stderrTail = this.stderrDecoder.end();
    if (stdoutTail) this.onStdout?.(stdoutTail);
    if (stderrTail) this.onStderr?.(stderrTail);
  }

  #markExited(code, signal) {
    if (this.exitReported || this.failureReported) return;
    this.exitReported = true;
    this.ready = false;
    this.#flushDecoders();
    const result = { exitCode: code, signal };
    this.resolveExit(result);
    this.onExit?.(code, signal);
  }

  #fatal(error) {
    if (this.failureReported || this.closed) return;
    this.failureReported = true;
    this.ready = false;
    this.#flushDecoders();
    this.#failAll(error);
    if (!this.exitReported) this.rejectExit(error);
    this.onFailure?.(error);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const codexAppServerInternals = { codexAppServerLaunchSpec };
