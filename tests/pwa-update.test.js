const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('service worker activates a newly installed app shell without waiting for old clients to close', () => {
  const sw = read('sw.js');
  assert.match(sw, /fumizukue-series-chapter-v8/);
  assert.match(sw, /self\.skipWaiting\(\)/);
});

test('an already-controlled page reloads after the new service worker takes control', () => {
  const pwa = read('pwa.js');
  assert.match(pwa, /navigator\.serviceWorker\.controller/);
  assert.match(pwa, /controllerchange/);
  assert.match(pwa, /location\.reload\(\)/);
  assert.match(pwa, /save-status/);
});
