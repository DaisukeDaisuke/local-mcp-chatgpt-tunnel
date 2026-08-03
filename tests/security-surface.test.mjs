import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('compose publishes no host ports and Chrome stays on loopback', async () => {
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /^\s*ports\s*:/m);
  const launcher = await readFile(new URL('../mcp/dq9-test/src/cdp/browser-launcher.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /--headless=new/);
  assert.match(launcher, /--remote-debugging-address=127\.0\.0\.1/);
  assert.doesNotMatch(launcher, /--no-sandbox/);
});

test('arbitrary host and Ghidra script execution tools are absent', async () => {
  const filesServer = await readFile(new URL('../mcp/safe-files/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(filesServer, /name:\s*['"](?:execute|start_command|without_sandbox)['"]/);
  const ghidra = await readFile(new URL('../mcp/ghidra/bridge_mcp_ghidra.py', import.meta.url), 'utf8');
  assert.match(ghidra, /Suppressing arbitrary-code Ghidra tool/);
  assert.match(ghidra, /run_ghidra_script/);
  assert.match(ghidra, /run_script_inline/);
});
