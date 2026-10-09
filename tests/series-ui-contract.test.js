const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('index loads the series storage layer before app and the series UI after app', () => {
  const html = read('index.html');
  const storage = html.indexOf('<script src="./series-storage.js"></script>');
  const app = html.indexOf('<script src="./app.js"></script>');
  const series = html.indexOf('<script src="./series.js"></script>');
  assert.ok(storage >= 0, 'series-storage.js must be loaded');
  assert.ok(series >= 0, 'series.js must be loaded');
  assert.ok(storage < app, 'series-storage.js must wrap NovelStorage before app boot');
  assert.ok(app < series, 'series.js must initialize after NovelWorkspace exists');
});

test('index exposes a Series tab and panel', () => {
  const html = read('index.html');
  assert.match(html, /id="tab-series"/);
  assert.match(html, /id="screen-series"/);
  assert.match(html, /id="series-title"/);
  assert.match(html, /id="series-summary"/);
  assert.match(html, /id="series-works"/);
  assert.match(html, /id="series-add-work"/);
});

test('service worker precaches all Series UI assets', () => {
  const sw = read('sw.js');
  assert.match(sw, /series-storage\.js/);
  assert.match(sw, /series\.js/);
  assert.match(sw, /series\.css/);
});
