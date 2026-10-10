const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('service worker caches every chapter and series workspace runtime asset under the combined cache version', () => {
  const sw = read('sw.js');
  assert.match(sw, /fumizukue-series-chapter-v8/);
  for (const asset of [
    'chapter-workspace.css', 'workspace-mode.js', 'workspace-storage.js', 'archive-common.js',
    'chapter-bundle.js', 'chapter-archive.js', 'chapter-workspace-controller.js',
    'series.css', 'series-storage.js', 'series-schema.js', 'series.js', 'series-archive.js'
  ]) {
    assert.ok(sw.includes(`./${asset}`), `${asset} must be cached`);
  }
});

test('README documents Phase 1 chapter workspace behavior and limitations', () => {
  const readme = read('README.md');
  assert.match(readme, /fumizukue-chapter-archive/);
  assert.match(readme, /章ワークスペース/);
  assert.match(readme, /参照専用/);
  assert.match(readme, /Phase 1/);
  assert.match(readme, /マスターへの再統合/);
});

test('chapter mode does not load the local-only detailed overview companion', () => {
  const loader = read('workspace-loader.js');
  assert.match(loader, /chapterMode/);
  assert.match(loader, /screen\.companionModule && !chapterMode/);
  assert.match(loader, /screen\.companionGlobalName && !chapterMode/);
});
