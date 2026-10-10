const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const baseStorage = require('../storage');
const { createSeriesStorage } = require('../series-storage');

const dbName = label => `fumizukue-series-restore-${label}-${Date.now()}-${Math.random()}`;
const packageOf = work => ({ work, images: [] });

function withWorkId(id, title) {
  const work = NovelModel.createWork({ title });
  work.id = id;
  for (const chapter of work.chapters) chapter.workId = id;
  for (const episode of work.episodes) episode.workId = id;
  for (const scene of work.scenes) scene.workId = id;
  for (const character of work.characters) character.workId = id;
  for (const image of work.images) image.workId = id;
  return { work, images: [] };
}

function restoreValue(seriesId, works, activeWorkId = works[0].work.id) {
  return {
    series: { id: seriesId, title: `復元 ${seriesId}`, summary: 'archive' },
    activeWorkId,
    works
  };
}

function storage(base = baseStorage) {
  return createSeriesStorage({ baseStorage: base, packageTools: NovelPackage, indexedDB });
}

async function seedSeries(api, db, id, workPackage) {
  return api.createSeriesWithInitialWork(db, { id, title: id, summary: '' }, workPackage);
}

async function rawWork(db, id) {
  const tx = db.transaction('works', 'readonly');
  const request = tx.objectStore('works').get(id);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test('restore inspection is read-only and reports create or replace with sorted target works', async () => {
  const api = storage();
  const db = await api.openStore({ indexedDB, name: dbName('inspect') });
  try {
    const newValue = restoreValue('series-new', [withWorkId('work-z', 'Z'), withWorkId('work-a', 'A')], 'work-z');
    const before = { series: await api.listSeries(db), meta: await api.getWorkspaceMeta(db) };
    assert.deepEqual(await api.inspectSeriesRestore(db, newValue), {
      mode: 'create', seriesId: 'series-new', targetWorkIds: []
    });
    assert.deepEqual({ series: await api.listSeries(db), meta: await api.getWorkspaceMeta(db) }, before);

    await seedSeries(api, db, 'series-existing', withWorkId('work-b', 'B'));
    await api.createWorkInSeries(db, 'series-existing', withWorkId('work-a', 'A'));
    const replacement = restoreValue('series-existing', [withWorkId('work-c', 'C')]);
    assert.deepEqual(await api.inspectSeriesRestore(db, replacement), {
      mode: 'replace', seriesId: 'series-existing', targetWorkIds: ['work-a', 'work-b']
    });
  } finally {
    db.close();
  }
});

test('restore inspection rejects work and child IDs owned by another series', async () => {
  const api = storage();
  const db = await api.openStore({ indexedDB, name: dbName('collision') });
  try {
    const other = withWorkId('shared-work', 'Other');
    await seedSeries(api, db, 'series-other', other);

    await assert.rejects(
      () => api.inspectSeriesRestore(db, restoreValue('series-new', [withWorkId('shared-work', 'Incoming')])),
      /ID|衝突|別.*シリーズ|作品/
    );

    const incoming = withWorkId('incoming-work', 'Incoming');
    incoming.work.chapters[0].id = other.work.chapters[0].id;
    incoming.work.episodes[0].chapterId = other.work.chapters[0].id;
    for (const scene of incoming.work.scenes) {
      if (scene.chapterId !== null) scene.chapterId = other.work.chapters[0].id;
    }
    await assert.rejects(
      () => api.inspectSeriesRestore(db, restoreValue('series-new', [incoming])),
      /ID|衝突|別.*シリーズ/
    );
  } finally {
    db.close();
  }
});

test('restore creates all works atomically and activates manifest active work', async () => {
  const api = storage();
  const db = await api.openStore({ indexedDB, name: dbName('create') });
  try {
    const value = restoreValue('series-restored', [withWorkId('work-a', 'A'), withWorkId('work-b', 'B')], 'work-b');
    const inspection = await api.inspectSeriesRestore(db, value);
    const result = await api.restoreSeries(db, value, inspection);

    assert.deepEqual((await api.listWorks(db, 'series-restored')).map(item => item.id).sort(), ['work-a', 'work-b']);
    assert.equal((await api.loadWork(db, 'work-a')).work.title, 'A');
    assert.equal((await api.loadWork(db, 'work-b')).work.title, 'B');
    assert.deepEqual(result.workspaceMeta, { id: 'current', activeSeriesId: 'series-restored', activeWorkId: 'work-b' });
    assert.deepEqual(await api.getWorkspaceMeta(db), result.workspaceMeta);
    assert.equal((await api.getSeries(db, 'series-restored')).lastActiveWorkId, 'work-b');
  } finally {
    db.close();
  }
});

test('restore replaces only the matching series and advances revisions', async () => {
  const api = storage();
  const db = await api.openStore({ indexedDB, name: dbName('replace') });
  try {
    const oldA = withWorkId('work-a', 'Old A');
    const oldGone = withWorkId('work-gone', 'Gone');
    const other = withWorkId('work-other', 'Other');
    await seedSeries(api, db, 'series-target', oldA);
    await api.createWorkInSeries(db, 'series-target', oldGone);
    await seedSeries(api, db, 'series-other', other);
    const oldRevision = (await rawWork(db, 'work-a'))._revision;
    const otherBefore = structuredClone((await api.loadWork(db, 'work-other')).work);

    const incomingA = structuredClone(oldA);
    incomingA.work.title = 'Restored A';
    const value = restoreValue('series-target', [incomingA, withWorkId('work-new', 'New')], 'work-new');
    const inspection = await api.inspectSeriesRestore(db, value);
    await api.restoreSeries(db, value, inspection);

    assert.deepEqual((await api.listWorks(db, 'series-target')).map(item => item.id).sort(), ['work-a', 'work-new']);
    assert.equal(await api.loadWork(db, 'work-gone'), null);
    assert.equal((await api.loadWork(db, 'work-a')).work.title, 'Restored A');
    assert.ok((await rawWork(db, 'work-a'))._revision > oldRevision);
    assert.deepEqual((await api.loadWork(db, 'work-other')).work, otherBefore);
  } finally {
    db.close();
  }
});

test('restore aborts when target membership changes after inspection', async () => {
  const api = storage();
  const db = await api.openStore({ indexedDB, name: dbName('membership-race') });
  try {
    await seedSeries(api, db, 'series-target', withWorkId('work-a', 'A'));
    const value = restoreValue('series-target', [withWorkId('work-a', 'Restored A')]);
    const inspection = await api.inspectSeriesRestore(db, value);
    await api.createWorkInSeries(db, 'series-target', withWorkId('work-late', 'Late'));

    await assert.rejects(() => api.restoreSeries(db, value, inspection), /競合|変更|再確認/);
    assert.deepEqual((await api.listWorks(db, 'series-target')).map(item => item.id).sort(), ['work-a', 'work-late']);
  } finally {
    db.close();
  }
});

test('restore rechecks cross-series collisions introduced after inspection', async () => {
  const api = storage();
  const db = await api.openStore({ indexedDB, name: dbName('collision-race') });
  try {
    const incoming = withWorkId('work-incoming', 'Incoming');
    const value = restoreValue('series-new', [incoming]);
    const inspection = await api.inspectSeriesRestore(db, value);

    const late = withWorkId('work-other', 'Other');
    late.work.chapters[0].id = incoming.work.chapters[0].id;
    late.work.episodes[0].chapterId = incoming.work.chapters[0].id;
    for (const scene of late.work.scenes) if (scene.chapterId !== null) scene.chapterId = incoming.work.chapters[0].id;
    await seedSeries(api, db, 'series-other', late);

    await assert.rejects(() => api.restoreSeries(db, value, inspection), /ID|衝突|競合/);
    assert.equal(await api.getSeries(db, 'series-new'), null);
  } finally {
    db.close();
  }
});

test('writer failure during multi-work restore rolls back every restore write', async () => {
  let failRestore = false;
  let writerCalls = 0;
  const failingBase = {
    ...baseStorage,
    writeValidatedWorkToTransaction(...args) {
      writerCalls++;
      if (failRestore && writerCalls >= 2) throw new Error('injected restore failure');
      return baseStorage.writeValidatedWorkToTransaction(...args);
    }
  };
  const api = storage(failingBase);
  const db = await api.openStore({ indexedDB, name: dbName('rollback') });
  try {
    await seedSeries(api, db, 'series-existing', withWorkId('work-existing', 'Existing'));
    const beforeMeta = await api.getWorkspaceMeta(db);
    const value = restoreValue('series-new', [withWorkId('work-a', 'A'), withWorkId('work-b', 'B')], 'work-b');
    const inspection = await api.inspectSeriesRestore(db, value);
    writerCalls = 0;
    failRestore = true;

    await assert.rejects(() => api.restoreSeries(db, value, inspection), /injected restore failure/);
    assert.equal(await api.getSeries(db, 'series-new'), null);
    assert.equal(await api.loadWork(db, 'work-a'), null);
    assert.equal(await api.loadWork(db, 'work-b'), null);
    assert.deepEqual(await api.getWorkspaceMeta(db), beforeMeta);
    assert.equal((await api.loadWork(db, 'work-existing')).work.title, 'Existing');
  } finally {
    db.close();
  }
});
