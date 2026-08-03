import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { repositoryRoot } from '../../app/server-config.mjs';
import { assertNotElevatedWindows } from '../../app/windows-integrity.mjs';

const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64';
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'local-mcp-chatgpt-tunnel-installer' };
const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;

async function fetchBytes(url, maximumBytes) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error(`Download exceeds ${maximumBytes} bytes: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error(`Download exceeds ${maximumBytes} bytes: ${url}`);
  return bytes;
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function capture(command, args, maximumBytes = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolvePromise(value);
    };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        child.kill();
        finish(new Error(`${command} output exceeded ${maximumBytes} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (code !== 0) {
        finish(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with ${code}`));
        return;
      }
      finish(null, Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function assertSafeArchive(zipPath) {
  const listing = await capture('tar', ['-tf', zipPath]);
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error('Downloaded archive is empty');
  if (entries.length > 1000) throw new Error('Downloaded archive contains an unexpected number of entries');
  for (const original of entries) {
    const path = original.replaceAll('\\', '/');
    const parts = path.split('/').filter((part) => part !== '' && part !== '.');
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || parts.includes('..') || path.includes('\0')) {
      throw new Error(`Unsafe archive path: ${original}`);
    }
  }
  const verbose = await capture('tar', ['-tvf', zipPath], 2 * 1024 * 1024);
  for (const line of verbose.split(/\r?\n/).filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) throw new Error('Archive contains a link or unsupported entry type');
  }
}

async function assertSafeExtracted(directory) {
  let files = 0;
  let bytes = 0;
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      files += 1;
      if (files > 1000) throw new Error('Extracted archive contains an unexpected number of entries');
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Unsupported extracted entry: ${entry.name}`);
      if (info.isDirectory()) await visit(path);
      else {
        bytes += info.size;
        if (bytes > MAX_EXTRACTED_BYTES) throw new Error(`Extracted archive exceeds ${MAX_EXTRACTED_BYTES} bytes`);
      }
    }
  };
  await visit(directory);
}

async function findExecutable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutable(path);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === 'tunnel-client.exe') return path;
  }
  return null;
}

if (process.platform !== 'win32') throw new Error('This downloader installs the Windows tunnel client and must be run on Windows');
await assertNotElevatedWindows();

const releaseResponse = await fetch('https://api.github.com/repos/openai/tunnel-client/releases/latest', { headers });
if (!releaseResponse.ok) throw new Error(`GitHub release lookup failed (${releaseResponse.status})`);
const release = await releaseResponse.json();
const assets = Array.isArray(release.assets) ? release.assets : [];
const zip = assets.find((asset) => asset.name === `windows-${architecture}.zip`)
  ?? assets.find((asset) => new RegExp(`windows.*(?:${architecture}|x86_64).*\\.zip$`, 'i').test(asset.name));
const checksums = assets.find((asset) => /^SHA256SUMS(?:\.txt)?$/i.test(asset.name));
if (!zip || !checksums) throw new Error(`Release ${release.tag_name ?? ''} has no matching Windows ZIP or SHA256SUMS file`);

const temporary = await mkdtemp(join(tmpdir(), 'openai-tunnel-client-'));
const toolsRoot = join(repositoryRoot, '.tools');
const destination = join(toolsRoot, 'tunnel-client');
const staging = join(toolsRoot, `.tunnel-client-staging-${randomUUID()}`);
const backup = join(toolsRoot, `.tunnel-client-backup-${randomUUID()}`);
try {
  await mkdir(toolsRoot, { recursive: true });
  const zipPath = join(temporary, basename(zip.name));
  const checksumPath = join(temporary, basename(checksums.name));
  await writeFile(zipPath, await fetchBytes(zip.browser_download_url, MAX_ZIP_BYTES));
  await writeFile(checksumPath, await fetchBytes(checksums.browser_download_url, MAX_CHECKSUM_BYTES));
  const published = await readFile(checksumPath, 'utf8');
  const line = published.split(/\r?\n/).find((candidate) => candidate.trim().endsWith(zip.name));
  if (!line) throw new Error(`Published checksum for ${zip.name} was not found`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  if (expected !== actual) throw new Error(`SHA-256 mismatch for ${zip.name}`);
  await assertSafeArchive(zipPath);
  await mkdir(staging, { recursive: false });
  await run('tar', ['-xf', zipPath, '-C', staging]);
  await assertSafeExtracted(staging);
  const executable = await findExecutable(staging);
  if (!executable) throw new Error('tunnel-client.exe was not found after extraction');
  const stagedExecutable = join(staging, 'tunnel-client.exe');
  if (executable !== stagedExecutable) await rename(executable, stagedExecutable);
  await writeFile(join(staging, 'VERSION.txt'), `${release.tag_name ?? 'unknown'}\n`, 'utf8');
  let movedExisting = false;
  try {
    await rename(destination, backup);
    movedExisting = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (movedExisting) await rename(backup, destination).catch(() => {});
    throw error;
  }
  if (movedExisting) await rm(backup, { recursive: true, force: true });
  const finalPath = join(destination, 'tunnel-client.exe');
  process.stdout.write(`Installed verified OpenAI tunnel-client ${release.tag_name ?? ''} at ${finalPath}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
}
