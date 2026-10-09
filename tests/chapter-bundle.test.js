const test = require('node:test');
const assert = require('node:assert/strict');

function load() { return require('../chapter-bundle.js'); }

const blob = (text, type = 'image/png') => new Blob([text], { type });

function sourcePackage() {
  const workId = 'work-1';
  const chapters = [
    { id: 'chapter-a', workId, title: 'A', order: 0 },
    { id: 'chapter-b', workId, title: 'B', order: 1 }
  ];
  const character = (id, name, imageIds = []) => ({
    id, workId, name, role: '', description: '', appearance: '', personality: '', goal: '', background: '', relationshipNotes: '', customFields: [], imageIds
  });
  const episodes = [
    { id: 'ep-a1', workId, chapterId: 'chapter-a', title: 'A1', order: 0, lines: [
      { id: 'line-a1', speaker: 'L', characterId: 'character-line', text: 'abc' }
    ]},
    { id: 'ep-a2', workId, chapterId: 'chapter-a', title: 'A2', order: 1, lines: [
      { id: 'line-a2', speaker: '', characterId: null, text: 'de' }
    ]},
    { id: 'ep-b1', workId, chapterId: 'chapter-b', title: 'B1', order: 0, lines: [
      { id: 'line-b1', speaker: '', characterId: 'character-unused', text: 'uvwxyz' }
    ]}
  ];
  const scenes = [
    { id: 'scene-a', workId, chapterId: 'chapter-a', episodeId: 'ep-a1', order: 0, startLineId: 'line-a1', endLineId: 'line-a1', summary: 's', purpose: '', characterIds: ['character-scene'], viewpoint: '', location: '', time: '', notes: '', imageIds: ['image-scene'], nextImageNumber: 2 },
    { id: 'scene-a-chapter', workId, chapterId: 'chapter-a', episodeId: null, order: 0, startLineId: null, endLineId: null, summary: '', purpose: '', characterIds: [], viewpoint: '', location: '', time: '', notes: '', imageIds: [], nextImageNumber: 1 },
    { id: 'scene-b', workId, chapterId: 'chapter-b', episodeId: 'ep-b1', order: 0, startLineId: 'line-b1', endLineId: 'line-b1', summary: '', purpose: '', characterIds: [], viewpoint: '', location: '', time: '', notes: '', imageIds: ['image-unused'], nextImageNumber: 2 }
  ];
  const characters = [
    character('character-line', 'Line', ['image-character']),
    character('character-scene', 'Scene'),
    character('character-unused', 'Unused')
  ];
  const images = [
    { id: 'image-scene', workId, ownerType: 'scene', ownerId: 'scene-a', order: 0, name: 'scene.png', mimeType: 'image/png', referenceNumber: 1 },
    { id: 'image-character', workId, ownerType: 'character', ownerId: 'character-line', order: 0, name: 'character.png', mimeType: 'image/png', referenceNumber: null },
    { id: 'image-unused', workId, ownerType: 'scene', ownerId: 'scene-b', order: 0, name: 'unused.png', mimeType: 'image/png', referenceNumber: 1 }
  ];
  return {
    work: { schemaVersion: 4, id: workId, title: 'Work', summary: 'Summary', chapters, episodes, scenes, characters, images },
    images: images.map(image => ({ id: image.id, mimeType: image.mimeType, blob: blob(image.id) }))
  };
}

test('buildChapterBundle extracts the selected chapter and its closed references', async () => {
  const { buildChapterBundle } = load();
  const source = sourcePackage();
  const bundle = await buildChapterBundle(source, 'chapter-a');
  assert.equal(bundle.chapter.id, 'chapter-a');
  assert.deepEqual(bundle.episodes.map(item => item.chapterId), ['chapter-a', 'chapter-a']);
  assert.ok(bundle.scenes.every(scene => scene.chapterId === 'chapter-a'));
  assert.deepEqual(bundle.characters.map(item => item.id).sort(), ['character-line', 'character-scene']);
  assert.equal(bundle.catalog.length, source.work.chapters.length);
  assert.equal(bundle.catalog[0].episodeCount, 2);
  assert.equal(bundle.catalog[0].textLength, 5);
  assert.ok(bundle.images.some(image => image.ownerType === 'scene'));
  assert.ok(bundle.images.some(image => image.ownerType === 'character'));
  assert.ok(!bundle.episodes.some(item => item.id === 'ep-b1'));
  assert.ok(!bundle.scenes.some(item => item.id === 'scene-b'));
  assert.ok(!bundle.characters.some(item => item.id === 'character-unused'));
  assert.ok(!bundle.images.some(item => item.id === 'image-unused'));
});

test('validateChapterBundle rejects broken dependency closure and identity mismatches', async t => {
  const { buildChapterBundle, validateChapterBundle } = load();
  const base = await buildChapterBundle(sourcePackage(), 'chapter-a');
  const clone = value => structuredClone(value);
  const cases = [
    ['wrong work id', b => { b.chapter.workId = 'other'; }],
    ['episode assigned elsewhere', b => { b.episodes[0].chapterId = 'chapter-b'; }],
    ['scene chapter mismatch', b => { b.scenes[0].chapterId = 'chapter-b'; }],
    ['missing referenced character', b => { b.characters = b.characters.filter(c => c.id !== 'character-line'); }],
    ['missing referenced image', b => { b.images = b.images.filter(i => i.id !== 'image-scene'); }],
    ['image owner mismatch', b => { b.images.find(i => i.id === 'image-scene').ownerId = 'scene-a-chapter'; }],
    ['duplicate ids', b => { b.scenes[0].id = b.episodes[0].id; }],
    ['zero episodes', b => { b.episodes = []; b.scenes = b.scenes.filter(s => s.episodeId === null); }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = clone(base); mutate(value);
    assert.throws(() => validateChapterBundle(value));
  });
});

test('chapterBundleToPackage produces a one-chapter partial package', async () => {
  const { buildChapterBundle, chapterBundleToPackage } = load();
  const bundle = await buildChapterBundle(sourcePackage(), 'chapter-a');
  const value = chapterBundleToPackage(bundle);
  assert.equal(value.work.id, 'work-1');
  assert.deepEqual(value.work.chapters.map(c => c.id), ['chapter-a']);
  assert.deepEqual(value.work.episodes.map(e => e.id), ['ep-a1', 'ep-a2']);
  assert.deepEqual(value.images.map(i => i.id).sort(), ['image-character', 'image-scene']);
  assert.ok(value.work.images.every(image => !('blob' in image)));
});

test('canonicalChapterValue ignores shared snapshots but changes for chapter-owned content', async () => {
  const { buildChapterBundle, canonicalChapterValue } = load();
  const bundle = await buildChapterBundle(sourcePackage(), 'chapter-a');
  const hashes = { 'image-scene': 'a'.repeat(64) };
  const serialize = value => JSON.stringify(canonicalChapterValue(value, hashes));
  const base = serialize(bundle);

  const shared = structuredClone(bundle);
  shared.characters[0].name = 'Changed shared name';
  shared.catalog[0].title = 'Changed catalog';
  shared.sourceWork.summary = 'Changed summary';
  assert.equal(serialize(shared), base);

  for (const mutate of [
    b => { b.chapter.title = 'changed'; },
    b => { b.episodes[0].lines[0].text = 'changed'; },
    b => { b.scenes[0].summary = 'changed'; },
    b => { b.images.find(i => i.id === 'image-scene').name = 'changed.png'; }
  ]) {
    const next = structuredClone(bundle); mutate(next);
    assert.notEqual(serialize(next), base);
  }
  assert.notEqual(JSON.stringify(canonicalChapterValue(bundle, { 'image-scene': 'b'.repeat(64) })), base);
});
