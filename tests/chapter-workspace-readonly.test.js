const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '..', 'chapter-workspace-controller.js'), 'utf8');

test('chapter mode disables work title and plot overview editing', () => {
  assert.match(code, /work-title/);
  assert.match(code, /plot-overview-text/);
  assert.match(code, /plot-overview-detail-button/);
  assert.match(code, /詳細設定はマスター作品で編集してください/);
});

test('chapter mode marks character data as a read-only master snapshot', () => {
  assert.match(code, /characters-extension/);
  assert.match(code, /character-readonly-note/);
  assert.match(code, /マスター作品のスナップショット/);
  assert.match(code, /input, textarea, select/);
});

test('chapter mode keeps master-level destructive controls disabled', () => {
  assert.match(code, /reset/);
  assert.match(code, /load-sample/);
  assert.match(code, /chapter-workspace/);
});
