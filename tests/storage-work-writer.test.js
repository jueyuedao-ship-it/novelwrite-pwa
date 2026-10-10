const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const NovelModel = require('../model');
const NovelPackage = require('../package');
const storage = require('../storage');

const STORE_NAMES = ['works', 'chapters', 'episodes', 'episodeBodies', 'scenes', 'characters', 'images', 'imageBlobs', 'lineCharacterRefs', 'idRegistry'];
const dbName = label => `fumizukue-work-writer-${label}-${Date.now()}-${Math.random()}`;

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => {};
  });
}

async function getRow(db, storeName, id) {
  const tx = db.transaction(storeName, 'readonly');
  const request = tx.objectStore(storeName).get(id);
  const value = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await transactionDone(tx);
  return value;
}

test('transaction-local writer stores a validated work without owning transaction lifecycle', async () => {
  const name = dbName('direct');
  const db = await storage.openStore({ indexedDB, name, version: 4 });
  try {
    const work = NovelModel.createWork({ title: '直接保存' });
    const validated = await NovelPackage.validatePackage({ work, images: [] });
    const tx = db.transaction(STORE_NAMES, 'readwrite');
    const done = transactionDone(tx);

    storage.writeValidatedWorkToTransaction(tx, validated, {
      revision: 1,
      workRecordExtras: { seriesId: 'series-x' }
    });
    await done;

    const loaded = await storage.loadWork(db);
    assert.equal(loaded.work.id, work.id);
    assert.equal(loaded.work.title, '直接保存');
    assert.equal(loaded.work.chapters[0].id, work.chapters[0].id);
    assert.equal(loaded.work.episodes[0].lines[0].id, work.episodes[0].lines[0].id);

    const storedWork = await getRow(db, 'works', work.id);
    assert.equal(storedWork.seriesId, 'series-x');
    assert.equal(storedWork._revision, 1);
    assert.equal(validated.work.seriesId, undefined);
  } finally {
    db.close();
  }
});
