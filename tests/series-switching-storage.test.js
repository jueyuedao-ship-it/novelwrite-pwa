const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const baseStorage = require('../storage');
const { createSeriesStorage } = require('../series-storage');

const dbName = label => `fumizukue-series-switch-${label}-${Date.now()}-${Math.random()}`;
const packageOf = work => ({ work, images: [] });

function storage() {
  return createSeriesStorage({ baseStorage, packageTools: NovelPackage, indexedDB });
}

async function legacyDatabase(name, title = '作品A') {
  const work = NovelModel.createWork({ title });
  const db = await baseStorage.openStore({ indexedDB, name, version: 4 });
  await baseStorage.saveWork(db, packageOf(work));
  db.close();
  return work;
}

function workWithId(id, title) {
  const work = NovelModel.createWork({ title });
  work.id = id;
  for (const chapter of work.chapters || []) chapter.workId = id;
  for (const episode of work.episodes || []) episode.workId = id;
  for (const scene of work.scenes || []) scene.workId = id;
  for (const character of work.characters || []) character.workId = id;
  for (const image of work.images || []) image.workId = id;
  return work;
}

async function putSeriesMemory(db, seriesId, lastActiveWorkId) {
  const tx = db.transaction('series', 'readwrite');
  const store = tx.objectStore('series');
  const current = await new Promise((resolve, reject) => {
    const request = store.get(seriesId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  store.put({ ...current, lastActiveWorkId });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => {};
  });
}

test('setActiveWorkspace remembers the last active work on its series', async () => {
  const name = dbName('workspace-memory');
  const workA = await legacyDatabase(name);
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const [series] = await api.listSeries(db);
    const workB = NovelModel.createWork({ title: '作品B' });
    await api.createWorkInSeries(db, series.id, packageOf(workB));

    await api.setActiveWorkspace(db, series.id, workA.id);

    assert.equal((await api.getSeries(db, series.id)).lastActiveWorkId, workA.id);
    assert.deepEqual(await api.getWorkspaceMeta(db), {
      id: 'current', activeSeriesId: series.id, activeWorkId: workA.id
    });
  } finally {
    db.close();
  }
});

test('setActiveSeries restores its remembered work and records the series being left', async () => {
  const name = dbName('series-memory');
  const workA1 = await legacyDatabase(name, '作品A1');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const [seriesA] = await api.listSeries(db);
    const workA2 = NovelModel.createWork({ title: '作品A2' });
    await api.createWorkInSeries(db, seriesA.id, packageOf(workA2));
    await api.setActiveWorkspace(db, seriesA.id, workA2.id);

    const seriesB = await api.createSeries(db, { id: 'series-b', title: 'シリーズB' });
    const workB = NovelModel.createWork({ title: '作品B' });
    await api.createWorkInSeries(db, seriesB.id, packageOf(workB));

    const meta = await api.setActiveSeries(db, seriesA.id);

    assert.deepEqual(meta, { id: 'current', activeSeriesId: seriesA.id, activeWorkId: workA2.id });
    assert.equal((await api.getSeries(db, seriesA.id)).lastActiveWorkId, workA2.id);
    assert.equal((await api.getSeries(db, seriesB.id)).lastActiveWorkId, workB.id);
    assert.notEqual(meta.activeWorkId, workA1.id);
  } finally {
    db.close();
  }
});

test('setActiveSeries falls back to the id-sorted first valid work when memory is stale', async () => {
  const name = dbName('stale-memory');
  const workA = await legacyDatabase(name, '作品A');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const [seriesA] = await api.listSeries(db);
    const seriesB = await api.createSeries(db, { id: 'series-b', title: 'シリーズB' });
    const workZ = workWithId('work-z', '作品Z');
    const workB = workWithId('work-a', '作品A');
    await api.createWorkInSeries(db, seriesB.id, packageOf(workZ));
    await api.createWorkInSeries(db, seriesB.id, packageOf(workB));
    await api.setActiveWorkspace(db, seriesA.id, workA.id);
    await putSeriesMemory(db, seriesB.id, 'missing-work');

    const meta = await api.setActiveSeries(db, seriesB.id);

    assert.equal(meta.activeWorkId, 'work-a');
    assert.equal((await api.getSeries(db, seriesB.id)).lastActiveWorkId, 'work-a');
  } finally {
    db.close();
  }
});

test('setActiveSeries rejects a series with no works without changing the active workspace', async () => {
  const name = dbName('zero-work');
  await legacyDatabase(name, '作品A');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const before = await api.getWorkspaceMeta(db);
    const empty = await api.createSeries(db, { id: 'series-empty', title: '空シリーズ' });

    await assert.rejects(() => api.setActiveSeries(db, empty.id), /作品|Work|空/);
    assert.deepEqual(await api.getWorkspaceMeta(db), before);
  } finally {
    db.close();
  }
});

test('createSeriesWithInitialWork creates one series, one work, and activates both', async () => {
  const name = dbName('atomic-success');
  await legacyDatabase(name, '既存作品');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const beforeCount = (await api.listSeries(db)).length;
    const initialWork = workWithId('work-new-series', '新シリーズ第1作');

    const result = await api.createSeriesWithInitialWork(
      db,
      { id: 'series-new', title: '新シリーズ', summary: '概要' },
      packageOf(initialWork)
    );

    assert.equal((await api.listSeries(db)).length, beforeCount + 1);
    assert.deepEqual((await api.listWorks(db, 'series-new')).map(work => work.id), [initialWork.id]);
    assert.equal(result.series.lastActiveWorkId, initialWork.id);
    assert.deepEqual(result.workspaceMeta, {
      id: 'current', activeSeriesId: 'series-new', activeWorkId: initialWork.id
    });
    assert.deepEqual(await api.getWorkspaceMeta(db), result.workspaceMeta);
  } finally {
    db.close();
  }
});

test('createSeriesWithInitialWork leaves no series or workspace change when initial work save fails', async () => {
  const name = dbName('atomic-fail');
  const existingWork = await legacyDatabase(name, '既存作品');
  const api = storage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const beforeSeries = await api.listSeries(db);
    const beforeMeta = await api.getWorkspaceMeta(db);

    await assert.rejects(
      () => api.createSeriesWithInitialWork(
        db,
        { id: 'series-should-not-exist', title: '失敗シリーズ' },
        packageOf(existingWork)
      ),
      /作品ID|すでに|重複/
    );

    assert.deepEqual(await api.listSeries(db), beforeSeries);
    assert.equal(await api.getSeries(db, 'series-should-not-exist'), null);
    assert.deepEqual(await api.getWorkspaceMeta(db), beforeMeta);
  } finally {
    db.close();
  }
});
