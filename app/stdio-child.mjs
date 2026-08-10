import { spawn } from 'node:child_process';
import { buildChildEnvironment } from './child-environment.mjs';
import { CodexAppServerSandboxedProcess } from './codex-app-server.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

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
  }

  async start() {
    if (this.child || this.sandboxedChild) return;
    const { command, args = [], cwd, env = {} } = this.config;
    const protectedGatewayConfigPaths = this.config.dangerousAllowGatewayConfigAccess
      ? []
      : (this.config.protectedGatewayConfigPaths ?? []);
    const disallowedFiles = [...new Set([
      ...(this.config.disallowedFiles ?? []),
      ...protectedGatewayConfigPaths
    ])];
    const policyEnvironment = {
      LOCAL_MCP_ALLOWED_DIRECTORIES: JSON.stringify(this.config.allowedDirectories ?? []),
      LOCAL_MCP_ALLOWED_FILES: JSON.stringify(this.config.allowedFiles ?? []),
      LOCAL_MCP_DISALLOWED_DIRECTORIES: JSON.stringify(this.config.disallowedDirectories ?? []),
      LOCAL_MCP_DISALLOWED_FILES: JSON.stringify(disallowedFiles),
      LOCAL_MCP_DISALLOWED_PATH_GLOBS: JSON.stringify(this.config.disallowedPathGlobs ?? []),
      ...(this.config.isBundled && this.config.gatewayIsolationKey
        ? { LOCAL_MCP_GATEWAY_ISOLATION_KEY: this.config.gatewayIsolationKey }
        : {}),
      ...(this.config.sandboxDelegated && this.config.sandbox !== 'never'
        ? {
            LOCAL_MCP_CODEX_SANDBOX_MODE: this.config.sandbox,
            LOCAL_MCP_CODEX_EXECUTABLE: this.config.codexExecutable
          }
        : {})
    };
    const childEnvironment = buildChildEnvironment({ ...env, ...policyEnvironment });
    if (this.config.sandbox && this.config.sandbox !== 'never' && !this.config.sandboxDelegated) {
      this.sandboxedChild = new CodexAppServerSandboxedProcess(this.config, {
        env: childEnvironment,
        onStdout: (chunk) => this.accept(chunk),
        onStderr: (chunk) => this.writeStderr(chunk),
        onExit: (code, signal) => {
          if (!this.closed) this.failAll(new Error(`${this.config.name} exited (${signal ?? code ?? 'unknown'})`));
        },
        onFailure: (error) => {
          if (!this.closed) this.failAll(error);
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
      this.child.once('error', (error) => this.failAll(error));
      this.child.once('exit', (code, signal) => {
        if (!this.closed) this.failAll(new Error(`${this.config.name} exited (${signal ?? code ?? 'unknown'})`));
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
    const prefix = `[${this.config.name}] `;
    for (const line of String(chunk).split(/(?<=\n)/)) {
      if (line) this.stderr.write(`${prefix}${line}`);
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
