const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
const NovelModel = require('../model');
const baseStorage = require('../storage');

const DB_NAME = 'fumizukue-integrated-work';
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const scripts = [
  'model.js', 'core.js', 'editor-state.js', 'migration.js', 'package.js',
  'workspace-mode.js', 'storage.js', 'series-storage.js', 'series-schema.js',
  'workspace-storage.js', 'app.js', 'series.js'
];

async function waitFor(check, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('diagnostic database deletion blocked'));
  });
}

async function bootRuntime() {
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', error => runtimeErrors.push(error));
  virtualConsole.on('error', error => runtimeErrors.push(error));

  const dom = new JSDOM(read('index.html'), {
    url: 'https://example.test/novelwrite-pwa/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  Object.defineProperty(window, 'indexedDB', { value: indexedDB, configurable: true });
  Object.defineProperty(window, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  window.structuredClone = structuredClone;
  window.confirm = () => true;
  window.CSS ||= {};
  window.CSS.escape ||= value => String(value);
  window.CSS.supports ||= () => false;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  if (window.HTMLDialogElement) {
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  }
  for (const file of scripts) window.eval(`${read(file)}\n//# sourceURL=${file}`);
  await waitFor(() => window.document.getElementById('main').dataset.ready === 'true', 'app boot');
  return { dom, window, runtimeErrors };
}

async function assertSeriesScreen(window, expectedTitle) {
  assert.equal(window.document.getElementById('app').getAttribute('aria-busy'), 'false');
  assert.match(window.document.getElementById('save-status').textContent, /保存済み/);
  window.document.getElementById('tab-series').click();
  await waitFor(() => !window.document.getElementById('screen-series').hidden, 'Series screen');
  await waitFor(() => window.document.querySelectorAll('.series-work-card').length === 1, 'Series work card');
  assert.equal(window.document.querySelectorAll('.series-work-card').length, 1);
  if (expectedTitle) assert.equal(window.document.querySelector('.series-work-card h3').textContent, expectedTitle);
  assert.ok(window.document.getElementById('series-title').value.length > 0);
}

test('clean browser runtime boots and renders the Series screen', async () => {
  await deleteDatabase();
  const { dom, window, runtimeErrors } = await bootRuntime();
  await assertSeriesScreen(window);
  assert.equal(runtimeErrors.length, 0, runtimeErrors.map(error => error.stack || error.message).join('\n'));
  window.close();
  await deleteDatabase();
});

test('browser runtime upgrades an existing v4 work and renders it in Series', async () => {
  await deleteDatabase();
  const work = NovelModel.createWork({ title: '既存作品' });
  const legacyDb = await baseStorage.openStore({ indexedDB, name: DB_NAME, version: 4 });
  await baseStorage.saveWork(legacyDb, { work, images: [] });
  legacyDb.close();

  const { window, runtimeErrors } = await bootRuntime();
  await assertSeriesScreen(window, '既存作品');
  assert.equal(window.NovelStorage.SERIES_DATABASE_VERSION, 6);
  assert.equal(runtimeErrors.length, 0, runtimeErrors.map(error => error.stack || error.message).join('\n'));
  window.close();
  await deleteDatabase();
});
