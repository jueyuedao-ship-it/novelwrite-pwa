const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const baseStorage = require('../storage');
const { createSeriesStorage } = require('../series-storage');

const dbName = label => `fumizukue-series-test-${label}-${Date.now()}-${Math.random()}`;
const packageOf = work => ({ work, images: [] });

async function legacyDatabase(name, title = '作品A') {
  const work = NovelModel.createWork({ title });
  const db = await baseStorage.openStore({ indexedDB, name, version: 4 });
  await baseStorage.saveWork(db, packageOf(work));
  db.close();
  return work;
}

function storage() {
  return createSeriesStorage({ baseStorage, packageTools: NovelPackage, indexedDB });
}

test('v4 single-work database migrates into one series without changing IDs', async () => {
  const name = dbName('migration');
  const original = await legacyDatabase(name, '連作');
  const db = await storage().openStore({ indexedDB, name });
  try {
    const series = await storage().listSeries(db);
    assert.equal(series.length, 1);
    assert.equal(series[0].title, '連作');
    const works = await storage().listWorks(db, series[0].id);
    assert.equal(works.length, 1);
    assert.equal(works[0].id, original.id);
    const loaded = await storage().loadWork(db, original.id);
    assert.equal(loaded.work.id, original.id);
    assert.equal(loaded.work.chapters[0].id, original.chapters[0].id);
    assert.equal(loaded.work.episodes[0].id, original.episodes[0].id);
    const meta = await storage().getWorkspaceMeta(db);
    assert.deepEqual(meta, { id: 'current', activeSeriesId: series[0].id, activeWorkId: original.id });
  } finally {
    db.close();
  }
});

test('two works coexist and replacing work A does not modify work B', async () => {
  const name = dbName('isolation');
  const workA = await legacyDatabase(name, '作品A');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const [series] = await api.listSeries(db);
    const workB = NovelModel.createWork({ title: '作品B' });
    await api.createWorkInSeries(db, series.id, packageOf(workB));
    assert.deepEqual((await api.listWorks(db, series.id)).map(item => item.id).sort(), [workA.id, workB.id].sort());

    await api.setActiveWorkspace(db, series.id, workA.id);
    const changedA = structuredClone(workA);
    changedA.title = '作品A 改稿';
    changedA.episodes[0].lines[0].text = 'Aだけを変更';
    await api.saveWork(db, packageOf(changedA));

    const loadedA = await api.loadWork(db, workA.id);
    const loadedB = await api.loadWork(db, workB.id);
    assert.equal(loadedA.work.title, '作品A 改稿');
    assert.equal(loadedA.work.episodes[0].lines[0].text, 'Aだけを変更');
    assert.equal(loadedB.work.title, '作品B');
    assert.equal(loadedB.work.episodes[0].lines[0].text, '');
  } finally {
    db.close();
  }
});

test('deleteWork removes only the selected work and rejects deleting the final work', async () => {
  const name = dbName('delete');
  const workA = await legacyDatabase(name, '作品A');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const [series] = await api.listSeries(db);
    const workB = NovelModel.createWork({ title: '作品B' });
    await api.createWorkInSeries(db, series.id, packageOf(workB));
    await api.deleteWork(db, workB.id);
    const remaining = await api.listWorks(db, series.id);
    assert.deepEqual(remaining.map(item => item.id), [workA.id]);
    await assert.rejects(() => api.deleteWork(db, workA.id), /最後の1作品/);
    assert.equal((await api.loadWork(db, workA.id)).work.id, workA.id);
  } finally {
    db.close();
  }
});
