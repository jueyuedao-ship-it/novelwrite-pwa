const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('index loads the series storage and ordering layers before schema composition and app boot', () => {
  const html = read('index.html');
  const storage = html.indexOf('<script src="./series-storage.js"></script>');
  const ordering = html.indexOf('<script src="./series-ordering.js"></script>');
  const schema = html.indexOf('<script src="./series-schema.js"></script>');
  const app = html.indexOf('<script src="./app.js"></script>');
  const series = html.indexOf('<script src="./series.js"></script>');
  assert.ok(storage >= 0, 'series-storage.js must be loaded');
  assert.ok(ordering >= 0, 'series-ordering.js must be loaded');
  assert.ok(series >= 0, 'series.js must be loaded');
  assert.ok(storage < ordering, 'series-ordering.js must decorate the Series storage layer');
  assert.ok(ordering < schema, 'ordering must be composed before the v6 schema layer');
  assert.ok(schema < app, 'Series storage layers must be ready before app boot');
  assert.ok(app < series, 'series.js must initialize after NovelWorkspace exists');
});

test('index exposes Series settings inside the Plot panel without a Series tab', () => {
  const html = read('index.html');
  const plotStart = html.indexOf('id="screen-plot"');
  const charactersStart = html.indexOf('id="screen-characters"');
  const plot = html.slice(plotStart, charactersStart);
  assert.doesNotMatch(html, /id="tab-series"/);
  assert.doesNotMatch(html, /id="screen-series"/);
  assert.match(plot, /id="series-settings-panel"/);
  assert.match(plot, /id="series-title"/);
  assert.match(plot, /id="series-summary"/);
  assert.match(plot, /id="series-works"/);
  assert.match(plot, /id="series-add-work"/);
});

test('service worker precaches all Series UI and archive assets', () => {
  const sw = read('sw.js');
  assert.match(sw, /series-storage\.js/);
  assert.match(sw, /series-ordering\.js/);
  assert.match(sw, /series\.js/);
  assert.match(sw, /series\.css/);
  assert.match(sw, /series-archive\.js/);
});
