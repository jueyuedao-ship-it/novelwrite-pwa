const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('topbar exposes a dedicated Series ZIP restore control without replacing Work ZIP import', () => {
  const html = read('index.html');
  assert.match(html, /id=["']import-button["'][^>]*>作品ZIPを開く<\/button>/);
  assert.match(html, /id=["']import-series-button["'][^>]*>シリーズZIPを開く<\/button>/);
  assert.match(html, /id=["']import-series-file["'][^>]*type=["']file["'][^>]*accept=["'][^"']*\.zip[^"']*["'][^>]*hidden/);
});

test('series controller validates, preflights, confirms replacement, restores, and reloads', () => {
  const source = read('series.js');
  assert.match(source, /async function importSeries\(file\)/);
  assert.match(source, /importSeriesArchive\(file\)/);
  assert.match(source, /inspectSeriesRestore\(/);
  assert.match(source, /inspection\.mode\s*===\s*['"]replace['"]/);
  assert.match(source, /root\.confirm\(/);
  assert.match(source, /restoreSeries\(/);
  assert.match(source, /location\.reload\(\)/);
  assert.match(source, /import-series-file/);
  assert.match(source, /input\.value\s*=\s*['"]["']/);
});

test('chapter workspace disables Series ZIP restore while leaving master Work ZIP import enabled', () => {
  const seriesSource = read('series.js');
  const chapterSource = read('chapter-workspace-controller.js');
  assert.match(seriesSource, /import-series-button/);
  assert.match(seriesSource, /seriesImportButton\.disabled\s*=\s*chapterMode/);
  assert.match(chapterSource, /import-series-button/);
  assert.match(chapterSource, /seriesImportButton\.disabled\s*=\s*chapterMode/);
  assert.match(chapterSource, /importButton\.disabled\s*=\s*false/);
  assert.match(chapterSource, /マスター作品ZIPを開く/);
});
