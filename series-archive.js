/* Series ZIP export wraps existing full-work archives without changing their format. */
(function (root) {
  'use strict';

  let common = typeof module !== 'undefined' && module.exports ? require('./archive-common') : root.NovelArchiveCommon;
  let workArchive = typeof module !== 'undefined' && module.exports ? require('./archive') : root.NovelArchive;
  let dependencyPromise;

  const FORMAT = 'fumizukue-series-archive';
  const FORMAT_VERSION = 1;

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
    if (!series || typeof series !== 'object' || Array.isArray(series) ||
        typeof series.id !== 'string' || !series.id || typeof series.title !== 'string' || typeof series.summary !== 'string') {
      throw new Error('シリーズ情報が不正です。');
    }
    return { id: series.id, title: series.title, summary: series.summary };
  }

  function normalizeWorks(works) {
    if (!Array.isArray(works) || works.length === 0) throw new Error('シリーズに保存する作品がありません。');
    const ids = new Set();
    const normalized = works.map(item => {
      const id = item?.work?.id;
      if (typeof id !== 'string' || !id) throw new Error('シリーズ内の作品IDが不正です。');
      if (ids.has(id)) throw new Error('シリーズ内に同じ作品IDが重複しています。');
      ids.add(id);
      return item;
    });
    return normalized.sort((left, right) => String(left.work.id).localeCompare(String(right.work.id)));
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

  const api = { exportSeriesArchive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelSeriesArchive = api;
})(globalThis);