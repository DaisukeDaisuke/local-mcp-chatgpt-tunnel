import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runDoctor } from '../app/doctor.mjs';

function fakeSpawn(results, calls) {
  return (command) => {
    calls.push(command);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    queueMicrotask(() => {
      const result = results[command];
      if (result?.error) child.emit('error', Object.assign(new Error(result.error), { code: result.code }));
      else {
        child.stdout.emit('data', result?.output ?? `${command} version\n`);
        child.emit('exit', result?.exitCode ?? 0);
      }
    });
    return child;
  };
}

test('doctor checks every command and reports all failures at the end', async () => {
  const calls = [];
  let text = '';
  const commands = ['node', 'npm', 'git', 'rg', 'py'].map((name) => ({ name, command: name, args: ['--version'] }));
  const results = await runDoctor({
    commands,
    spawnImpl: fakeSpawn({ rg: { error: 'missing', code: 'ENOENT' }, py: { exitCode: 1, output: 'bad python\n' } }, calls),
    output: { write: (chunk) => { text += chunk; } }
  });
  assert.deepEqual(calls, ['node', 'npm', 'git', 'rg', 'py']);
  assert.equal(results.filter((result) => !result.ok).length, 2);
  assert.match(text, /FAIL  rg: not found in PATH/);
  assert.match(text, /FAIL  py: bad python/);
  assert.match(text, /summary: rg, py need installation or PATH repair/);
});