const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('series controller promotes stable topbar controls to series-level actions', () => {
  const source = read('series.js');
  assert.match(source, /シリーズを切り替える/);
  assert.match(source, /シリーズZIPで保存/);
  assert.match(source, /新しいシリーズ/);
  assert.match(source, /import-button/);
  assert.match(source, /export-archive/);
  assert.match(source, /reset/);
  assert.match(source, /addEventListener\(['"]click['"],[\s\S]*capture|\{\s*capture:\s*true\s*\}/);
});

test('series controller builds a chooser and switches through setActiveSeries', () => {
  const source = read('series.js');
  assert.match(source, /series-switch-dialog/);
  assert.match(source, /listSeries/);
  assert.match(source, /listWorks/);
  assert.match(source, /setActiveSeries/);
  assert.match(source, /現在のシリーズ/);
});

test('new series creation uses atomic storage API with one initial work', () => {
  const source = read('series.js');
  assert.match(source, /createSeriesWithInitialWork/);
  assert.match(source, /NovelModel\.createWork/);
});

test('plot series settings expose existing single-work archive handlers through explicit controls', () => {
  const source = read('series.js');
  assert.match(source, /series-export-work/);
  assert.match(source, /series-import-work/);
  assert.match(source, /現在の作品ZIPで保存/);
  assert.match(source, /作品ZIP \/ 旧JSONを開く/);
  assert.match(source, /workActionBypass/);
});

test('series export lazy-loads the series archive and fully loads every work before download', () => {
  const source = read('series.js');
  assert.match(source, /series-archive\.js/);
  assert.match(source, /NovelSeriesArchive/);
  assert.match(source, /loadWork/);
  assert.match(source, /\.series\.zip/);
});

test('chapter workspace leaves chapter ZIP export interception available while blocking series controls', () => {
  const source = read('series.js');
  assert.match(source, /chapter-workspace/);
  assert.match(source, /chapterMode/);
  assert.match(source, /import-button/);
  assert.match(source, /reset/);
});

test('full-work series label is reasserted after later chapter-mode UI mutations', () => {
  const source = read('series.js');
  assert.match(source, /MutationObserver/);
  assert.match(source, /observe\([\s\S]*export-archive|exportButton[\s\S]*observe/);
  assert.match(source, /setTopbarLabels/);
});