const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const baseStorage = require('../storage');
const { createSeriesStorage } = require('../series-storage');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const dbName = () => `fumizukue-series-create-isolation-${Date.now()}-${Math.random()}`;

function composedStorage() {
  const series = createSeriesStorage({ baseStorage, packageTools: NovelPackage, indexedDB });
  const context = { NovelStorage: series, indexedDB, console, Date, Promise, setTimeout, clearTimeout, crypto: globalThis.crypto };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read('series-schema.js'), context, { filename: 'series-schema.js' });
  return context.NovelStorage;
}

test('creating a series rejects child ids already owned by another work without leaving an orphan series', async () => {
  const name = dbName();
  const workA = NovelModel.createWork({ title: '作品A' });
  const legacy = await baseStorage.openStore({ indexedDB, name, version: 4 });
  await baseStorage.saveWork(legacy, { work: workA, images: [] });
  legacy.close();

  const api = composedStorage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const beforeMeta = await api.getWorkspaceMeta(db);
    const workB = NovelModel.createWork({ title: '作品B' });
    const collidingChapterId = workA.chapters[0].id;
    workB.chapters[0].id = collidingChapterId;
    workB.chapters[0].workId = workB.id;
    workB.episodes[0].chapterId = collidingChapterId;

    await assert.rejects(
      () => api.createSeriesWithInitialWork(
        db,
        { id: 'series-collision', title: '衝突シリーズ' },
        { work: workB, images: [] }
      ),
      /別作品|ID.*使用|重複/
    );

    assert.equal(await api.getSeries(db, 'series-collision'), null);
    assert.deepEqual(await api.getWorkspaceMeta(db), beforeMeta);
    assert.equal((await api.loadWork(db, workA.id)).work.chapters[0].id, collidingChapterId);
  } finally {
    db.close();
  }
});
