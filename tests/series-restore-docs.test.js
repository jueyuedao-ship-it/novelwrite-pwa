const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('README documents Series ZIP restore and replacement semantics', () => {
  assert.match(readme, /シリーズZIPを開く/);
  assert.match(readme, /同じシリーズ|同一シリーズ|同じSeries/);
  assert.match(readme, /置き換え/);
  assert.match(readme, /ID.*衝突|衝突.*ID/);
  assert.match(readme, /最後に開いていた作品|activeWorkId/);
  assert.doesNotMatch(readme, /シリーズZIPの読み込み・復元は未実装/);
  assert.doesNotMatch(readme, /シリーズZIPの読み込みは今後/);
});
