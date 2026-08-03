import { spawn } from 'node:child_process';
import { repositoryRoot } from '../../app/server-config.mjs';
import { assertNotElevatedWindows } from '../../app/windows-integrity.mjs';

await assertNotElevatedWindows();

await new Promise((resolvePromise, reject) => {
  const child = spawn('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    shell: false
  });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`git config exited with ${code}`)));
});
process.stdout.write('Enabled repository hooks from .githooks.\n');
