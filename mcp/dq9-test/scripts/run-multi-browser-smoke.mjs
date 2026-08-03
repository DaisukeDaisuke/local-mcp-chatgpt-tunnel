import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserLauncher } from '../src/cdp/browser-launcher.mjs';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const artifactRoot = resolve(fileURLToPath(new URL('../../agent_work/20260802-071718-dq9-mcp-foundation/node-cdp-foundation/multi-browser-smoke', import.meta.url)));
const runDirectory = resolve(artifactRoot, `run-${Date.now()}-${process.pid}-${randomUUID()}`);
const timeoutMs = 30000;
const defaultHoldMs = 30000;
const maximumHoldMs = 60000;
const report = (message) => process.stderr.write(`[multi-browser] ${message}\n`);
const withDeadline = (label, operation, limitMs = timeoutMs) => new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), limitMs);
  operation.then(resolvePromise, reject).finally(() => clearTimeout(timer));
});
export const parseHoldMs = (argumentsList) => {
  if (argumentsList.length === 0) return defaultHoldMs;
  if (argumentsList.length !== 2 || argumentsList[0] !== '--hold-ms' || !/^[0-9]+$/.test(argumentsList[1])) {
    throw new Error('Usage: node scripts/run-multi-browser-smoke.mjs [--hold-ms <integer 1000-60000>]');
  }
  const holdMs = Number(argumentsList[1]);
  if (!Number.isSafeInteger(holdMs) || holdMs < 1000 || holdMs > maximumHoldMs) {
    throw new Error('hold-ms must be an integer between 1000 and 60000');
  }
  return holdMs;
};
const allocatePort = () => new Promise((resolvePromise, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolvePromise(port));
  });
});
const endpoint = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`CDP endpoint ${port} returned ${response.status}`);
  const details = await response.json();
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  if (!details.webSocketDebuggerUrl || !pages.some((page) => page.type === 'page' && page.url === 'about:blank')) throw new Error(`CDP endpoint ${port} did not expose about:blank`);
  return { port, browser: details.Browser, pageCount: pages.length };
};
const waitForEndpoint = async (port) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await endpoint(port); } catch (error) { lastError = error; await new Promise((resolvePromise) => setTimeout(resolvePromise, 150)); }
  }
  throw lastError ?? new Error(`CDP endpoint ${port} did not start`);
};
const waitForExit = (ownedBrowser) => new Promise((resolvePromise, reject) => {
  if (ownedBrowser.child.exitCode !== null) return resolvePromise();
  const timer = setTimeout(() => reject(new Error(`Chrome PID ${ownedBrowser.child.pid} did not exit`)), timeoutMs);
  ownedBrowser.child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
  ownedBrowser.child.once('error', (error) => { clearTimeout(timer); reject(error); });
});
const expectUnavailable = async (port) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await endpoint(port); await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); }
    catch { return; }
  }
  throw new Error(`Stopped CDP endpoint ${port} still responded`);
};
export const soakEndpoints = async ({ ports, holdMs, pollMs = 500, probe, sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)), now = () => Date.now(), onProgress = () => {} }) => {
  const startedAt = now();
  const deadline = startedAt + holdMs;
  let nextProgressAt = startedAt;
  while (true) {
    await Promise.all(ports.map(probe));
    const current = now();
    if (current >= nextProgressAt) {
      onProgress(Math.min(current - startedAt, holdMs));
      nextProgressAt += 5000;
    }
    if (current >= deadline) return;
    await sleep(Math.min(pollMs, deadline - current));
  }
};

export async function runSmoke(argumentsList = process.argv.slice(2)) {
  const holdMs = parseHoldMs(argumentsList);
  const remainingHoldMs = Math.max(1000, Math.floor(holdMs / 3));
  const overallDeadline = Date.now() + holdMs + remainingHoldMs + 90000;
  const bounded = (label, operation, limitMs = timeoutMs) => withDeadline(label, operation, Math.min(limitMs, Math.max(1, overallDeadline - Date.now())));
  const launcher = new BrowserLauncher();
  const owned = [];
  let cleanupStarted = false;
  let exitCode = 0;
  try {
    await mkdir(artifactRoot, { recursive: true });
    await mkdir(runDirectory, { recursive: false });
    const ports = await Promise.all(Array.from({ length: 5 }, allocatePort));
    if (new Set(ports).size !== 5) throw new Error('Ephemeral port allocation was not unique');
    report(`launching five owned Chrome processes; five-live hold=${holdMs}ms; four-live hold=${remainingHoldMs}ms`);
    const launchOne = (cdpPort, index) => launcher.launch({ chromePath, runtimeDirectory: runDirectory, profileDirectory: resolve(runDirectory, `profile-${index + 1}`), cdpPort, url: 'about:blank' }).then(async (item) => {
      if (cleanupStarted) await launcher.stop(item);
      else owned.push(item);
      return item;
    });
    const launched = await bounded('concurrent launch', Promise.all(ports.map(launchOne)));
    if (launched.length !== 5) throw new Error('Expected five Chrome launch results');
    const before = await bounded('endpoint verification', Promise.all(owned.map((item) => waitForEndpoint(item.cdpPort))));
    if (new Set(before.map((item) => item.port)).size !== 5 || new Set(owned.map((item) => item.child.pid)).size !== 5 || new Set(owned.map((item) => item.profileDirectory)).size !== 5) throw new Error('Browser identity was not unique');
    await bounded('five-live soak', soakEndpoints({ ports: owned.map((item) => item.cdpPort), holdMs, probe: endpoint, onProgress: (elapsed) => report(`five-live endpoints healthy elapsed=${elapsed}ms`) }), holdMs + 1000);
    await launcher.stop(owned[0]);
    await bounded('first browser exit', waitForExit(owned[0]));
    await bounded('stopped endpoint verification', expectUnavailable(owned[0].cdpPort), 6000);
    const remaining = owned.slice(1).map((item) => item.cdpPort);
    await bounded('remaining endpoint verification', Promise.all(remaining.map(waitForEndpoint)));
    await bounded('four-live soak', soakEndpoints({ ports: remaining, holdMs: remainingHoldMs, probe: endpoint, onProgress: (elapsed) => report(`four-live endpoints healthy elapsed=${elapsed}ms`) }), remainingHoldMs + 1000);
    report(`one owned stop left four endpoints available; run=${runDirectory}; ports=${owned.map((item) => item.cdpPort).join(',')}; pids=${owned.map((item) => item.child.pid).join(',')}; profiles=${owned.map((item) => item.profileDirectory).join('|')}`);
  } catch (error) {
    exitCode = 1;
    report(`error ${error.message}`);
  } finally {
    cleanupStarted = true;
    await Promise.allSettled(owned.map((item) => launcher.stop(item)));
    await Promise.allSettled(owned.map(waitForExit));
    report('owned cleanup complete');
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runSmoke();
