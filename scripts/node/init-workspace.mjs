import { constants } from 'node:fs';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot } from '../../app/server-config.mjs';
import { assertNotElevatedWindows } from '../../app/windows-integrity.mjs';

await assertNotElevatedWindows();

async function copyIfMissing(source, destination) {
  try {
    await access(destination, constants.F_OK);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await copyFile(source, destination);
  }
}

const workspace = join(repositoryRoot, 'workspace');
await mkdir(workspace, { recursive: true });
await mkdir(join(repositoryRoot, '.runtime'), { recursive: true });
await copyIfMissing(join(repositoryRoot, 'config', 'gateway.example.json'), join(repositoryRoot, 'config', 'gateway.json'));
await copyIfMissing(join(repositoryRoot, 'config', 'dq9-runtime.example.json'), join(repositoryRoot, 'config', 'dq9-runtime.json'));
try {
  await writeFile(join(workspace, '.chatgpt-local-mcp-root'), 'This marker explicitly allows local MCP file access below this directory.\n', { encoding: 'utf8', flag: 'wx' });
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}
process.stdout.write(`Initialized local configuration and marked workspace: ${workspace}\n`);
