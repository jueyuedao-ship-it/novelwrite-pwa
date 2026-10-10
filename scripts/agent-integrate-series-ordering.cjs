const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`${label} marker not found`);
  return source.replace(before, after);
}

// Series importer: manifest order is user-controlled order; do not require ID sorting.
{
  const path = 'series-archive.js';
  let source = fs.readFileSync(path, 'utf8');
  source = source.replace('    let previousId = null;\n', '');
  source = source.replace(
    "      if (previousId !== null && previousId.localeCompare(item.id) >= 0) {\n        throw new Error('シリーズZIP内の作品IDの並び順が不正です。');\n      }\n",
    ''
  );
  source = source.replace('      previousId = item.id;\n', '');
  fs.writeFileSync(path, source);
}

// Atomic restore: persist manifest sequence directly on Work rows so the ordering layer preserves it.
{
  const path = 'series-storage.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    '            for (const value of normalized.works) {\n              const previous = existingById.get(value.work.id);',
    '            for (const [order, value] of normalized.works.entries()) {\n              const previous = existingById.get(value.work.id);',
    'restore work enumeration'
  );
  source = replaceOnce(
    source,
    "                workRecordExtras: { seriesId: normalized.series.id }",
    "                workRecordExtras: { seriesId: normalized.series.id, order }",
    'restore work order extras'
  );
  fs.writeFileSync(path, source);
}

// Resolve Series archive test conflict by keeping restore coverage and adopting manifest/display order.
{
  const path = 'tests/series-archive.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = source.replace(
    "test('series archive wraps id-sorted valid work archives with hashes and active work metadata'",
    "test('series archive preserves supplied work order with hashes and active work metadata'"
  );
  source = source.replace(
    "assert.deepEqual(read.manifest.works.map(item => item.id), ['work-a', 'work-z']);",
    "assert.deepEqual(read.manifest.works.map(item => item.id), ['work-z', 'work-a']);"
  );
  source = source.replace(
    "assert.deepEqual(restored.works.map(item => item.work.id), ['work-a', 'work-b']);\n  assert.deepEqual(restored.works.map(item => item.work.title), ['第一作', '第二作']);",
    "assert.deepEqual(restored.works.map(item => item.work.id), ['work-b', 'work-a']);\n  assert.deepEqual(restored.works.map(item => item.work.title), ['第二作', '第一作']);"
  );
  source = source.replace(
    "test('series archive import enforces sorted unique work ids and canonical unique paths'",
    "test('series archive import enforces unique work ids and canonical unique paths'"
  );
  source = source.replace(
    "  const unsorted = await rewriteSeriesArchive(blob, { mutateManifest: manifest => { manifest.works.reverse(); } });\n",
    ''
  );
  source = source.replace(
    "  await assert.rejects(() => seriesArchive.importSeriesArchive(unsorted), /並び順|作品一覧/);\n",
    ''
  );
  fs.writeFileSync(path, source);
}

// Resolve Plot UI test conflict by requiring both ordering and restore runtime assets.
{
  const path = 'tests/series-plot-ui.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = source.replace(
    "test('service worker cache generation changes so installed PWAs receive series archive UI'",
    "test('service worker cache generation includes series ordering and archive restore UI'"
  );
  if (!source.includes("assert.match(sw, /series-ordering\\.js/);")) {
    source = replaceOnce(
      source,
      "  assert.match(sw, /fumizukue-series-chapter-v9/);\n  assert.match(sw, /series-archive\\.js/);",
      "  assert.match(sw, /fumizukue-series-chapter-v9/);\n  assert.match(sw, /series-ordering\\.js/);\n  assert.match(sw, /series-archive\\.js/);",
      'plot PWA ordering asset'
    );
  }
  fs.writeFileSync(path, source);
}

// Restore tests: prove non-ID manifest order is stored atomically.
{
  const path = 'tests/series-restore-storage.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "    const value = restoreValue('series-restored', [withWorkId('work-a', 'A'), withWorkId('work-b', 'B')], 'work-b');",
    "    const value = restoreValue('series-restored', [withWorkId('work-b', 'B'), withWorkId('work-a', 'A')], 'work-b');",
    'restore manifest order fixture'
  );
  source = replaceOnce(
    source,
    "    assert.equal((await api.loadWork(db, 'work-b')).work.title, 'B');\n    assert.deepEqual(result.workspaceMeta,",
    "    assert.equal((await api.loadWork(db, 'work-b')).work.title, 'B');\n    assert.equal((await rawWork(db, 'work-b')).order, 0);\n    assert.equal((await rawWork(db, 'work-a')).order, 1);\n    assert.deepEqual(result.workspaceMeta,",
    'restore stored order assertions'
  );
  fs.writeFileSync(path, source);
}

// Spec: align the accepted restore contract with the newly merged user-controlled ordering feature.
{
  const path = 'docs/superpowers/specs/2026-10-10-series-archive-restore-design.md';
  let source = fs.readFileSync(path, 'utf8');
  source = source.replace(
    'The current exporter orders `works` by Work ID ascending. The importer treats that deterministic ordering as part of the v1 contract.',
    'The current exporter preserves the user-controlled Work order in the manifest. The importer treats manifest order as the Series Work order to restore.'
  );
  source = source.replace(
    '7. Require unique Work IDs and require the manifest Work list to be sorted by Work ID ascending.\n8. Require unique paths and canonical paths in exact sequence: `works/0001.zip`, `works/0002.zip`, ...',
    '7. Require unique Work IDs while preserving manifest order.\n8. Require unique paths and canonical paths in exact sequence: `works/0001.zip`, `works/0002.zip`, ...; this sequence defines restored Work order.'
  );
  source = source.replace('duplicate or unsorted Work IDs;', 'duplicate Work IDs;');
  source = source.replace('manifest Work ID ordering and canonical `works/NNNN.zip` paths are enforced;', 'manifest Work order is preserved and canonical `works/NNNN.zip` paths are enforced;');
  source = source.replace(
    '- Restore `activeWorkId` from the Series manifest.',
    '- Restore `activeWorkId` from the Series manifest.\n- Preserve the user-controlled Work order encoded by the manifest sequence.'
  );
  source = source.replace(
    '4. Write every restored Work and all child rows.',
    '4. Write every restored Work and all child rows, persisting its manifest position as the Work `order`.'
  );
  fs.writeFileSync(path, source);
}

// Plan: update execution notes so the checked-in plan explains the integration decision.
{
  const path = 'docs/superpowers/plans/2026-10-10-series-archive-restore.md';
  let source = fs.readFileSync(path, 'utf8');
  source = source.replace(
    'where `works` is the fully validated Work-package array sorted by Work ID ascending.',
    'where `works` is the fully validated Work-package array in manifest/user-controlled order.'
  );
  source = source.replace('extra entries, non-canonical paths, duplicate/unsorted Work IDs', 'extra entries, non-canonical paths, duplicate Work IDs');
  source = source.replace('Work ID ascending order, exact canonical', 'manifest Work order, exact canonical');
  source = source.replace('unsorted Work IDs\n', '');
  source = source.replace(
    "workRecordExtras: { seriesId: restoreValue.series.id }",
    "workRecordExtras: { seriesId: restoreValue.series.id, order }"
  );
  fs.writeFileSync(path, source);
}
