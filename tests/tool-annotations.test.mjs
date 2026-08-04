import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyConfiguredAnnotations,
  loadToolAnnotationConfig,
  syncDiscoveredToolAnnotations
} from '../app/tool-annotations.mjs';

test('external annotation config creates only missing prefix sections and preserves existing assignments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-annotations-'));
  const path = join(directory, 'tool-annotations.toml');
  await writeFile(path, [
    '# user configuration',
    '[tool_annotations.browser]',
    'default = "LOCAL_STATE_ANNOTATIONS"',
    'open_world_hint = true',
    '[tool_annotations.browser.tools]',
    'inspect = "READ_ONLY_ANNOTATIONS"',
    '[tool_annotations.browser.open_world_tools]',
    'inspect = false'
  ].join('\n'), 'utf8');

  const config = await loadToolAnnotationConfig(path, ['browser', 'ghidra']);
  await loadToolAnnotationConfig(path, ['browser', 'ghidra']);
  const text = await readFile(path, 'utf8');
  assert.match(text, /Discovered tools are inserted here as UNCLASSIFIED/);
  assert.equal((text.match(/\[tool_annotations\.browser\]/g) ?? []).length, 1);
  assert.equal((text.match(/\[tool_annotations\.ghidra\]/g) ?? []).length, 1);

  const inspect = applyConfiguredAnnotations({ name: 'inspect' }, 'browser', config);
  assert.deepEqual(inspect.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  const mutate = applyConfiguredAnnotations({ name: 'mutate' }, 'browser', config);
  assert.deepEqual(mutate.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  });
});

test('annotation config is not created when every enabled MCP manages its own annotations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-annotations-internal-only-'));
  const path = join(directory, 'tool-annotations.toml');
  const config = await loadToolAnnotationConfig(path, []);
  assert.equal(config.prefixes.size, 0);
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
});

test('newly discovered external tools are recorded once as unclassified and can be assigned individually', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-annotations-discovered-'));
  const path = join(directory, 'tool-annotations.toml');
  await writeFile(path, [
    '[tool_annotations.browser]',
    'default = "READ_ONLY_ANNOTATIONS"',
    '[tool_annotations.browser.tools]',
    'inspect = "READ_ONLY_ANNOTATIONS"',
    '[tool_annotations.browser.open_world_tools]'
  ].join('\n'), 'utf8');

  const config = await loadToolAnnotationConfig(path, ['browser']);
  await syncDiscoveredToolAnnotations(config, 'browser', ['inspect', 'click', 'tool.with.dot']);
  await syncDiscoveredToolAnnotations(config, 'browser', ['inspect', 'click', 'tool.with.dot']);
  const text = await readFile(path, 'utf8');
  assert.equal((text.match(/^click = "UNCLASSIFIED"$/gm) ?? []).length, 1);
  assert.equal((text.match(/^"tool\.with\.dot" = "UNCLASSIFIED"$/gm) ?? []).length, 1);
  assert.equal((text.match(/^inspect = "READ_ONLY_ANNOTATIONS"$/gm) ?? []).length, 1);

  const click = applyConfiguredAnnotations({ name: 'click' }, 'browser', config);
  assert.deepEqual(click.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  });
  const inspect = applyConfiguredAnnotations({ name: 'inspect' }, 'browser', config);
  assert.deepEqual(inspect.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
});

test('external tools with missing hints receive explicit conservative MCP defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-annotation-defaults-'));
  const config = await loadToolAnnotationConfig(join(directory, 'tool-annotations.toml'), ['external']);
  const tool = applyConfiguredAnnotations({
    name: 'partial',
    annotations: { readOnlyHint: true }
  }, 'external', config);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  });
});
