const test = require('node:test');
const assert = require('node:assert/strict');
const common = require('../archive-common.js');
const workArchive = require('../archive.js');
const NovelModel = require('../model.js');

function packageWithId(id, title) {
  const work = NovelModel.createWork({ title });
  const oldId = work.id;
  work.id = id;
  for (const chapter of work.chapters) chapter.workId = id;
  for (const episode of work.episodes) episode.workId = id;
  for (const scene of work.scenes) scene.workId = id;
  for (const character of work.characters) character.workId = id;
  for (const image of work.images) image.workId = id;
  assert.notEqual(oldId, id);
  return { work, images: [] };
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

test('series archive preserves supplied work order with hashes and active work metadata', async () => {
  const seriesArchive = require('../series-archive.js');
  const workZ = packageWithId('work-z', '終章');
  const workA = packageWithId('work-a', '第一作');
  const series = { id: 'series-1', title: '星海シリーズ', summary: '連作' };

  const blob = await seriesArchive.exportSeriesArchive({
    series,
    activeWorkId: 'work-z',
    works: [workZ, workA]
  });

  const read = await common.readArchive(blob);
  assert.equal(read.manifest.format, 'fumizukue-series-archive');
  assert.equal(read.manifest.formatVersion, 1);
  assert.deepEqual(read.manifest.series, series);
  assert.equal(read.manifest.activeWorkId, 'work-z');
  assert.deepEqual(read.manifest.works.map(item => item.id), ['work-z', 'work-a']);
  assert.deepEqual(read.manifest.works.map(item => item.path), ['works/0001.zip', 'works/0002.zip']);

  for (const item of read.manifest.works) {
    const bytes = read.files[item.path];
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(item.sha256, await common.sha256(bytes));
    const restored = await workArchive.importArchive(new Blob([bytes], { type: 'application/zip' }));
    assert.equal(restored.work.id, item.id);
    assert.equal(restored.work.title, item.title);
  }
});

test('series archive rejects empty, duplicate, or foreign active work ids', async () => {
  const seriesArchive = require('../series-archive.js');
  const series = { id: 'series-1', title: 'シリーズ', summary: '' };
  const work = packageWithId('work-a', '作品A');

  await assert.rejects(
    () => seriesArchive.exportSeriesArchive({ series, activeWorkId: 'work-a', works: [] }),
    /作品|空/
  );
  await assert.rejects(
    () => seriesArchive.exportSeriesArchive({ series, activeWorkId: 'work-a', works: [work, structuredClone(work)] }),
    /重複|同じ作品ID/
  );
  await assert.rejects(
    () => seriesArchive.exportSeriesArchive({ series, activeWorkId: 'work-missing', works: [work] }),
    /active|開いている作品|作品ID/
  );
});

test('series archive aborts when a nested work archive cannot be exported', async () => {
  const seriesArchive = require('../series-archive.js');
  const series = { id: 'series-1', title: 'シリーズ', summary: '' };
  const valid = packageWithId('work-a', '作品A');
  const broken = packageWithId('work-b', '作品B');
  broken.work.images.push({
    id: 'image-missing', workId: 'work-b', ownerType: 'character', ownerId: 'character-missing',
    name: 'missing.png', mimeType: 'image/png', order: 0, referenceNumber: null
  });

  await assert.rejects(
    () => seriesArchive.exportSeriesArchive({ series, activeWorkId: 'work-a', works: [valid, broken] }),
    /画像|参照|不正/
  );
});

test('series archive output contains only manifest and declared nested work zips', async () => {
  const seriesArchive = require('../series-archive.js');
  const series = { id: 'series-1', title: 'シリーズ', summary: '' };
  const work = packageWithId('work-a', '作品A');
  const blob = await seriesArchive.exportSeriesArchive({ series, activeWorkId: 'work-a', works: [work] });
  const read = await common.readArchive(blob);
  assert.deepEqual(Object.keys(read.files).sort(), ['manifest.json', 'works/0001.zip']);
  assert.equal((await blobBytes(blob)).length > 0, true);
});

test('browser series archive adapter lazy-loads its dependencies', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../series-archive.js'), 'utf8');
  assert.match(source, /archive-common\.js/);
  assert.match(source, /archive\.js/);
  assert.match(source, /exportSeriesArchive/);
});
