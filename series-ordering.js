/* Adds persistent, user-controlled ordering to works inside a series. */
(function (root) {
  'use strict';

  const WORKSPACE_ID = 'current';
  const validOrder = value => Number.isSafeInteger(value) && value >= 0;
  const compareWorks = (left, right) =>
    (validOrder(left?.order) ? left.order : Number.MAX_SAFE_INTEGER) -
      (validOrder(right?.order) ? right.order : Number.MAX_SAFE_INTEGER) ||
    String(left?.id || '').localeCompare(String(right?.id || ''));

  function createSeriesOrderingStorage(base) {
    if (!base || typeof base.openStore !== 'function' || typeof base.listWorks !== 'function') {
      throw new Error('Series保存モジュールが必要です。');
    }

    const requestPromise = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('作品の並び順を読み込めませんでした。'));
    });
    const transactionPromise = tx => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('作品の並び順を保存できませんでした。'));
      tx.onerror = () => { /* onabort reports the final error */ };
    });

    async function rawWork(db, workId) {
      if (!workId) return null;
      const tx = db.transaction('works', 'readonly');
      const value = await requestPromise(tx.objectStore('works').get(workId));
      await transactionPromise(tx);
      return value || null;
    }

    async function rawWorks(db, seriesId = null) {
      const tx = db.transaction('works', 'readonly');
      const store = tx.objectStore('works');
      const rows = seriesId && store.indexNames.contains('seriesId')
        ? await requestPromise(store.index('seriesId').getAll(seriesId))
        : await requestPromise(store.getAll());
      await transactionPromise(tx);
      return seriesId ? rows.filter(item => item.seriesId === seriesId) : rows;
    }

    async function writeOrders(db, orderedRows) {
      if (!orderedRows.length) return;
      const tx = db.transaction('works', 'readwrite');
      const store = tx.objectStore('works');
      orderedRows.forEach((row, order) => store.put({ ...row, order }));
      await transactionPromise(tx);
    }

    async function normalizeSeriesOrders(db, seriesId) {
      if (!seriesId) return [];
      const rows = (await rawWorks(db, seriesId)).slice().sort(compareWorks);
      const needsWrite = rows.some((row, order) => row.order !== order);
      if (needsWrite) await writeOrders(db, rows);
      return rows.map((row, order) => ({ ...row, order }));
    }

    async function normalizeAllOrders(db) {
      const rows = await rawWorks(db);
      const seriesIds = [...new Set(rows.map(item => item.seriesId).filter(Boolean))];
      for (const seriesId of seriesIds) await normalizeSeriesOrders(db, seriesId);
    }

    async function setWorkOrder(db, workId, order) {
      const row = await rawWork(db, workId);
      if (!row) throw new Error('並べ替える作品が見つかりません。');
      const tx = db.transaction('works', 'readwrite');
      tx.objectStore('works').put({ ...row, order });
      await transactionPromise(tx);
    }

    async function openStore(options = {}) {
      const db = await base.openStore(options);
      try {
        await normalizeAllOrders(db);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    }

    async function listWorks(db, seriesId) {
      const rows = await normalizeSeriesOrders(db, seriesId);
      return rows.map(({ schemaVersion, id, seriesId: sid, title, summary, order, _revision }) => ({
        schemaVersion, id, seriesId: sid, title, summary, order, _revision
      }));
    }

    async function saveWork(db, rawPackage) {
      const beforeMeta = await base.getWorkspaceMeta(db);
      const before = beforeMeta?.activeWorkId ? await rawWork(db, beforeMeta.activeWorkId) : null;
      const preservedOrder = validOrder(before?.order) ? before.order : null;
      const result = await base.saveWork(db, rawPackage);
      const afterMeta = await base.getWorkspaceMeta(db);
      const targetId = result?.work?.id || afterMeta?.activeWorkId;
      if (!targetId) return result;
      const targetSeriesId = afterMeta?.activeSeriesId || before?.seriesId;
      const fallbackOrder = preservedOrder ?? Math.max(0, (await rawWorks(db, targetSeriesId)).length - 1);
      await setWorkOrder(db, targetId, fallbackOrder);
      await normalizeSeriesOrders(db, targetSeriesId);
      return result;
    }

    async function saveChanges(db, changes) {
      const before = changes?.workId ? await rawWork(db, changes.workId) : null;
      const preservedOrder = validOrder(before?.order) ? before.order : null;
      const result = await base.saveChanges(db, changes);
      if (preservedOrder !== null && changes?.workId) await setWorkOrder(db, changes.workId, preservedOrder);
      return result;
    }

    async function createWorkInSeries(db, seriesId, rawPackage) {
      const nextOrder = (await listWorks(db, seriesId)).length;
      const result = await base.createWorkInSeries(db, seriesId, rawPackage);
      const workId = result?.work?.id || rawPackage?.work?.id;
      if (workId) await setWorkOrder(db, workId, nextOrder);
      return result;
    }

    async function createSeriesWithInitialWork(db, seriesValues, rawPackage) {
      const result = await base.createSeriesWithInitialWork(db, seriesValues, rawPackage);
      const workId = rawPackage?.work?.id || result?.workspaceMeta?.activeWorkId;
      if (workId) await setWorkOrder(db, workId, 0);
      return result;
    }

    async function moveWork(db, workId, delta) {
      if (!Number.isSafeInteger(delta) || delta === 0) throw new Error('作品の移動量が不正です。');
      const work = await rawWork(db, workId);
      if (!work?.seriesId) throw new Error('並べ替える作品が見つかりません。');
      const rows = await normalizeSeriesOrders(db, work.seriesId);
      const index = rows.findIndex(item => item.id === workId);
      if (index < 0) throw new Error('並べ替える作品が見つかりません。');
      const nextIndex = Math.max(0, Math.min(rows.length - 1, index + delta));
      if (nextIndex === index) return listWorks(db, work.seriesId);
      const [moved] = rows.splice(index, 1);
      rows.splice(nextIndex, 0, moved);
      await writeOrders(db, rows);
      return listWorks(db, work.seriesId);
    }

    async function deleteWork(db, workId) {
      const work = await rawWork(db, workId);
      if (!work?.seriesId) throw new Error('削除する作品が見つかりません。');
      const siblings = await listWorks(db, work.seriesId);
      const removedIndex = siblings.findIndex(item => item.id === workId);
      const remaining = siblings.filter(item => item.id !== workId);
      const meta = await base.getWorkspaceMeta(db);
      const wasActive = meta?.activeWorkId === workId;
      const fallback = wasActive && remaining.length
        ? remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)]
        : null;

      await base.deleteWork(db, workId);
      await normalizeSeriesOrders(db, work.seriesId);
      if (fallback) await base.setActiveWorkspace(db, work.seriesId, fallback.id);
      return base.getWorkspaceMeta(db);
    }

    async function setActiveSeries(db, seriesId) {
      const series = await base.getSeries(db, seriesId);
      if (!series) throw new Error('シリーズが見つかりません。');
      const ordered = await listWorks(db, seriesId);
      if (!ordered.length) throw new Error('作品がないシリーズは開けません。');
      const remembered = series.lastActiveWorkId && ordered.some(item => item.id === series.lastActiveWorkId);
      const value = await base.setActiveSeries(db, seriesId);
      if (!remembered && value?.activeWorkId !== ordered[0].id) {
        return base.setActiveWorkspace(db, seriesId, ordered[0].id);
      }
      return value;
    }

    async function repairWorkspace(db) {
      const result = await base.repairWorkspace(db);
      await normalizeAllOrders(db);
      const meta = await base.getWorkspaceMeta(db);
      if (!meta?.activeSeriesId) return result;
      const works = await listWorks(db, meta.activeSeriesId);
      if (!works.some(item => item.id === meta.activeWorkId) && works.length) {
        return base.setActiveWorkspace(db, meta.activeSeriesId, works[0].id);
      }
      return meta || result;
    }

    return Object.freeze({
      ...base,
      openStore,
      listWorks,
      saveWork,
      saveChanges,
      createWorkInSeries,
      createSeriesWithInitialWork,
      moveWork,
      deleteWork,
      setActiveSeries,
      repairWorkspace
    });
  }

  const api = { createSeriesOrderingStorage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root.NovelStorage) root.NovelStorage = createSeriesOrderingStorage(root.NovelStorage);
})(globalThis);
