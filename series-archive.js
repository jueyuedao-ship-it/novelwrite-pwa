/* Series ZIP export/import wraps existing full-work archives without changing their format. */
(function (root) {
  'use strict';

  let common = typeof module !== 'undefined' && module.exports ? require('./archive-common') : root.NovelArchiveCommon;
  let workArchive = typeof module !== 'undefined' && module.exports ? require('./archive') : root.NovelArchive;
  let dependencyPromise;

  const FORMAT = 'fumizukue-series-archive';
  const FORMAT_VERSION = 1;
  const HASH_PATTERN = /^[a-f0-9]{64}$/;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  async function ensureDependencies() {
    if (common && workArchive) return { common, workArchive };
    if (!dependencyPromise) {
      dependencyPromise = (async () => {
        if (!common) {
          await import('./archive-common.js');
          common = root.NovelArchiveCommon;
        }
        if (!workArchive) {
          await import('./archive.js');
          workArchive = root.NovelArchive;
        }
        if (!common || !workArchive) throw new Error('シリーズZIP処理モジュールを読み込めませんでした。');
        return { common, workArchive };
      })().catch(error => { dependencyPromise = null; throw error; });
    }
    return dependencyPromise;
  }

  function seriesMetadata(series) {
    if (!isObject(series) || typeof series.id !== 'string' || !series.id ||
        typeof series.title !== 'string' || typeof series.summary !== 'string') {
      throw new Error('シリーズ情報が不正です。');
    }
    return { id: series.id, title: series.title, summary: series.summary };
  }

  function normalizeWorks(works) {
    if (!Array.isArray(works) || works.length === 0) throw new Error('シリーズに保存する作品がありません。');
    const ids = new Set();
    return works.map(item => {
      const id = item?.work?.id;
      if (typeof id !== 'string' || !id) throw new Error('シリーズ内の作品IDが不正です。');
      if (ids.has(id)) throw new Error('シリーズ内に同じ作品IDが重複しています。');
      ids.add(id);
      return item;
    });
  }

  async function exportSeriesArchive({ series, activeWorkId, works } = {}) {
    const dependencies = await ensureDependencies();
    const metadata = seriesMetadata(series);
    const orderedWorks = normalizeWorks(works);
    if (typeof activeWorkId !== 'string' || !orderedWorks.some(item => item.work.id === activeWorkId)) {
      throw new Error('開いている作品IDがシリーズ内の作品と一致しません。');
    }

    const entries = [];
    const manifestWorks = [];
    for (let index = 0; index < orderedWorks.length; index++) {
      const packageValue = orderedWorks[index];
      const archiveBlob = await dependencies.workArchive.exportArchive(packageValue);
      const bytes = new Uint8Array(await archiveBlob.arrayBuffer());
      const path = `works/${String(index + 1).padStart(4, '0')}.zip`;
      manifestWorks.push({
        id: packageValue.work.id,
        title: packageValue.work.title,
        path,
        sha256: await dependencies.common.sha256(bytes)
      });
      entries.push({ name: path, bytes });
    }

    const manifestBytes = dependencies.common.encodeJson({
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      series: metadata,
      activeWorkId,
      works: manifestWorks
    });
    const allEntries = [{ name: 'manifest.json', bytes: manifestBytes }, ...entries];
    dependencies.common.assertUncompressedBudget(
      allEntries.map(entry => ({ name: entry.name, size: entry.bytes.length }))
    );
    return dependencies.common.writeArchive(allEntries);
  }

  async function importSeriesArchiveRead(readResult) {
    const dependencies = await ensureDependencies();
    if (!readResult || !isObject(readResult.files) || !isObject(readResult.manifest) || !Array.isArray(readResult.entries)) {
      throw new Error('シリーズZIP読み込み結果が不正です。');
    }

    const { files, manifest, entries } = readResult;
    if (manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION) {
      throw new Error('対応していないシリーズZIP形式です。');
    }
    const metadata = seriesMetadata(manifest.series);
    if (!Array.isArray(manifest.works) || manifest.works.length === 0) {
      throw new Error('シリーズZIPに作品がありません。');
    }

    const ids = new Set();
    const paths = new Set();
    for (let index = 0; index < manifest.works.length; index++) {
      const item = manifest.works[index];
      const expectedPath = `works/${String(index + 1).padStart(4, '0')}.zip`;
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' ||
          typeof item.path !== 'string' || item.path !== expectedPath || typeof item.sha256 !== 'string' || !HASH_PATTERN.test(item.sha256)) {
        throw new Error('シリーズZIP内の作品一覧が不正です。');
      }
      if (ids.has(item.id)) throw new Error('シリーズZIP内に同じ作品IDが重複しています。');
      if (paths.has(item.path)) throw new Error('シリーズZIP内に同じ作品パスが重複しています。');
      ids.add(item.id);
      paths.add(item.path);
    }

    if (typeof manifest.activeWorkId !== 'string' || !ids.has(manifest.activeWorkId)) {
      throw new Error('シリーズZIPのactiveWorkIdが作品一覧と一致しません。');
    }

    const expectedNames = new Set(['manifest.json', ...paths]);
    if (entries.some(entry => !expectedNames.has(entry?.name)) || [...expectedNames].some(name => !(files[name] instanceof Uint8Array))) {
      throw new Error('シリーズZIP内のファイル一覧がmanifestと一致しません。');
    }

    const nestedBudget = [];
    for (const item of manifest.works) {
      const bytes = files[item.path];
      if (await dependencies.common.sha256(bytes) !== item.sha256) {
        throw new Error(`作品ZIP ${item.path} のチェックサムが一致しません。`);
      }
      const nestedEntries = dependencies.common.preflightZip(bytes);
      for (const entry of nestedEntries) {
        nestedBudget.push({ name: `${item.path}::${entry.name}`, size: entry.uncompressedSize });
      }
    }
    dependencies.common.assertUncompressedBudget(nestedBudget);

    const works = [];
    for (const item of manifest.works) {
      const bytes = files[item.path];
      const nestedRead = await dependencies.common.readArchive(new Blob([bytes], { type: 'application/zip' }));
      const restored = await dependencies.workArchive.importArchiveRead(nestedRead);
      if (restored.work.id !== item.id) throw new Error('作品ZIPの作品IDがSeries manifestと一致しません。');
      if (restored.work.title !== item.title) throw new Error('作品ZIPの作品名がSeries manifestと一致しません。');
      works.push(restored);
    }

    return { series: metadata, activeWorkId: manifest.activeWorkId, works };
  }

  async function importSeriesArchive(file) {
    const dependencies = await ensureDependencies();
    return importSeriesArchiveRead(await dependencies.common.readArchive(file));
  }

  const api = { exportSeriesArchive, importSeriesArchive, importSeriesArchiveRead };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelSeriesArchive = api;
})(globalThis);