const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('index loads workspace policy/storage before app and controller before extensions', () => {
  const html = read('index.html');
  const names = ['workspace-mode.js', 'storage.js', 'workspace-storage.js', 'app.js', 'chapter-workspace-controller.js', 'workspace-loader.js'];
  let previous = -1;
  for (const name of names) { const index = html.indexOf(name); assert.ok(index > previous, `${name} load order`); previous = index; }
});

test('controller exposes chapter workspace metadata/export and guards commits', () => {
  const code = read('chapter-workspace-controller.js');
  assert.match(code, /getWorkspaceMeta/);
  assert.match(code, /exportChapter/);
  assert.match(code, /assertPatchAllowed\(workspaceMeta, patch, baseWorkspace\.getState\(\)\)/);
  assert.match(code, /root\.NovelWorkspace\s*=\s*Object\.freeze/);
});

test('controller lazy-loads archive modules in dependency order and imports chapter packs through saveChapterWorkspace', () => {
  const code = read('chapter-workspace-controller.js');
  const names = ['archive-common.js', 'chapter-bundle.js', 'archive.js', 'chapter-archive.js'];
  let previous = -1;
  for (const name of names) { const index = code.indexOf(name); assert.ok(index > previous, `${name} import order`); previous = index; }
  assert.match(code, /NovelArchiveCommon\.readArchive/);
  assert.match(code, /NovelChapterArchive\.importChapterArchiveRead/);
  assert.match(code, /NovelStorage\.saveChapterWorkspace/);
});

test('chapter mode Ctrl/Cmd+S routes to chapter export', () => {
  const code = read('chapter-workspace-controller.js');
  assert.match(code, /event\.key\.toLowerCase\(\)\s*!==\s*['"]s['"]/);
  assert.match(code, /event\.stopImmediatePropagation\(\)/);
  assert.match(code, /exportChapter\(workspaceMeta\.loadedChapterIds\[0\]\)/);
});

test('chapter file operations track composition and image loads before export/import', () => {
  const code = read('chapter-workspace-controller.js');
  assert.match(code, /operationImageLoads/);
  assert.match(code, /compositionDepth/);
  assert.match(code, /beginImageLoad\(\)/);
  assert.match(code, /入力・画像の読み込みが終わってから/);
});
