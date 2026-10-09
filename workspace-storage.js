/* Chapter-workspace metadata adapter composed on top of the Series storage layer. */
(function (root) {
  'use strict';

  const base = root.NovelStorage;
  const workspaceMode = root.NovelWorkspaceMode;
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

  async function openStore(options = {}) {
    return originalOpenStore(options);
  }

  function loadWorkspaceMeta(store) {
    const tx = store.transaction([META_STORE], 'readonly');
    const result = requestPromise(tx.objectStore(META_STORE).get('active'));
    return Promise.all([result, transactionPromise(tx)]).then(([row]) => workspaceMode.normalizeWorkspaceMeta(row || null));
  }

  async function loadWorkRevision(store) {
    const current = typeof base.getWorkspaceMeta === 'function' ? await base.getWorkspaceMeta(store) : null;
    if (!current?.activeWorkId) return 0;
    const tx = store.transaction(['works'], 'readonly');
    const rowPromise = requestPromise(tx.objectStore('works').get(current.activeWorkId));
    const [row] = await Promise.all([rowPromise, transactionPromise(tx)]);
    const revision = row?._revision || 0;
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
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
      } catch { /* Keep the original error; caller surfaces it and ZIP remains the recovery path. */ }
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
