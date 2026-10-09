/* Integrates the Series storage layer with the chapter-workspace v5 database. */
(function (root) {
  'use strict';

  const base = root.NovelStorage;
  const DATABASE_NAME = 'fumizukue-integrated-work';
  const DATABASE_VERSION = 6;
  const CURRENT_META_ID = 'current';
  if (!base || typeof base.openStore !== 'function') throw new Error('Series保存モジュールを先に読み込んでください。');

  const originalOpenStore = base.openStore.bind(base);

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB操作に失敗しました。'));
    });
  }

  function transactionPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDBトランザクションに失敗しました。'));
      tx.onerror = () => { /* onabort reports the final error */ };
    });
  }

  function inspect(factory, name) {
    return new Promise((resolve, reject) => {
      const request = factory.open(name);
      request.onerror = () => reject(request.error || new Error('作品データベースを確認できません。'));
      request.onblocked = () => reject(new Error('別の画面が作品データベースを使用中です。'));
      request.onsuccess = () => {
        const db = request.result;
        const result = {
          version: db.version,
          hasWorks: db.objectStoreNames.contains('works'),
          hasSeries: db.objectStoreNames.contains('series'),
          hasWorkspaceMeta: db.objectStoreNames.contains('workspaceMeta')
        };
        db.close();
        resolve(result);
      };
    });
  }

  function upgrade(factory, name) {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction;
        const series = db.objectStoreNames.contains('series')
          ? tx.objectStore('series')
          : db.createObjectStore('series', { keyPath: 'id' });
        const meta = db.objectStoreNames.contains('workspaceMeta')
          ? tx.objectStore('workspaceMeta')
          : db.createObjectStore('workspaceMeta', { keyPath: 'id' });
        const works = tx.objectStore('works');
        if (!works.indexNames.contains('seriesId')) works.createIndex('seriesId', 'seriesId', { unique: false });

        const worksRequest = works.getAll();
        worksRequest.onsuccess = () => {
          const rows = worksRequest.result || [];
          const missing = rows.filter(row => !row.seriesId);
          if (missing.length) {
            const seriesId = rows.length === 1 ? `series-${rows[0].id}` : 'series-migrated';
            const stamp = new Date().toISOString();
            series.put({
              id: seriesId,
              title: rows.length === 1 ? (rows[0].title || '無題のシリーズ') : '移行されたシリーズ',
              summary: '',
              createdAt: stamp,
              updatedAt: stamp
            });
            missing.forEach(row => works.put({ ...row, seriesId }));
          }

          const currentRequest = meta.get(CURRENT_META_ID);
          currentRequest.onsuccess = () => {
            if (currentRequest.result || !rows.length) return;
            const first = rows[0];
            const seriesId = first.seriesId || (rows.length === 1 ? `series-${first.id}` : 'series-migrated');
            meta.put({ id: CURRENT_META_ID, activeSeriesId: seriesId, activeWorkId: first.id });
          };
        };
      };
      request.onerror = () => reject(request.error || new Error('シリーズ保存領域を更新できません。'));
      request.onblocked = () => reject(new Error('別の画面が作品データベース更新を妨げています。'));
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
  }

  async function openStore(options = {}) {
    const factory = options.indexedDB || root.indexedDB;
    const name = options.name || DATABASE_NAME;
    if (!factory || typeof factory.open !== 'function') throw new Error('IndexedDBを利用できません。');

    let state = await inspect(factory, name);
    if (!state.hasWorks) {
      const initialized = await originalOpenStore({ ...options, indexedDB: factory, name });
      initialized.close();
      state = await inspect(factory, name);
    }
    if (state.version < DATABASE_VERSION) {
      await upgrade(factory, name);
      state = await inspect(factory, name);
    }
    if (state.version > DATABASE_VERSION) throw new Error('このアプリより新しい作品データベースです。');
    if (!state.hasSeries || !state.hasWorkspaceMeta) throw new Error('シリーズ保存領域を初期化できませんでした。');
    return originalOpenStore({ ...options, indexedDB: factory, name });
  }

  root.NovelStorage = Object.assign({}, base, {
    openStore,
    SERIES_DATABASE_VERSION: DATABASE_VERSION
  });
})(globalThis);
