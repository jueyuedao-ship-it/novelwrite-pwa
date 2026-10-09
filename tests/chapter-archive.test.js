const test = require('node:test');
const assert = require('node:assert/strict');
const common = require('../archive-common.js');
const chapterArchive = require('../chapter-archive.js');

const JSON_FILES = [
  'work-ref.json', 'catalog.json', 'chapter/chapter.json', 'chapter/episodes.json',
  'chapter/scenes.json', 'refs/characters.json', 'refs/shared.json'
];

function gifBlob() {
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  return new Blob([bytes], { type: 'image/gif' });
}
function character(id, workId, imageIds = []) {
  return { id, workId, name: id, role: '', description: '', appearance: '', personality: '', goal: '', background: '', relationshipNotes: '', customFields: [], imageIds };
}
function sourcePackage() {
  const workId = 'work-1';
  const chapters = [{ id: 'chapter-a', workId, title: 'A', order: 0 }, { id: 'chapter-b', workId, title: 'B', order: 1 }];
  const episodes = [
    { id: 'ep-a', workId, chapterId: 'chapter-a', title: 'A1', order: 0, lines: [{ id: 'line-a', speaker: '', characterId: 'char-a', text: 'alpha' }] },
    { id: 'ep-b', workId, chapterId: 'chapter-b', title: 'B1', order: 0, lines: [{ id: 'line-b', speaker: '', characterId: null, text: 'beta' }] }
  ];
  const scenes = [{ id: 'scene-a', workId, chapterId: 'chapter-a', episodeId: 'ep-a', order: 0, startLineId: 'line-a', endLineId: 'line-a', summary: 'scene', purpose: '', characterIds: ['char-a'], viewpoint: '', location: '', time: '', notes: '', imageIds: ['img-scene'], nextImageNumber: 2 }];
  const characters = [character('char-a', workId, ['img-char'])];
  const images = [
    { id: 'img-scene', workId, ownerType: 'scene', ownerId: 'scene-a', order: 0, name: 'scene.gif', mimeType: 'image/gif', referenceNumber: 1 },
    { id: 'img-char', workId, ownerType: 'character', ownerId: 'char-a', order: 0, name: 'char.gif', mimeType: 'image/gif', referenceNumber: null }
  ];
  return { work: { schemaVersion: 4, id: workId, title: 'Work', summary: 'Summary', chapters, episodes, scenes, characters, images }, images: images.map(i => ({ id: i.id, mimeType: i.mimeType, blob: gifBlob() })) };
}

async function mutateArchive(blob, mutate) {
  const read = await common.readArchive(blob);
  const files = Object.fromEntries(Object.entries(read.files).map(([name, bytes]) => [name, bytes.slice()]));
  const manifest = structuredClone(read.manifest);
  await mutate({ files, manifest });
  files['manifest.json'] = common.encodeJson(manifest);
  return common.writeArchive(Object.entries(files).map(([name, bytes]) => ({ name, bytes })));
}

async function baseArchive() {
  return chapterArchive.exportChapterArchive(sourcePackage(), 'chapter-a', { baseRevision: 7, exportedAt: '2026-10-09T00:00:00.000Z' });
}

test('chapter archive exports the v1 manifest, exact JSON allow-list and round-trips', async () => {
  const blob = await baseArchive();
  const read = await common.readArchive(blob);
  const m = read.manifest;
  assert.deepEqual(Object.keys(m), ['format', 'formatVersion', 'schemaVersion', 'sourceWorkId', 'chapterId', 'baseRevision', 'baseChapterHash', 'exportedAt', 'hashes', 'images']);
  assert.equal(m.format, 'fumizukue-chapter-archive');
  assert.equal(m.formatVersion, 1);
  assert.equal(m.schemaVersion, 4);
  assert.equal(m.sourceWorkId, 'work-1');
  assert.equal(m.chapterId, 'chapter-a');
  assert.equal(m.baseRevision, 7);
  assert.match(m.baseChapterHash, /^[a-f0-9]{64}$/);
  assert.equal(m.exportedAt, '2026-10-09T00:00:00.000Z');
  assert.deepEqual(Object.keys(m.hashes).sort(), [...JSON_FILES].sort());
  const allowed = new Set(['manifest.json', ...JSON_FILES, ...m.images.map(i => i.path)]);
  assert.deepEqual(new Set(read.entries.map(e => e.name)), allowed);
  assert.ok(m.images.some(i => i.ownerType === 'scene' && i.path.startsWith('images/scene/')));
  assert.ok(m.images.some(i => i.ownerType === 'character' && i.path.startsWith('images/character/')));

  const imported = await chapterArchive.importChapterArchiveRead(read);
  assert.equal(imported.bundle.chapter.id, 'chapter-a');
  assert.deepEqual(imported.packageValue.work.chapters.map(c => c.id), ['chapter-a']);
  assert.equal(imported.workspaceMeta.mode, 'chapter-workspace');
  assert.deepEqual(imported.workspaceMeta.loadedChapterIds, ['chapter-a']);
  assert.equal(imported.workspaceMeta.baselines['chapter-a'].baseChapterHash, m.baseChapterHash);
});

test('chapter archive can preserve an existing master baseline when re-exported', async () => {
  const first = await common.readArchive(await baseArchive());
  const preserved = 'b'.repeat(64);
  const secondBlob = await chapterArchive.exportChapterArchive(sourcePackage(), 'chapter-a', {
    baseRevision: 7, baseChapterHash: preserved, exportedAt: '2026-10-09T01:00:00.000Z'
  });
  const second = await common.readArchive(secondBlob);
  assert.equal(second.manifest.baseChapterHash, preserved);
  assert.notEqual(first.manifest.baseChapterHash, preserved);
});

test('chapter archive rejects manifest identity mismatches', async () => {
  const source = await baseArchive();
  for (const [field, value] of [['sourceWorkId', 'other-work'], ['chapterId', 'other-chapter']]) {
    const bad = await mutateArchive(source, ({ manifest }) => { manifest[field] = value; });
    await assert.rejects(() => chapterArchive.importChapterArchive(bad), /一致|ID/);
  }
});

test('chapter archive rejects missing, unexpected and checksum-mismatched JSON', async () => {
  const source = await baseArchive();
  const missing = await mutateArchive(source, ({ files }) => { delete files['catalog.json']; });
  await assert.rejects(() => chapterArchive.importChapterArchive(missing), /チェックサム|ファイル一覧|ありません/);
  const extra = await mutateArchive(source, ({ files }) => { files['extra.json'] = common.encodeJson({}); });
  await assert.rejects(() => chapterArchive.importChapterArchive(extra), /ファイル一覧/);
  const checksum = await mutateArchive(source, ({ files }) => { files['catalog.json'] = common.encodeJson({ chapters: [] }); });
  await assert.rejects(() => chapterArchive.importChapterArchive(checksum), /チェックサム/);
});

test('chapter archive rejects missing, undeclared and path-mismatched images', async () => {
  const source = await baseArchive();
  const read = await common.readArchive(source);
  const imagePath = read.manifest.images[0].path;
  const missing = await mutateArchive(source, ({ files }) => { delete files[imagePath]; });
  await assert.rejects(() => chapterArchive.importChapterArchive(missing), /画像|ファイル一覧/);
  const extra = await mutateArchive(source, ({ files }) => { files['images/scene/9999.gif'] = Uint8Array.of(1); });
  await assert.rejects(() => chapterArchive.importChapterArchive(extra), /ファイル一覧/);
  const path = await mutateArchive(source, ({ manifest }) => { manifest.images[0].path = 'images/scene/hack.gif'; });
  await assert.rejects(() => chapterArchive.importChapterArchive(path), /画像一覧|パス/);
});

test('chapter archive rejects record reference mismatch after valid checksum update', async () => {
  const source = await baseArchive();
  const bad = await mutateArchive(source, async ({ files, manifest }) => {
    const body = common.parseJson(files, 'chapter/episodes.json');
    body.episodes[0].lines[0].characterId = 'missing-character';
    files['chapter/episodes.json'] = common.encodeJson(body);
    manifest.hashes['chapter/episodes.json'] = await common.sha256(files['chapter/episodes.json']);
  });
  await assert.rejects(() => chapterArchive.importChapterArchive(bad), /参照人物|人物/);
});
