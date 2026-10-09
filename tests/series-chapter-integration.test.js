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
const dbName = label => `fumizukue-series-chapter-${label}-${Date.now()}-${Math.random()}`;

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => {};
  });
}

async function seedChapterWorkspaceV5(name) {
  const work = NovelModel.createWork({ title: '既存の章ワークスペース' });
  const v4 = await baseStorage.openStore({ indexedDB, name, version: 4 });
  await baseStorage.saveWork(v4, { work, images: [] });
  v4.close();

  const meta = workspaceMode.createChapterWorkspaceMeta({
    sourceWork: { id: work.id },
    catalog: work.chapters.map((chapter, order) => ({
      id: chapter.id,
      title: chapter.title,
      order,
      episodeCount: work.episodes.filter(episode => episode.chapterId === chapter.id).length,
      textLength: 0
    })),
    chapter: work.chapters[0]
  }, 'a'.repeat(64), '2026-10-09T00:00:00.000Z');

  await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      const store = db.objectStoreNames.contains('workspaceMeta')
        ? tx.objectStore('workspaceMeta')
        : db.createObjectStore('workspaceMeta', { keyPath: 'id' });
      store.put(meta);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
  return { work, meta };
}

function composedStorage() {
  const series = createSeriesStorage({ baseStorage, packageTools: NovelPackage, indexedDB });
  const context = {
    NovelStorage: series,
    NovelWorkspaceMode: workspaceMode,
    indexedDB,
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read('series-schema.js'), context, { filename: 'series-schema.js' });
  vm.runInContext(read('workspace-storage.js'), context, { filename: 'workspace-storage.js' });
  return context.NovelStorage;
}

test('existing v5 chapter workspace upgrades to v6 while preserving both metadata layers', async () => {
  const name = dbName('upgrade');
  const { work, meta: originalChapterMeta } = await seedChapterWorkspaceV5(name);
  const api = composedStorage();
  const db = await api.openStore({ indexedDB, name });
  try {
    assert.equal(db.version, 6);
    assert.ok(db.objectStoreNames.contains('series'));
    assert.ok(db.objectStoreNames.contains('workspaceMeta'));

    const seriesMeta = await api.getWorkspaceMeta(db);
    assert.equal(seriesMeta.activeWorkId, work.id);
    assert.ok(seriesMeta.activeSeriesId);

    const chapterMeta = await api.loadWorkspaceMeta(db);
    assert.deepEqual(chapterMeta, originalChapterMeta);

    const works = await api.listWorks(db, seriesMeta.activeSeriesId);
    assert.equal(works.length, 1);
    assert.equal(works[0].id, work.id);
    assert.equal((await api.loadWork(db)).work.id, work.id);
    assert.equal(await api.loadWorkRevision(db), 1);

    const tx = db.transaction('workspaceMeta', 'readonly');
    const keysRequest = tx.objectStore('workspaceMeta').getAllKeys();
    const keys = await new Promise((resolve, reject) => {
      keysRequest.onsuccess = () => resolve(keysRequest.result);
      keysRequest.onerror = () => reject(keysRequest.error);
    });
    await transactionDone(tx);
    assert.deepEqual(keys.slice().sort(), ['active', 'current']);
  } finally {
    db.close();
  }
});

test('script order composes Series storage before chapter-workspace storage and both before app boot', () => {
  const html = read('index.html');
  const storage = html.indexOf('<script src="./storage.js"></script>');
  const series = html.indexOf('<script src="./series-storage.js"></script>');
  const schema = html.indexOf('<script src="./series-schema.js"></script>');
  const chapterStorage = html.indexOf('<script src="./workspace-storage.js"></script>');
  const app = html.indexOf('<script src="./app.js"></script>');
  assert.ok(storage < series && series < schema && schema < chapterStorage && chapterStorage < app);
});

test('series UI blocks work switching while chapter-workspace metadata is active', () => {
  const seriesUi = read('series.js');
  assert.match(seriesUi, /loadWorkspaceMeta/);
  assert.match(seriesUi, /chapter-workspace/);
  assert.match(seriesUi, /章ワークスペース中はシリーズや作品を切り替えられません/);
  assert.match(seriesUi, /await assertFullWorkMode\(\)/);
});
