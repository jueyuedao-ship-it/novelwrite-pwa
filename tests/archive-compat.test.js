const test = require('node:test');
const assert = require('node:assert/strict');
const common = require('../archive-common.js');
const archive = require('../archive.js');

function minimalPackage() {
  const workId = 'work-full';
  const chapterId = 'chapter-1';
  return {
    work: {
      schemaVersion: 4, id: workId, title: 'Full', summary: 'Summary',
      chapters: [{ id: chapterId, workId, title: 'Chapter', order: 0 }],
      episodes: [{ id: 'episode-1', workId, chapterId, title: 'Episode', order: 0, lines: [{ id: 'line-1', speaker: '', characterId: null, text: 'hello' }] }],
      scenes: [], characters: [], images: []
    },
    images: []
  };
}

test('full-work archive round-trips and exposes single-read adapter', async () => {
  assert.equal(typeof archive.importArchiveRead, 'function');
  const source = minimalPackage();
  const blob = await archive.exportArchive(source);
  const restored = await archive.importArchive(blob);
  assert.deepEqual(restored, source);
  const read = await common.readArchive(blob);
  assert.deepEqual(await archive.importArchiveRead(read), source);
});

test('full-work adapter rejects chapter archive manifests', async () => {
  const blob = await common.writeArchive([
    { name: 'manifest.json', bytes: common.encodeJson({ format: 'fumizukue-chapter-archive', formatVersion: 1 }) }
  ]);
  const read = await common.readArchive(blob);
  await assert.rejects(() => archive.importArchiveRead(read), /対応していない作品ZIP形式/);
});

test('browser archive adapter lazy-loads archive-common when loaded standalone', () => {
  const source = require('node:fs').readFileSync(require.resolve('../archive.js'), 'utf8');
  assert.match(source, /import\(['"]\.\/archive-common\.js['"]\)/);
  assert.match(source, /ensureCommon/);
});
