const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const mode = require('../workspace-mode.js');

function bundle() {
  return {
    sourceWork: { id: 'work-1' },
    catalog: [{ id: 'chapter-a', title: 'A', order: 0, episodeCount: 1, textLength: 10 }, { id: 'chapter-b', title: 'B', order: 1, episodeCount: 1, textLength: 10 }],
    chapter: { id: 'chapter-a' }
  };
}
function currentState() {
  return {
    work: { id: 'work-1' },
    chapters: [{ id: 'chapter-a', workId: 'work-1' }],
    episodeMetas: [{ id: 'ep-a', workId: 'work-1', chapterId: 'chapter-a' }],
    episodesById: { 'ep-a': { id: 'ep-a', workId: 'work-1', chapterId: 'chapter-a', lines: [] } },
    scenesByEpisodeId: { 'episode:ep-a': [{ id: 'scene-a', workId: 'work-1', chapterId: 'chapter-a', episodeId: 'ep-a' }] },
    characters: [{ id: 'char-a', workId: 'work-1' }],
    imagesById: {
      'scene-image': { id: 'scene-image', workId: 'work-1', ownerType: 'scene', ownerId: 'scene-a' },
      'char-image': { id: 'char-image', workId: 'work-1', ownerType: 'character', ownerId: 'char-a' }
    }
  };
}

test('createChapterWorkspaceMeta produces normalized single-chapter metadata', () => {
  const meta = mode.createChapterWorkspaceMeta(bundle(), 'a'.repeat(64), '2026-10-09T00:00:00.000Z');
  assert.deepEqual(meta, {
    id: 'active', mode: 'chapter-workspace', sourceWorkId: 'work-1',
    catalog: bundle().catalog, loadedChapterIds: ['chapter-a'],
    baselines: { 'chapter-a': { baseChapterHash: 'a'.repeat(64), exportedAt: '2026-10-09T00:00:00.000Z' } },
    sharedReadOnly: true
  });
  assert.deepEqual(mode.normalizeWorkspaceMeta(meta), meta);
  assert.equal(mode.normalizeWorkspaceMeta(null), null);
});

test('assertPatchAllowed rejects shared-data mutation in chapter mode', () => {
  const meta = mode.createChapterWorkspaceMeta(bundle(), 'a'.repeat(64), '2026-10-09T00:00:00.000Z');
  const state = currentState();
  assert.throws(() => mode.assertPatchAllowed(meta, { workId: 'work-1', work: { id: 'work-1' } }, state), /作品|共有/);
  assert.throws(() => mode.assertPatchAllowed(meta, { workId: 'work-1', characters: { upsert: [{ id: 'char-a' }], deleteIds: [] } }, state), /人物|共有/);
  assert.throws(() => mode.assertPatchAllowed(meta, { workId: 'work-1', images: { upsert: [{ id: 'x', workId: 'work-1', ownerType: 'character', ownerId: 'char-a' }], deleteIds: [] } }, state), /人物画像|共有/);
  assert.throws(() => mode.assertPatchAllowed(meta, { workId: 'work-1', images: { upsert: [], deleteIds: ['char-image'] } }, state), /人物画像|共有/);
});

test('assertPatchAllowed allows loaded-chapter edits and scene images', () => {
  const meta = mode.createChapterWorkspaceMeta(bundle(), 'a'.repeat(64), '2026-10-09T00:00:00.000Z');
  const state = currentState();
  assert.doesNotThrow(() => mode.assertPatchAllowed(meta, { workId: 'work-1', episodes: { upsert: [{ id: 'ep-a', workId: 'work-1', chapterId: 'chapter-a' }], deleteIds: [] } }, state));
  assert.doesNotThrow(() => mode.assertPatchAllowed(meta, { workId: 'work-1', scenes: { upsert: [{ id: 'scene-a', workId: 'work-1', chapterId: 'chapter-a', episodeId: 'ep-a' }], deleteIds: [] } }, state));
  assert.doesNotThrow(() => mode.assertPatchAllowed(meta, { workId: 'work-1', images: { upsert: [{ id: 'new-image', workId: 'work-1', ownerType: 'scene', ownerId: 'scene-a' }], deleteIds: ['scene-image'] } }, state));
});

test('assertPatchAllowed rejects mutations outside loadedChapterIds', () => {
  const meta = mode.createChapterWorkspaceMeta(bundle(), 'a'.repeat(64), '2026-10-09T00:00:00.000Z');
  const state = currentState();
  assert.throws(() => mode.assertPatchAllowed(meta, { workId: 'work-1', chapters: { upsert: [{ id: 'chapter-b', workId: 'work-1' }], deleteIds: [] } }, state), /読み込まれていない章/);
  assert.throws(() => mode.assertPatchAllowed(meta, { workId: 'work-1', episodes: { upsert: [{ id: 'ep-b', workId: 'work-1', chapterId: 'chapter-b' }], deleteIds: [] } }, state), /読み込まれていない章/);
  assert.throws(() => mode.assertPatchAllowed(meta, { workId: 'work-1', scenes: { upsert: [{ id: 'scene-b', workId: 'work-1', chapterId: 'chapter-b', episodeId: 'ep-b' }], deleteIds: [] } }, state), /読み込まれていない章/);
});

test('full-work/null metadata does not restrict patches', () => {
  assert.doesNotThrow(() => mode.assertPatchAllowed(null, { workId: 'work-1', work: { title: 'x' } }, currentState()));
});

test('workspace storage adapter composes chapter metadata with the Series storage layer', () => {
  const storage = fs.readFileSync(require.resolve('../workspace-storage.js'), 'utf8');
  const schema = fs.readFileSync(require.resolve('../series-schema.js'), 'utf8');
  assert.match(schema, /DATABASE_VERSION\s*=\s*6/);
  assert.match(storage, /['"]workspaceMeta['"]/);
  assert.match(storage, /function loadWorkspaceMeta\(/);
  assert.match(storage, /async function saveChapterWorkspace\(/);
  assert.match(storage, /async function loadWorkRevision\(/);
  assert.match(storage, /getWorkspaceMeta/);
  assert.match(storage, /NovelStorage/);
});
