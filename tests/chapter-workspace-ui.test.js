const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('chapter workspace UI has stable status, catalog and import controls', () => {
  const html = read('index.html');
  assert.match(html, /id="workspace-mode-strip"/);
  assert.match(html, /id="chapter-catalog"/);
  assert.match(html, /id="import-chapter-button"/);
  assert.match(html, /id="import-chapter-file"/);
});

test('controller renders unloaded catalog rows distinctly', () => {
  const code = read('chapter-workspace-controller.js');
  assert.match(code, /chapter-catalog-row/);
  assert.match(code, /chapter-catalog-unloaded/);
  assert.match(code, /この章のデータは読み込まれていません/);
  assert.match(code, /作品全体ではありません/);
});

test('controller adds chapter ZIP export actions to plot chapter rows', () => {
  const code = read('chapter-workspace-controller.js');
  assert.match(code, /plot-structure-row/);
  assert.match(code, /dataset\.chapterId/);
  assert.match(code, /章ZIP保存/);
  assert.match(code, /exportChapter\(chapterId\)/);
});
