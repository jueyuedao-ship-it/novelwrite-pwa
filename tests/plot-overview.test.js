const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEmptyOverview,
  normalizeOverview,
  isForeshadowResolved,
  storageKey
} = require('../plot-overview.js');

test('createEmptyOverview returns editable overview defaults', () => {
  assert.deepEqual(createEmptyOverview(), {
    genre: '',
    tone: '',
    theme: '',
    publicSetting: '',
    secretSetting: '',
    finalGoal: '',
    climax: '',
    ending: '',
    aftertaste: '',
    productionNotes: '',
    foreshadows: []
  });
});

test('normalizeOverview preserves supported fields and repairs foreshadows', () => {
  const value = normalizeOverview({
    genre: 'SF',
    publicSetting: '表設定',
    foreshadows: [{ id: 'f-1', title: '時計', status: 'installed', importance: 'high' }, null]
  });

  assert.equal(value.genre, 'SF');
  assert.equal(value.publicSetting, '表設定');
  assert.equal(value.foreshadows.length, 1);
  assert.deepEqual(value.foreshadows[0], {
    id: 'f-1',
    title: '時計',
    setup: '',
    hints: '',
    target: '',
    resolution: '',
    status: 'installed',
    importance: 'high'
  });
});

test('normalizeOverview rejects unsupported status and importance values', () => {
  const value = normalizeOverview({
    foreshadows: [{ id: 'f-1', status: 'unknown', importance: 'critical' }]
  });

  assert.equal(value.foreshadows[0].status, 'planned');
  assert.equal(value.foreshadows[0].importance, 'medium');
});

test('isForeshadowResolved is true only for resolved items', () => {
  assert.equal(isForeshadowResolved({ status: 'resolved' }), true);
  assert.equal(isForeshadowResolved({ status: 'partial' }), false);
  assert.equal(isForeshadowResolved({ status: 'installed' }), false);
});

test('storageKey is scoped to a work id', () => {
  assert.equal(storageKey('work-123'), 'fumizukue.plot-overview.v1:work-123');
});
