import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDefaultCommands, runDoctor } from '../app/doctor.mjs';

function fakeSpawn(results, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
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
  assert.deepEqual(calls.map(({ command }) => command), ['node', 'npm', 'git', 'rg', 'py']);
  assert.equal(results.filter((result) => !result.ok).length, 2);
  assert.match(text, /FAIL  rg: not found in PATH/);
  assert.match(text, /FAIL  py: bad python/);
  assert.match(text, /summary: rg, py need installation or PATH repair/);
});

test('Windows npm check runs through ComSpec instead of spawning npm.cmd directly', () => {
  const commands = createDefaultCommands({
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  });
  const npm = commands.find(({ name }) => name === 'npm');
  assert.deepEqual(npm, {
    name: 'npm',
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'npm --version']
  });
});

test('doctor reports the spawn error code and continues checking other commands', async () => {
  const calls = [];
  let text = '';
  const commands = [
    { name: 'npm', command: 'npm.cmd', args: ['--version'] },
    { name: 'git', command: 'git', args: ['--version'] }
  ];
  const results = await runDoctor({
    commands,
    spawnImpl: fakeSpawn({ 'npm.cmd': { error: 'spawn EINVAL', code: 'EINVAL' } }, calls),
    output: { write: (chunk) => { text += chunk; } }
  });
  assert.deepEqual(calls.map(({ command }) => command), ['npm.cmd', 'git']);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  assert.match(text, /FAIL  npm: spawn failed \(EINVAL\): spawn EINVAL/);
  assert.match(text, /OK  git:/);
});
