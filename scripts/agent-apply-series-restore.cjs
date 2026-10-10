const fs = require('node:fs');

const path = 'series-storage.js';
let source = fs.readFileSync(path, 'utf8');
const marker = '    async function deleteWorkRows(db, workId, nextMeta, nextSeries = null) {';
if (!source.includes(marker)) throw new Error('series restore insertion marker not found');

const block = `    async function normalizeSeriesRestore(restoreValue) {
      if (!restoreValue || typeof restoreValue !== 'object' || Array.isArray(restoreValue)) throw new Error('シリーズ復元データが不正です。');
      const inputSeries = restoreValue.series;
      if (!inputSeries || typeof inputSeries !== 'object' || Array.isArray(inputSeries) ||
          typeof inputSeries.id !== 'string' || !inputSeries.id || typeof inputSeries.title !== 'string' || typeof inputSeries.summary !== 'string') {
        throw new Error('復元するシリーズ情報が不正です。');
      }
      if (!Array.isArray(restoreValue.works) || !restoreValue.works.length) throw new Error('復元する作品がありません。');
      const works = [];
      const workIds = new Set();
      const globalIds = new Set();
      const addId = (id, label) => {
        if (typeof id !== 'string' || !id) throw new Error(\`${'${label}'} IDが不正です。\`);
        if (globalIds.has(id)) throw new Error(\`シリーズ復元データ内でIDが重複しています: ${'${id}'}\`);
        globalIds.add(id);
      };
      for (const rawPackage of restoreValue.works) {
        const value = await packageTools.validatePackage(rawPackage);
        const work = value.work;
        if (workIds.has(work.id)) throw new Error('シリーズ復元データ内で作品IDが重複しています。');
        workIds.add(work.id);
        addId(work.id, '作品');
        for (const chapter of work.chapters) addId(chapter.id, '章');
        for (const episode of work.episodes) {
          addId(episode.id, '話');
          for (const line of episode.lines) addId(line.id, '本文行');
        }
        for (const scene of work.scenes) addId(scene.id, 'シーン');
        for (const character of work.characters) {
          addId(character.id, '人物');
          for (const field of character.customFields) addId(field.id, '自由項目');
        }
        for (const image of work.images) addId(image.id, '画像');
        works.push(value);
      }
      if (typeof restoreValue.activeWorkId !== 'string' || !workIds.has(restoreValue.activeWorkId)) {
        throw new Error('復元するactiveWorkIdが作品一覧と一致しません。');
      }
      return {
        series: { id: inputSeries.id, title: inputSeries.title, summary: inputSeries.summary },
        activeWorkId: restoreValue.activeWorkId,
        works,
        workIds,
        globalIds
      };
    }

    function assertRestoreCollisions(allWorks, registryRows, normalized, allowedWorkIds) {
      const byWorkId = new Map(allWorks.map(work => [work.id, work]));
      for (const workId of normalized.workIds) {
        const existing = byWorkId.get(workId);
        if (existing && !allowedWorkIds.has(existing.id)) {
          throw new Error(\`別のシリーズが作品ID ${'${workId}'} を使用しています。\`);
        }
      }
      for (const row of registryRows) {
        if (!normalized.globalIds.has(row.globalId)) continue;
        if (!allowedWorkIds.has(row.workId)) {
          throw new Error(\`別のシリーズがID ${'${row.globalId}'} を使用しています。\`);
        }
      }
    }

    async function inspectSeriesRestore(db, restoreValue) {
      const normalized = await normalizeSeriesRestore(restoreValue);
      const tx = db.transaction(['series', 'works', 'idRegistry'], 'readonly');
      const seriesPromise = requestPromise(tx.objectStore('series').get(normalized.series.id));
      const worksPromise = requestPromise(tx.objectStore('works').getAll());
      const registryPromise = requestPromise(tx.objectStore('idRegistry').getAll());
      const [targetSeries, allWorks, registryRows] = await Promise.all([seriesPromise, worksPromise, registryPromise]);
      await transactionPromise(tx);
      const targetWorkIds = allWorks.filter(work => work.seriesId === normalized.series.id)
        .map(work => work.id).sort((a, b) => String(a).localeCompare(String(b)));
      const mode = targetSeries ? 'replace' : 'create';
      const allowedWorkIds = new Set(mode === 'replace' ? targetWorkIds : []);
      assertRestoreCollisions(allWorks, registryRows, normalized, allowedWorkIds);
      return { mode, seriesId: normalized.series.id, targetWorkIds };
    }

    async function restoreSeries(db, restoreValue, inspection) {
      if (!baseStorage || typeof baseStorage.writeValidatedWorkToTransaction !== 'function') {
        throw new Error('作品復元用の保存モジュールが利用できません。');
      }
      const normalized = await normalizeSeriesRestore(restoreValue);
      if (!inspection || inspection.seriesId !== normalized.series.id || !['create', 'replace'].includes(inspection.mode) ||
          !Array.isArray(inspection.targetWorkIds)) throw new Error('シリーズ復元の事前確認情報が不正です。');
      const expectedTargetWorkIds = inspection.targetWorkIds.slice().sort((a, b) => String(a).localeCompare(String(b)));
      const names = ['series', 'workspaceMeta', ...BASE_STORE_NAMES];

      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, 'readwrite');
        const rows = {};
        let targetSeries = null;
        let pending = BASE_STORE_NAMES.length + 1;
        let settled = false;
        let failure = null;
        let result = null;

        const abort = error => {
          if (!failure) failure = error;
          try { tx.abort(); } catch { /* transaction may already be aborting */ }
        };
        const maybeApply = () => {
          pending--;
          if (pending !== 0) return;
          try {
            const allWorks = rows.works || [];
            const currentTargetWorkIds = allWorks.filter(work => work.seriesId === normalized.series.id)
              .map(work => work.id).sort((a, b) => String(a).localeCompare(String(b)));
            const currentMode = targetSeries ? 'replace' : 'create';
            if (currentMode !== inspection.mode || currentTargetWorkIds.length !== expectedTargetWorkIds.length ||
                currentTargetWorkIds.some((id, index) => id !== expectedTargetWorkIds[index])) {
              throw new Error('シリーズの作品構成が事前確認後に変更されました。再確認してください。');
            }
            const allowedWorkIds = new Set(currentMode === 'replace' ? currentTargetWorkIds : []);
            assertRestoreCollisions(allWorks, rows.idRegistry || [], normalized, allowedWorkIds);

            if (currentMode === 'replace') {
              for (const name of BASE_STORE_NAMES) {
                const store = tx.objectStore(name);
                for (const row of rows[name] || []) {
                  const belongs = name === 'works' ? allowedWorkIds.has(row.id) : allowedWorkIds.has(row.workId);
                  if (belongs) store.delete(row.id);
                }
              }
            }

            const existingById = new Map(allWorks.map(work => [work.id, work]));
            for (const value of normalized.works) {
              const previous = existingById.get(value.work.id);
              const previousRevision = Number.isSafeInteger(previous?._revision) ? previous._revision : 0;
              baseStorage.writeValidatedWorkToTransaction(tx, value, {
                revision: Math.max(1, previousRevision + 1),
                workRecordExtras: { seriesId: normalized.series.id }
              });
            }

            const stamp = now();
            const seriesRecord = {
              ...(targetSeries || {}),
              id: normalized.series.id,
              title: normalized.series.title,
              summary: normalized.series.summary,
              lastActiveWorkId: normalized.activeWorkId,
              createdAt: targetSeries?.createdAt || stamp,
              updatedAt: stamp
            };
            const workspaceMeta = {
              id: WORKSPACE_ID,
              activeSeriesId: normalized.series.id,
              activeWorkId: normalized.activeWorkId
            };
            tx.objectStore('series').put(seriesRecord);
            tx.objectStore('workspaceMeta').put(workspaceMeta);
            result = { series: seriesRecord, workspaceMeta };
          } catch (error) {
            abort(error);
          }
        };

        const seriesRequest = tx.objectStore('series').get(normalized.series.id);
        seriesRequest.onsuccess = () => { targetSeries = seriesRequest.result || null; maybeApply(); };
        seriesRequest.onerror = () => abort(seriesRequest.error || new Error('シリーズ情報を確認できませんでした。'));
        for (const name of BASE_STORE_NAMES) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => { rows[name] = request.result || []; maybeApply(); };
          request.onerror = () => abort(request.error || new Error(\`${'${name}'} を確認できませんでした。\`));
        }

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          const scopes = scopesFor(db);
          for (const id of new Set([...expectedTargetWorkIds, ...normalized.workIds])) scopes.delete(id);
          resolve(result);
        };
        tx.onabort = () => {
          if (settled) return;
          settled = true;
          reject(failure || tx.error || new Error('シリーズを復元できませんでした。'));
        };
        tx.onerror = () => { /* onabort reports the failure */ };
      });
    }

`;

source = source.replace(marker, block + marker);
const apiMarker = '      createSeriesWithInitialWork,\n      deleteWork,';
if (!source.includes(apiMarker)) throw new Error('api marker not found');
source = source.replace(apiMarker, '      createSeriesWithInitialWork,\n      inspectSeriesRestore,\n      restoreSeries,\n      deleteWork,');
fs.writeFileSync(path, source);
