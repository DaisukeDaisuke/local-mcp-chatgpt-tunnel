import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let executablePromise;

export function testGitExecutable() {
  executablePromise ??= (async () => {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await exec(locator, ['git']);
    const executable = stdout.trim().split(/\r?\n/)[0];
    if (!executable) throw new Error('Git executable was not found for tests');
    return executable;
  })();
  return executablePromise;
}
