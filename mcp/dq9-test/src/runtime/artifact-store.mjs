import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayError } from '../util/errors.mjs';

const MAX_METADATA_BYTES = 64 * 1024;
const unsafeKey = /^(?:rom|save|state|memory)(?:body|bytes|dump|data)$/i;
const safeSegment = (value, label) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(value)) {
    throw new RelayError('ARTIFACT_ID_INVALID', `${label} must be an opaque path-safe ID`);
  }
  return value;
};

const containsBody = (value, key = '') => {
  if (unsafeKey.test(key) || /(?:^|_)(?:rom|save|state|memory)(?:_|$).*(?:body|bytes|dump|data)|(?:body|bytes|dump|data).*(?:rom|save|state|memory)/i.test(key)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsBody(entry));
  if (value && typeof value === 'object') return Object.entries(value).some(([childKey, child]) => containsBody(child, childKey));
  return false;
};

export class ArtifactStore {
  constructor(root, { mkdirImpl = mkdir, writeFileImpl = writeFile, renameImpl = rename, idFactory = randomUUID } = {}) {
    this.root = root;
    this.mkdirImpl = mkdirImpl;
    this.writeFileImpl = writeFileImpl;
    this.renameImpl = renameImpl;
    this.idFactory = idFactory;
  }

  async stageJson(kind, logicalId, metadata) {
    const checkedKind = safeSegment(kind, 'kind');
    const checkedId = safeSegment(logicalId, 'logicalId');
    if (containsBody(metadata)) throw new RelayError('ARTIFACT_BODY_PROHIBITED', 'Artifact metadata must not contain ROM, Save, State, or memory bodies');
    const artifactId = safeSegment(this.idFactory(), 'artifactId');
    const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
      throw new RelayError('ARTIFACT_METADATA_TOO_LARGE', `Artifact metadata exceeds ${MAX_METADATA_BYTES} bytes`);
    }
    const stagingDirectory = join(this.root, 'staging', checkedKind);
    const committedDirectory = join(this.root, 'committed', checkedKind);
    const filename = `${checkedId}-${artifactId}.json`;
    const stagePath = join(stagingDirectory, `${filename}.stage`);
    const committedPath = join(committedDirectory, filename);
    try {
      await this.mkdirImpl(stagingDirectory, { recursive: true });
      await this.mkdirImpl(committedDirectory, { recursive: true });
      await this.writeFileImpl(stagePath, serialized, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      throw new RelayError('ARTIFACT_STAGE_FAILED', 'Artifact staging failed; no artifact was committed', { cause: error instanceof Error ? error.message : String(error) });
    }
    return Object.freeze({ kind: checkedKind, logicalId: checkedId, artifactId, stagePath, committedPath, closed: false });
  }

  close(stage) {
    if (!stage || stage.closed) throw new RelayError('ARTIFACT_STAGE_INVALID', 'Artifact stage is missing or already closed');
    return Object.freeze({ ...stage, closed: true });
  }

  async commit(stage) {
    if (!stage?.closed) throw new RelayError('ARTIFACT_STAGE_INCOMPLETE', 'Artifact must be closed before commit');
    try {
      await this.renameImpl(stage.stagePath, stage.committedPath);
    } catch (error) {
      throw new RelayError('ARTIFACT_COMMIT_FAILED', 'Artifact remains incomplete in staging after commit failure', {
        stagePath: stage.stagePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    return stage.committedPath;
  }

  async saveJson(kind, logicalId, metadata) {
    const stage = await this.stageJson(kind, logicalId, metadata);
    return this.commit(this.close(stage));
  }

  async saveRun(metadata) {
    return this.saveJson('runs', metadata.runId, metadata);
  }

  async saveCase(metadata) {
    return this.saveJson('cases', metadata.caseArtifactId, metadata);
  }

  async saveIncident(metadata) {
    return this.saveJson('incidents', metadata.incidentArtifactId, metadata);
  }
}

export const artifactLimits = Object.freeze({ maxMetadataBytes: MAX_METADATA_BYTES });
