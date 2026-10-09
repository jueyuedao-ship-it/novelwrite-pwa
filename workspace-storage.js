/* Phase 1 storage adapter: upgrades the existing database and adds chapter-workspace metadata. */
(function (root) {
  'use strict';

  const base = root.NovelStorage;
  const workspaceMode = root.NovelWorkspaceMode;
  const DATABASE_NAME = 'fumizukue-integrated-work';
  const DATABASE_VERSION = 5;
  const META_STORE = 'workspaceMeta';
  if (!base) throw new Error('NovelStorageを先に読み込んでください。');
  if (!workspaceMode) throw new Error('NovelWorkspaceModeを先に読み込んでください。');

  const originalOpenStore = base.openStore.bind(base);
  const originalSaveWork = base.saveWork.bind(base);

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
      tx.onerror = () => { /* abort handler reports the final error */ };
    });
  }

  function inspectVersion(factory, name) {
    return new Promise((resolve, reject) => {
      const request = factory.open(name);
      request.onupgradeneeded = () => { /* A new empty database may be created at v1; storage v4 will initialize it next. */ };
      request.onerror = () => reject(request.error || new Error('作品データベースを確認できません。'));
      request.onsuccess = () => {
        const db = request.result;
        const version = db.version;
        db.close();
        resolve(version);
      };
    });
  }

  function addWorkspaceStore(factory, name) {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error || new Error('章ワークスペース保存領域を作成できません。'));
      request.onblocked = () => reject(new Error('別の画面が作品データベースを使用中です。'));
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
  }

  async function openStore(options = {}) {
    const factory = options.indexedDB || root.indexedDB;
    const name = options.name || DATABASE_NAME;
    if (!factory || typeof factory.open !== 'function') throw new Error('IndexedDBを利用できません。');
    let version = await inspectVersion(factory, name);
    if (version < 4) {
      const initialized = await originalOpenStore({ ...options, indexedDB: factory, name, version: 4 });
      initialized.close();
      version = 4;
    }
    if (version < DATABASE_VERSION) await addWorkspaceStore(factory, name);
    if (version > DATABASE_VERSION) throw new Error('このアプリより新しい作品データベースです。');
    return originalOpenStore({ ...options, indexedDB: factory, name, version: DATABASE_VERSION });
  }

  function loadWorkspaceMeta(store) {
    const tx = store.transaction([META_STORE], 'readonly');
    const result = requestPromise(tx.objectStore(META_STORE).get('active'));
    return Promise.all([result, transactionPromise(tx)]).then(([row]) => workspaceMode.normalizeWorkspaceMeta(row || null));
  }

  function loadWorkRevision(store) {
    const tx = store.transaction(['works'], 'readonly');
    const result = requestPromise(tx.objectStore('works').getAll());
    return Promise.all([result, transactionPromise(tx)]).then(([rows]) => {
      if (rows.length > 1) throw new Error('複数の作品が保存されています。');
      const revision = rows.length ? rows[0]._revision : 0;
      return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    });
  }

  async function writeWorkspaceMeta(store, rawMeta) {
    const meta = workspaceMode.normalizeWorkspaceMeta(rawMeta);
    const tx = store.transaction([META_STORE], 'readwrite');
    if (meta) tx.objectStore(META_STORE).put(meta);
    else tx.objectStore(META_STORE).delete('active');
    await transactionPromise(tx);
    return meta;
  }

  async function saveWork(store, rawPackage) {
    const value = await originalSaveWork(store, rawPackage);
    await writeWorkspaceMeta(store, null);
    return value;
  }

  async function saveChapterWorkspace(store, rawPackage, rawMeta) {
    const meta = workspaceMode.normalizeWorkspaceMeta(rawMeta);
    if (!meta) throw new Error('章ワークスペース情報がありません。');
    if (!rawPackage?.work || rawPackage.work.id !== meta.sourceWorkId || !Array.isArray(rawPackage.work.chapters) ||
        rawPackage.work.chapters.length !== 1 || rawPackage.work.chapters[0].id !== meta.loadedChapterIds[0]) {
      throw new Error('章ワークスペースと保存する章パッケージが一致しません。');
    }
    const previousPackage = await base.loadWork(store);
    const previousMeta = await loadWorkspaceMeta(store);
    try {
      const value = await originalSaveWork(store, rawPackage);
      await writeWorkspaceMeta(store, meta);
      return value;
    } catch (error) {
      try {
        if (previousPackage) {
          await originalSaveWork(store, previousPackage);
          await writeWorkspaceMeta(store, previousMeta);
        }
      } catch { /* Keep the original error; caller will surface it and current data remains recoverable from ZIP. */ }
      throw error;
    }
  }

  root.NovelStorage = Object.assign(base, {
    openStore,
    saveWork,
    loadWorkspaceMeta,
    saveChapterWorkspace,
    loadWorkRevision
  });
})(globalThis);
