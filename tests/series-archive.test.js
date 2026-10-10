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

async function rewriteSeriesArchive(blob, { mutateManifest, mutateFiles, omitNames = [], extraEntries = [] } = {}) {
  const read = await common.readArchive(blob);
  const manifest = structuredClone(read.manifest);
  const files = Object.fromEntries(Object.entries(read.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]));
  if (mutateManifest) await mutateManifest(manifest, files);
  if (mutateFiles) await mutateFiles(files, manifest);
  const omitted = new Set(omitNames);
  const entries = [{ name: 'manifest.json', bytes: common.encodeJson(manifest) }];
  for (const [name, bytes] of Object.entries(files)) {
    if (name === 'manifest.json' || omitted.has(name)) continue;
    entries.push({ name, bytes });
  }
  entries.push(...extraEntries);
  return common.writeArchive(entries);
}

async function exportedSeries() {
  const seriesArchive = require('../series-archive.js');
  const series = { id: 'series-restore', title: '復元シリーズ', summary: 'バックアップ' };
  const works = [packageWithId('work-b', '第二作'), packageWithId('work-a', '第一作')];
  return {
    seriesArchive,
    series,
    blob: await seriesArchive.exportSeriesArchive({ series, activeWorkId: 'work-b', works })
  };
}

test('series archive wraps id-sorted valid work archives with hashes and active work metadata', async () => {
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
  assert.deepEqual(read.manifest.works.map(item => item.id), ['work-a', 'work-z']);
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

test('series archive imports a valid multi-work export into validated work packages', async () => {
  const { seriesArchive, series, blob } = await exportedSeries();
  const restored = await seriesArchive.importSeriesArchive(blob);

  assert.deepEqual(restored.series, series);
  assert.equal(restored.activeWorkId, 'work-b');
  assert.deepEqual(restored.works.map(item => item.work.id), ['work-a', 'work-b']);
  assert.deepEqual(restored.works.map(item => item.work.title), ['第一作', '第二作']);
});

test('series archive import rejects unsupported format, version, empty works, and foreign activeWorkId', async () => {
  const { seriesArchive, blob } = await exportedSeries();
  const unsupportedFormat = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.format = 'foreign-series'; } });
  const unsupportedVersion = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.formatVersion = 2; } });
  const empty = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.works = []; } });
  const foreignActive = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.activeWorkId = 'work-missing'; } });

  await assert.rejects(() => seriesArchive.importSeriesArchive(unsupportedFormat), /対応していない|形式/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(unsupportedVersion), /対応していない|形式/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(empty), /作品|空/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(foreignActive), /activeWorkId|作品一覧/);
});

test('series archive import enforces sorted unique work ids and canonical unique paths', async () => {
  const { seriesArchive, blob } = await exportedSeries();
  const unsorted = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.works.reverse(); } });
  const duplicateId = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.works[1].id = manifest.works[0].id; } });
  const duplicatePath = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.works[1].path = manifest.works[0].path; } });
  const nonCanonicalPath = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.works[0].path = 'works/a.zip'; } });

  await assert.rejects(() => seriesArchive.importSeriesArchive(unsorted), /並び順|作品一覧/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(duplicateId), /重複|作品ID/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(duplicatePath), /パス|作品一覧|重複/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(nonCanonicalPath), /作品一覧|パス/);
});

test('series archive import rejects missing, extra, malformed-hash, and checksum-mismatched entries', async () => {
  const { seriesArchive, blob } = await exportedSeries();
  const missing = await rewriteSeriesArchive(blob, { omitNames: ['works/0002.zip'] });
  const extra = await rewriteSeriesArchive(blob, { extraEntries: [{ name: 'extra.txt', bytes: new Uint8Array([1]) }] });
  const malformedHash = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.works[0].sha256 = 'BAD'; } });
  const checksumMismatch = await rewriteSeriesArchive(blob, {
    mutateFiles: files => { files['works/0001.zip'][0] ^= 0xff; }
  });

  await assert.rejects(() => seriesArchive.importSeriesArchive(missing), /ファイル一覧|manifest/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(extra), /ファイル一覧|manifest/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(malformedHash), /作品一覧|チェックサム/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(checksumMismatch), /チェックサム/);
});

test('series archive import rejects invalid nested work archives and outer metadata mismatches', async () => {
  const { seriesArchive, blob } = await exportedSeries();
  const invalidNested = await rewriteSeriesArchive(blob, {
    mutateFiles: async (files, manifest) => {
      files['works/0001.zip'] = new Uint8Array([1, 2, 3, 4]);
      manifest.works[0].sha256 = await common.sha256(files['works/0001.zip']);
    }
  });
  const idMismatch = await rewriteSeriesArchive(blob, {
    mutateManifest: manifest => {
      manifest.works[0].id = 'work-0';
      manifest.activeWorkId = 'work-0';
    }
  });
  const titleMismatch = await rewriteSeriesArchive(blob, {
    mutateManifest: manifest => { manifest.works[0].title = '別の作品名'; }
  });

  await assert.rejects(() => seriesArchive.importSeriesArchive(invalidNested), /ZIP|アーカイブ|不正|終端/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(idMismatch), /作品ID|manifest/);
  await assert.rejects(() => seriesArchive.importSeriesArchive(titleMismatch), /作品名|manifest/);
});

test('browser series archive adapter lazy-loads its dependencies', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../series-archive.js'), 'utf8');
  assert.match(source, /archive-common\.js/);
  assert.match(source, /archive\.js/);
  assert.match(source, /exportSeriesArchive/);
  assert.match(source, /importSeriesArchive/);
});
