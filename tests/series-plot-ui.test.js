const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function panel(html, id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.notEqual(start, -1, `${id} must exist`);
  const next = html.indexOf('<section id="screen-', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}

test('series is not exposed as a top-level navigation tab or standalone screen', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /id="tab-series"/);
  assert.doesNotMatch(html, /id="screen-series"/);
});

test('plot screen contains series settings and work management before the plot extension', () => {
  const html = read('index.html');
  const plot = panel(html, 'screen-plot');
  const settingsIndex = plot.indexOf('id="series-settings-panel"');
  const extensionIndex = plot.indexOf('id="plot-extension"');

  assert.ok(settingsIndex >= 0, 'series settings panel must be inside the plot screen');
  assert.ok(extensionIndex > settingsIndex, 'series settings must appear before the plot extension');
  assert.match(plot, /id="series-title"/);
  assert.match(plot, /id="series-summary"/);
  assert.match(plot, /id="series-add-work"/);
  assert.match(plot, /id="series-works"/);
});

test('series controller behaves as a plot widget instead of owning screen navigation', () => {
  const source = read('series.js');
  assert.doesNotMatch(source, /tab-series|screen-series|showSeriesScreen|leaveSeriesScreen/);
  assert.match(source, /tab-plot/);
  assert.match(source, /render/);
});

test('service worker cache generation changes so installed PWAs receive series archive UI', () => {
  const sw = read('sw.js');
  assert.match(sw, /fumizukue-series-chapter-v7/);
  assert.match(sw, /series-archive\.js/);
});
