import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactStore } from '../src/runtime/artifact-store.mjs';

const memoryFs = () => {
  const files = new Map();
  return {
    files,
    mkdir: async () => {},
    writeFile: async (path, content, options) => {
      if (options.flag === 'wx' && files.has(path)) throw new Error('EEXIST');
      files.set(path, content);
    },
    rename: async (from, to) => {
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
      files.delete(from);
    }
  };
};

test('artifact store stages, closes, and atomically commits bounded metadata without bodies', async () => {
  const fs = memoryFs();
  const store = new ArtifactStore('C:\\artifacts', { mkdirImpl: fs.mkdir, writeFileImpl: fs.writeFile, renameImpl: fs.rename, idFactory: () => 'unique-1' });
  const path = await store.saveRun({ runId: 'run-1', state: 'completed', stateRef: 'state.json' });
  assert.match(path, /committed[\\/]runs[\\/]run-1-unique-1\.json$/);
  assert.equal(fs.files.size, 1);
  await assert.rejects(store.saveJson('runs', 'run-2', { stateBody: 'forbidden' }), { code: 'ARTIFACT_BODY_PROHIBITED' });
  await assert.rejects(store.saveJson('runs', 'run-3', { text: 'x'.repeat(70 * 1024) }), { code: 'ARTIFACT_METADATA_TOO_LARGE' });
});

test('artifact store rejects collisions, incomplete commits, stage writes, and rename failures without promotion', async () => {
  const fs = memoryFs();
  const store = new ArtifactStore('C:\\artifacts', { mkdirImpl: fs.mkdir, writeFileImpl: fs.writeFile, renameImpl: fs.rename, idFactory: () => 'same-id' });
  const stage = await store.stageJson('runs', 'run-1', { status: 'queued' });
  await assert.rejects(store.commit(stage), { code: 'ARTIFACT_STAGE_INCOMPLETE' });
  await assert.rejects(store.stageJson('runs', 'run-1', { status: 'queued' }), { code: 'ARTIFACT_STAGE_FAILED' });
  const renameFailing = new ArtifactStore('C:\\artifacts', { mkdirImpl: fs.mkdir, writeFileImpl: fs.writeFile, renameImpl: async () => { throw new Error('disk full'); }, idFactory: () => 'rename-fail' });
  const pending = renameFailing.close(await renameFailing.stageJson('runs', 'run-2', { status: 'queued' }));
  await assert.rejects(renameFailing.commit(pending), { code: 'ARTIFACT_COMMIT_FAILED' });
  assert.equal(fs.files.has(pending.stagePath), true);
  const writeFailing = new ArtifactStore('C:\\artifacts', { mkdirImpl: fs.mkdir, writeFileImpl: async () => { throw new Error('write denied'); }, renameImpl: fs.rename });
  await assert.rejects(writeFailing.stageJson('runs', 'run-3', { status: 'queued' }), { code: 'ARTIFACT_STAGE_FAILED' });
});

test('normal observer and incident detail are committed to separate artifact kinds with checkpoint references only', async () => {
  const fs = memoryFs(); let id = 0;
  const store = new ArtifactStore('C:\\artifacts', { mkdirImpl: fs.mkdir, writeFileImpl: fs.writeFile, renameImpl: fs.rename, idFactory: () => `id-${++id}` });
  const normal = await store.saveCase({
    caseArtifactId: 'run-case', turnCheckpoint: { reference: 'turn-run-case', stateLoadSerial: 12 },
    event: { rng: { actionStartPosition: '0xffffffffffffffff', rngApiCallCount: 25 }, ctableDiagnosticCounter: null }
  });
  const incident = await store.saveIncident({
    incidentArtifactId: 'run-case-incident', trace: { events: [{ sequence: 1, diagnosticCounter: 90, position: '0x0000000000000019' }] }
  });
  assert.match(normal, /committed[\\/]cases/); assert.match(incident, /committed[\\/]incidents/);
  assert.notEqual(normal, incident);
  const normalBody = fs.files.get(normal); const incidentBody = fs.files.get(incident);
  assert.doesNotMatch(normalBody, /diagnosticCounter": 90/);
  assert.match(incidentBody, /diagnosticCounter": 90/);
  assert.doesNotMatch(normalBody, /stateBody|stateBytes/);
});
