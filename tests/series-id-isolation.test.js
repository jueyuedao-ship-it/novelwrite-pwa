const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const baseStorage = require('../storage');
const workspaceMode = require('../workspace-mode');
const { createSeriesStorage } = require('../series-storage');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const dbName = () => `fumizukue-series-id-isolation-${Date.now()}-${Math.random()}`;

function composedStorage() {
  const series = createSeriesStorage({ baseStorage, packageTools: NovelPackage, indexedDB });
  const context = { NovelStorage: series, NovelWorkspaceMode: workspaceMode, indexedDB, console, Date, Promise, setTimeout, clearTimeout, crypto: globalThis.crypto };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read('series-schema.js'), context, { filename: 'series-schema.js' });
  vm.runInContext(read('workspace-storage.js'), context, { filename: 'workspace-storage.js' });
  return context.NovelStorage;
}

test('adding a work rejects child ids already owned by a sibling work', async () => {
  const name = dbName();
  const workA = NovelModel.createWork({ title: '作品A' });
  const legacy = await baseStorage.openStore({ indexedDB, name, version: 4 });
  await baseStorage.saveWork(legacy, { work: workA, images: [] });
  legacy.close();

  const api = composedStorage();
  const db = await api.openStore({ indexedDB, name });
  try {
    const current = await api.getWorkspaceMeta(db);
    const workB = NovelModel.createWork({ title: '作品B' });
    const collidingChapterId = workA.chapters[0].id;
    workB.chapters[0].id = collidingChapterId;
    workB.chapters[0].workId = workB.id;
    workB.episodes[0].chapterId = collidingChapterId;

    await assert.rejects(
      () => api.createWorkInSeries(db, current.activeSeriesId, { work: workB, images: [] }),
      /別作品|ID.*使用|重複/
    );

    const intact = await api.loadWork(db, workA.id);
    assert.equal(intact.work.chapters[0].id, collidingChapterId);
    assert.equal((await api.listWorks(db, current.activeSeriesId)).length, 1);
  } finally {
    db.close();
  }
});
