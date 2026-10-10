const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('topbar promotes import-button to work ZIP import without a series switch action', () => {
  const html = read('index.html');
  const source = read('series.js');
  assert.match(html, /id=["']import-button["']/);
  assert.match(html, /id=["']import-chapter-button["'][^>]*>章ZIPを開く<\/button>/);
  assert.match(source, /importButton\.textContent\s*=\s*chapterMode\s*\?\s*['"]マスター作品ZIPを開く['"]\s*:\s*['"]作品ZIPを開く['"]/);
  assert.match(source, /importButton\.disabled\s*=\s*false/);
  assert.doesNotMatch(source, /シリーズを切り替える/);
  assert.doesNotMatch(source, /series-switch-dialog/);
  assert.doesNotMatch(source, /openSeriesChooser/);
});

test('work ZIP topbar control remains connected to the existing app import flow', () => {
  const source = read('app.js');
  assert.match(source, /\$\(['"]import-button['"]\)\.addEventListener\(['"]click['"],[\s\S]*\$\(['"]import-file['"]\)\.click\(\)/);
  assert.match(source, /\$\(['"]import-file['"]\)\.addEventListener\(['"]change['"],[\s\S]*importFile\(file\)/);
  assert.match(source, /async function importFile\(file\)/);
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
  assert.match(source, /importButton\.addEventListener\(['"]click['"],[\s\S]*\$\(['"]import-button['"]\)\?\.click\(\)/);
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
  assert.match(source, /reset/);
});

test('chapter workspace controller preserves the Series export label outside chapter mode', () => {
  const source = read('chapter-workspace-controller.js');
  assert.match(source, /chapterMode\s*\?\s*['"]章ZIPで保存\s*['"]\s*:\s*['"]シリーズZIPで保存\s*['"]/);
});

test('chapter workspace keeps a master work ZIP import path to return to full-work mode', () => {
  const source = read('chapter-workspace-controller.js');
  assert.match(source, /import-button/);
  assert.match(source, /マスター作品ZIPを開く/);
  assert.match(source, /importButton\.disabled\s*=\s*false/);
});
