import { spawn } from 'node:child_process';
import { isAbsolute, join, relative, sep } from 'node:path';
import { buildChildEnvironment } from './child-environment.mjs';
import { CodexAppServerSandboxedProcess } from './codex-app-server.mjs';
import { CodexWindowsSandboxedProcess } from './codex-windows-sandbox.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const STDIO_TAIL_LIMIT = 256 * 1024;

function pathInside(directory, candidate) {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function protectedPathsInsideConfiguredAccess(config, paths) {
  const allowedDirectories = config.allowedDirectories ?? [];
  const allowedFiles = config.allowedFiles ?? [];
  return paths.filter((candidate) =>
    allowedDirectories.some((directory) => pathInside(directory, candidate))
      || allowedFiles.some((file) => relative(file, candidate) === '')
  );
}

function codexSandboxLogHint(config, text) {
  if (!/setup refresh had errors/i.test(text)) return '';
  const codexHome = config.env?.CODEX_HOME
    ?? process.env.CODEX_HOME
    ?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.codex') : '');
  if (!codexHome) return '';
  const utcDate = new Date().toISOString().slice(0, 10);
  return `codex sandbox log: ${join(codexHome, '.sandbox', `sandbox.${utcDate}.log`)}`;
}

export class StdioMcpChild {
  constructor(config, { onToolsChanged, stderr = process.stderr } = {}) {
    this.config = config;
    this.onToolsChanged = onToolsChanged;
    this.stderr = stderr;
    this.child = null;
    this.sandboxedChild = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.closed = false;
    this.stdoutTail = '';
    this.stderrTail = '';
  }

  async start() {
    if (this.child || this.sandboxedChild) return;
    const { command, args = [], cwd, env = {} } = this.config;
    const protectedGatewayConfigPaths = this.config.dangerousAllowGatewayConfigAccess
      ? []
      : protectedPathsInsideConfiguredAccess(this.config, this.config.protectedGatewayConfigPaths ?? []);
    const protectedGatewayLogDirectories = this.config.protectedGatewayLogDirectories ?? [];
    const protectedGatewayLogFiles = this.config.protectedGatewayLogFiles ?? [];
    const disallowedDirectories = [...new Set([
      ...(this.config.disallowedDirectories ?? []),
      ...protectedGatewayLogDirectories
    ])];
    const disallowedFiles = [...new Set([
      ...(this.config.disallowedFiles ?? []),
      ...protectedGatewayConfigPaths,
      ...protectedGatewayLogFiles
    ])];
    const policyEnvironment = {
      LOCAL_MCP_ALLOWED_DIRECTORIES: JSON.stringify(this.config.allowedDirectories ?? []),
      LOCAL_MCP_ALLOWED_FILES: JSON.stringify(this.config.allowedFiles ?? []),
      LOCAL_MCP_DISALLOWED_DIRECTORIES: JSON.stringify(disallowedDirectories),
      LOCAL_MCP_DISALLOWED_FILES: JSON.stringify(disallowedFiles),
      LOCAL_MCP_DISALLOWED_PATH_GLOBS: JSON.stringify(this.config.disallowedPathGlobs ?? []),
      LOCAL_MCP_CODEX_SANDBOX_MODE: this.config.sandbox ?? 'never',
      ...(this.config.isBundled && this.config.gatewayIsolationKey
        ? { LOCAL_MCP_GATEWAY_ISOLATION_KEY: this.config.gatewayIsolationKey }
        : {}),
    };
    const childEnvironment = buildChildEnvironment({ ...env, ...policyEnvironment });
    if (this.config.sandbox && this.config.sandbox !== 'never' && !this.config.sandboxDelegated) {
      const SandboxedProcess = process.platform === 'win32'
        ? CodexWindowsSandboxedProcess
        : CodexAppServerSandboxedProcess;
      this.sandboxedChild = new SandboxedProcess(this.config, {
        env: childEnvironment,
        onStdout: (chunk) => this.accept(chunk),
        onStderr: (chunk) => this.writeStderr(chunk),
        onExit: (code, signal) => {
          if (!this.closed) this.failAll(this.exitError(code, signal));
        },
        onFailure: (error) => {
          if (!this.closed) this.failAll(this.withStderrTail(error));
        },
        stderr: this.stderr
      });
      await this.sandboxedChild.start();
    } else {
      this.child = spawn(command, args, {
        cwd,
        env: childEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => this.accept(chunk));
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk) => this.writeStderr(chunk));
      this.child.once('error', (error) => this.failAll(this.withStderrTail(error)));
      this.child.once('exit', (code, signal) => {
        if (!this.closed) this.failAll(this.exitError(code, signal));
      });
    }

    await this.request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'local-mcp-gateway', version: '0.6.0' }
    }, this.config.startupTimeoutMs);
    this.notify('notifications/initialized', {});
    await this.refreshTools();
  }

  async refreshTools() {
    const result = await this.request('tools/list', {});
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  request(method, params = {}, timeoutOverrideMs) {
    if (!this.isWritable()) return Promise.reject(new Error(`${this.config.name} is not running`));
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.name} timed out handling ${method}`));
      }, timeoutOverrideMs ?? this.config.requestTimeoutMs ?? 30 * 60 * 1000);
      this.pending.set(id, { resolve, reject, timeout });
      this.writeStdin(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.isWritable()) this.writeStdin(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close() {
    this.closed = true;
    if (this.sandboxedChild) await this.sandboxedChild.close();
    if (this.child) {
      this.child.stdin.end();
      if (this.child.exitCode === null && !this.child.killed) this.child.kill();
    }
    this.failAll(new Error(`${this.config.name} closed`));
  }

  isWritable() {
    return this.sandboxedChild ? this.sandboxedChild.writable : Boolean(this.child?.stdin?.writable);
  }

  writeStdin(chunk) {
    if (this.sandboxedChild) this.sandboxedChild.write(chunk);
    else this.child.stdin.write(chunk);
  }

  accept(chunk) {
    this.stdoutTail = `${this.stdoutTail}${String(chunk)}`.slice(-STDIO_TAIL_LIMIT);
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.writeStderr(`invalid JSON on stdout: ${line}\n`);
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message && Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${this.config.name}: ${message.error.message ?? 'MCP error'}`));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method === 'notifications/tools/list_changed') {
      void this.refreshTools().then(() => this.onToolsChanged?.(this)).catch((error) => this.writeStderr(`${error.message}\n`));
    }
  }

  writeStderr(chunk) {
    this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDIO_TAIL_LIMIT);
    const prefix = `[${this.config.name}] `;
    for (const line of String(chunk).split(/(?<=\n)/)) {
      if (line) this.stderr.write(`${prefix}${line}`);
    }
  }

  withStderrTail(error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout = this.stdoutTail.trim();
    const stderr = this.stderrTail.trim();
    const details = [
      ...(stdout ? [`stdout: ${stdout}`] : []),
      ...(stderr ? [`stderr: ${stderr}`] : []),
      ...(codexSandboxLogHint(this.config, `${message}\n${stdout}\n${stderr}`)
        ? [codexSandboxLogHint(this.config, `${message}\n${stdout}\n${stderr}`)]
        : [])
    ];
    return new Error(details.length > 0 ? `${message}; ${details.join('; ')}` : message);
  }

  exitError(code, signal) {
    return this.withStderrTail(new Error(`${this.config.name} exited (${signal ?? code ?? 'unknown'})`));
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
