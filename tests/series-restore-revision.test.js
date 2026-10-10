const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const baseStorage = require('../storage');
const { createSeriesStorage } = require('../series-storage');

const dbName = () => `fumizukue-series-restore-stale-${Date.now()}-${Math.random()}`;
const makeStorage = () => createSeriesStorage({ baseStorage, packageTools: NovelPackage, indexedDB });

function workPackage(id, title) {
  const work = NovelModel.createWork({ title });
  work.id = id;
  for (const chapter of work.chapters) chapter.workId = id;
  for (const episode of work.episodes) episode.workId = id;
  for (const scene of work.scenes) scene.workId = id;
  for (const character of work.characters) character.workId = id;
  for (const image of work.images) image.workId = id;
  return { work, images: [] };
}

test('stale tab save is rejected after same-work series restore advances revision', async () => {
  const name = dbName();
  const api1 = makeStorage();
  const db1 = await api1.openStore({ indexedDB, name });
  let db2;
  try {
    const original = workPackage('work-a', 'Original');
    await api1.createSeriesWithInitialWork(db1, { id: 'series-a', title: 'Series A', summary: '' }, original);

    const api2 = makeStorage();
    db2 = await api2.openStore({ indexedDB, name });
    const staleIndex = await api2.loadWorkIndex(db2, 'work-a');

    const restored = structuredClone(original);
    restored.work.title = 'Restored';
    const restoreValue = {
      series: { id: 'series-a', title: 'Series A', summary: 'restored' },
      activeWorkId: 'work-a',
      works: [restored]
    };
    const inspection = await api1.inspectSeriesRestore(db1, restoreValue);
    await api1.restoreSeries(db1, restoreValue, inspection);

    await assert.rejects(
      () => api2.saveChanges(db2, {
        workId: 'work-a',
        work: { ...staleIndex.work, title: 'Stale overwrite' }
      }),
      /別のタブ|競合|更新/
    );
    assert.equal((await api1.loadWork(db1, 'work-a')).work.title, 'Restored');
  } finally {
    db2?.close();
    db1.close();
  }
});
