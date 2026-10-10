const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const baseStorage = require('../storage');
const { createSeriesStorage } = require('../series-storage');
const { createSeriesOrderingStorage } = require('../series-ordering');
const common = require('../archive-common');

const dbName = label => `fumizukue-series-order-${label}-${Date.now()}-${Math.random()}`;
const packageOf = work => ({ work, images: [] });
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

async function legacyDatabase(name, title = '作品A') {
  const work = NovelModel.createWork({ title });
  const db = await baseStorage.openStore({ indexedDB, name, version: 4 });
  await baseStorage.saveWork(db, packageOf(work));
  db.close();
  return work;
}

function storage() {
  return createSeriesOrderingStorage(createSeriesStorage({ baseStorage, packageTools: NovelPackage, indexedDB }));
}

function packageWithId(id, title) {
  const work = NovelModel.createWork({ title });
  work.id = id;
  for (const chapter of work.chapters) chapter.workId = id;
  for (const episode of work.episodes) episode.workId = id;
  return packageOf(work);
}

test('series works receive stable order values, can move, and persist after reopening', async () => {
  const name = dbName('move');
  const workA = await legacyDatabase(name, '作品A');
  const api = storage();
  let db = await api.openStore({ indexedDB, name });
  try {
    const [series] = await api.listSeries(db);
    const workB = NovelModel.createWork({ title: '作品B' });
    const workC = NovelModel.createWork({ title: '作品C' });
    await api.createWorkInSeries(db, series.id, packageOf(workB));
    await api.createWorkInSeries(db, series.id, packageOf(workC));

    assert.deepEqual(
      (await api.listWorks(db, series.id)).map(item => [item.id, item.order]),
      [[workA.id, 0], [workB.id, 1], [workC.id, 2]]
    );

    await api.moveWork(db, workC.id, -1);
    assert.deepEqual(
      (await api.listWorks(db, series.id)).map(item => [item.id, item.order]),
      [[workA.id, 0], [workC.id, 1], [workB.id, 2]]
    );
  } finally {
    db.close();
  }

  db = await api.openStore({ indexedDB, name });
  try {
    const [series] = await api.listSeries(db);
    assert.deepEqual(
      (await api.listWorks(db, series.id)).map(item => item.title),
      ['作品A', '作品C', '作品B']
    );
  } finally {
    db.close();
  }
});

test('replacing the active work keeps its series position and deleting compacts orders', async () => {
  const name = dbName('replace-delete');
  const workA = await legacyDatabase(name, '作品A');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const [series] = await api.listSeries(db);
    const workB = NovelModel.createWork({ title: '作品B' });
    const workC = NovelModel.createWork({ title: '作品C' });
    await api.createWorkInSeries(db, series.id, packageOf(workB));
    await api.createWorkInSeries(db, series.id, packageOf(workC));
    await api.moveWork(db, workC.id, -1);
    await api.setActiveWorkspace(db, series.id, workC.id);

    const replacement = NovelModel.createWork({ title: '作品C 改稿版' });
    await api.saveWork(db, packageOf(replacement));
    assert.deepEqual(
      (await api.listWorks(db, series.id)).map(item => [item.title, item.order]),
      [['作品A', 0], ['作品C 改稿版', 1], ['作品B', 2]]
    );

    await api.deleteWork(db, workA.id);
    assert.deepEqual(
      (await api.listWorks(db, series.id)).map(item => [item.title, item.order]),
      [['作品C 改稿版', 0], ['作品B', 1]]
    );
  } finally {
    db.close();
  }
});

test('series archive preserves the caller supplied work order', async () => {
  const seriesArchive = require('../series-archive');
  const workZ = packageWithId('work-z', '終章');
  const workA = packageWithId('work-a', '第一作');
  const blob = await seriesArchive.exportSeriesArchive({
    series: { id: 'series-1', title: 'シリーズ', summary: '' },
    activeWorkId: 'work-z',
    works: [workZ, workA]
  });
  const archive = await common.readArchive(blob);
  assert.deepEqual(archive.manifest.works.map(item => item.id), ['work-z', 'work-a']);
});

test('series plot UI exposes work move controls and the PWA cache generation is bumped', () => {
  const source = read('series.js');
  const sw = read('sw.js');
  assert.match(source, /moveWork/);
  assert.match(source, /作品を上へ/);
  assert.match(source, /作品を下へ/);
  assert.match(sw, /fumizukue-series-chapter-v9/);
});
