/* Series/workspace persistence compatibility layer. */
(function (root) {
  'use strict';

  const LEGACY_DATABASE_VERSION = 4;
  const SERIES_DATABASE_VERSION = 5;
  const DATABASE_NAME = 'fumizukue-integrated-work';
  const BASE_STORE_NAMES = ['works', 'chapters', 'episodes', 'episodeBodies', 'scenes', 'characters', 'images', 'imageBlobs', 'lineCharacterRefs', 'idRegistry'];
  const WORKSPACE_ID = 'current';

  function createSeriesStorage(options = {}) {
    const baseStorage = options.baseStorage;
    const packageTools = options.packageTools;
    const defaultFactory = options.indexedDB || root.indexedDB;
    if (!baseStorage || typeof baseStorage.openStore !== 'function') throw new Error('既存の作品保存モジュールが必要です。');
    if (!packageTools || typeof packageTools.validatePackage !== 'function') throw new Error('作品保存モジュールが必要です。');

    const scopeCache = new WeakMap();

    const requestPromise = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('保存データを読み込めませんでした。'));
    });
    const transactionPromise = tx => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('保存データを更新できませんでした。'));
      tx.onerror = () => { /* onabort carries the error */ };
    });
    const now = () => new Date().toISOString();
    const belongsToWork = (storeName, record, workId) => storeName === 'works'
      ? record?.id === workId
      : record?.workId === workId;

    function syntheticFilteredRequest(rawRequest, predicate) {
      const synthetic = { onsuccess: null, onerror: null, result: undefined, error: null };
      rawRequest.onsuccess = () => {
        synthetic.result = Array.isArray(rawRequest.result) ? rawRequest.result.filter(predicate) : rawRequest.result;
        synthetic.onsuccess?.({ target: synthetic });
      };
      rawRequest.onerror = () => {
        synthetic.error = rawRequest.error;
        synthetic.onerror?.({ target: synthetic });
      };
      return synthetic;
    }

    function deleteRowsForWork(storeName, store, workId) {
      if (storeName === 'works') {
        store.delete(workId);
        return;
      }
      if (!store.indexNames.contains('workId')) throw new Error(`${storeName} にworkIdインデックスがありません。`);
      const cursorRequest = store.index('workId').openKeyCursor(workId);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }

    async function snapshotWorkKeys(db, workId) {
      const tx = db.transaction(BASE_STORE_NAMES, 'readonly');
      const done = transactionPromise(tx);
      const entries = BASE_STORE_NAMES.map(async name => {
        const store = tx.objectStore(name);
        if (name === 'works') return [name, (await requestPromise(store.get(workId))) ? [workId] : []];
        if (!store.indexNames.contains('workId')) throw new Error(`${name} にworkIdインデックスがありません。`);
        return [name, await requestPromise(store.index('workId').getAllKeys(workId))];
      });
      const values = await Promise.all(entries);
      await done;
      return new Map(values);
    }

    function makeTransactionProxy(db, names, mode, scope) {
      const requested = Array.isArray(names) ? names : [names];
      const expanded = new Set(requested);
      if (mode === 'readwrite' && scope.activateOnSave) {
        expanded.add('workspaceMeta');
        expanded.add('series');
      }
      const tx = db.transaction([...expanded], mode);
      const storeProxies = new Map();

      const proxy = {
        objectStore(name) {
          if (storeProxies.has(name)) return storeProxies.get(name);
          const store = tx.objectStore(name);
          const wrapped = new Proxy(store, {
            get(target, property) {
              if (property === 'getAll') {
                return (...args) => syntheticFilteredRequest(target.getAll(...args), record => belongsToWork(name, record, scope.workId));
              }
              if (property === 'clear') {
                return () => {
                  const keys = scope.clearKeys?.get(name);
                  if (!keys) throw new Error('作品置換用の削除キーが準備されていません。');
                  keys.forEach(key => target.delete(key));
                };
              }
              if (name === 'works' && property === 'put') {
                return (record, ...args) => {
                  const seriesId = scope.seriesId || record.seriesId;
                  if (!seriesId) throw new Error('作品のシリーズIDがありません。');
                  const result = target.put({ ...record, seriesId }, ...args);
                  scope.savedWorkId = record.id;
                  if (scope.activateOnSave) {
                    if (scope.seriesRecord) tx.objectStore('series').put(scope.seriesRecord);
                    tx.objectStore('workspaceMeta').put({ id: WORKSPACE_ID, activeSeriesId: seriesId, activeWorkId: record.id });
                  }
                  return result;
                };
              }
              const value = target[property];
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
          storeProxies.set(name, wrapped);
          return wrapped;
        },
        abort: () => tx.abort(),
        get error() { return tx.error; },
        get mode() { return tx.mode; },
        get db() { return db; },
        set oncomplete(handler) { tx.oncomplete = handler; },
        get oncomplete() { return tx.oncomplete; },
        set onabort(handler) { tx.onabort = handler; },
        get onabort() { return tx.onabort; },
        set onerror(handler) { tx.onerror = handler; },
        get onerror() { return tx.onerror; }
      };
      return proxy;
    }

    function createScopedDatabase(db, scope) {
      return {
        transaction: (names, mode = 'readonly') => makeTransactionProxy(db, names, mode, scope),
        close: () => {},
        get name() { return db.name; },
        get version() { return db.version; }
      };
    }

    function scopesFor(db) {
      let scopes = scopeCache.get(db);
      if (!scopes) {
        scopes = new Map();
        scopeCache.set(db, scopes);
      }
      return scopes;
    }

    async function getWorkRecord(db, workId) {
      if (!workId) return null;
      const tx = db.transaction('works', 'readonly');
      const value = await requestPromise(tx.objectStore('works').get(workId));
      await transactionPromise(tx);
      return value || null;
    }

    async function getScope(db, workId) {
      const scopes = scopesFor(db);
      if (scopes.has(workId)) return scopes.get(workId);
      const record = await getWorkRecord(db, workId);
      const scope = {
        workId,
        seriesId: record?.seriesId || null,
        activateOnSave: false,
        seriesRecord: null,
        savedWorkId: null,
        clearKeys: null,
        seeded: false
      };
      scope.proxy = createScopedDatabase(db, scope);
      scopes.set(workId, scope);
      return scope;
    }

    async function seedScope(db, workId) {
      const scope = await getScope(db, workId);
      if (!scope.seeded) {
        const index = await baseStorage.loadWorkIndex(scope.proxy);
        if (!index) throw new Error('対象の作品が保存されていません。');
        scope.seeded = true;
      }
      return scope;
    }

    async function normalizeLegacyDatabase(factory, name) {
      try {
        const legacy = await baseStorage.openStore({ indexedDB: factory, name, version: LEGACY_DATABASE_VERSION });
        legacy.close();
      } catch (error) {
        if (error?.name !== 'VersionError' && !/version/i.test(error?.message || '')) throw error;
      }
    }

    function openSeriesDatabase(factory, name) {
      return new Promise((resolve, reject) => {
        let request;
        try { request = factory.open(name, SERIES_DATABASE_VERSION); }
        catch (error) { reject(error); return; }
        request.onupgradeneeded = event => {
          const db = request.result;
          const tx = request.transaction;
          const seriesStore = db.objectStoreNames.contains('series')
            ? tx.objectStore('series')
            : db.createObjectStore('series', { keyPath: 'id' });
          const metaStore = db.objectStoreNames.contains('workspaceMeta')
            ? tx.objectStore('workspaceMeta')
            : db.createObjectStore('workspaceMeta', { keyPath: 'id' });
          const works = tx.objectStore('works');
          if (!works.indexNames.contains('seriesId')) works.createIndex('seriesId', 'seriesId', { unique: false });
          if (event.oldVersion < SERIES_DATABASE_VERSION) {
            const rowsRequest = works.getAll();
            rowsRequest.onsuccess = () => {
              const rows = rowsRequest.result || [];
              if (!rows.length) return;
              const seriesId = rows.length === 1 ? `series-${rows[0].id}` : 'series-migrated';
              const stamp = now();
              seriesStore.put({
                id: seriesId,
                title: rows.length === 1 ? (rows[0].title || '無題のシリーズ') : '移行されたシリーズ',
                summary: '',
                createdAt: stamp,
                updatedAt: stamp
              });
              rows.forEach(row => works.put({ ...row, seriesId }));
              metaStore.put({ id: WORKSPACE_ID, activeSeriesId: seriesId, activeWorkId: rows[0].id });
            };
          }
        };
        request.onerror = () => reject(request.error || new Error('シリーズ対応データベースを開けません。'));
        request.onblocked = () => reject(new Error('別の画面がデータベース更新を妨げています。'));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
      });
    }

    async function readWorkspaceSnapshot(db) {
      const tx = db.transaction(['series', 'works', 'workspaceMeta'], 'readonly');
      const seriesPromise = requestPromise(tx.objectStore('series').getAll());
      const worksPromise = requestPromise(tx.objectStore('works').getAll());
      const metaPromise = requestPromise(tx.objectStore('workspaceMeta').get(WORKSPACE_ID));
      const [series, works, meta] = await Promise.all([seriesPromise, worksPromise, metaPromise]);
      await transactionPromise(tx);
      return { series, works, meta: meta || null };
    }

    async function repairWorkspace(db) {
      let snapshot = await readWorkspaceSnapshot(db);
      const seriesIds = new Set(snapshot.series.map(item => item.id));
      const orphaned = snapshot.works.filter(work => !work.seriesId || !seriesIds.has(work.seriesId));
      if (orphaned.length) {
        const recoveryId = 'series-recovered';
        const tx = db.transaction(['series', 'works'], 'readwrite');
        const stamp = now();
        if (!seriesIds.has(recoveryId)) {
          tx.objectStore('series').put({ id: recoveryId, title: '回復されたシリーズ', summary: '', createdAt: stamp, updatedAt: stamp });
        }
        orphaned.forEach(work => tx.objectStore('works').put({ ...work, seriesId: recoveryId }));
        await transactionPromise(tx);
        snapshot = await readWorkspaceSnapshot(db);
      }
      if (!snapshot.works.length) return snapshot.meta;
      const workById = new Map(snapshot.works.map(work => [work.id, work]));
      const active = snapshot.meta ? workById.get(snapshot.meta.activeWorkId) : null;
      if (active && active.seriesId === snapshot.meta.activeSeriesId) return snapshot.meta;
      const fallback = snapshot.works[0];
      const repaired = { id: WORKSPACE_ID, activeSeriesId: fallback.seriesId, activeWorkId: fallback.id };
      const tx = db.transaction('workspaceMeta', 'readwrite');
      tx.objectStore('workspaceMeta').put(repaired);
      await transactionPromise(tx);
      return repaired;
    }

    async function openStore(openOptions = {}) {
      const factory = openOptions.indexedDB || defaultFactory;
      const name = openOptions.name || DATABASE_NAME;
      if (!factory || typeof factory.open !== 'function') throw new Error('IndexedDBを利用できません。');
      await normalizeLegacyDatabase(factory, name);
      let db;
      try { db = await openSeriesDatabase(factory, name); }
      catch (error) {
        if (error?.name !== 'VersionError') throw error;
        db = await new Promise((resolve, reject) => {
          const request = factory.open(name);
          request.onerror = () => reject(request.error || error);
          request.onsuccess = () => resolve(request.result);
        });
        if (!db.objectStoreNames.contains('series') || !db.objectStoreNames.contains('workspaceMeta')) {
          db.close();
          throw error;
        }
      }
      await repairWorkspace(db);
      return db;
    }

    async function listSeries(db) {
      const tx = db.transaction('series', 'readonly');
      const rows = await requestPromise(tx.objectStore('series').getAll());
      await transactionPromise(tx);
      return rows.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    }

    async function getSeries(db, seriesId) {
      const tx = db.transaction('series', 'readonly');
      const value = await requestPromise(tx.objectStore('series').get(seriesId));
      await transactionPromise(tx);
      return value || null;
    }

    function makeSeriesRecord(values = {}, workId = null) {
      const id = values.id || `series-${root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
      const stamp = now();
      return {
        id,
        title: typeof values.title === 'string' ? values.title : '無題のシリーズ',
        summary: typeof values.summary === 'string' ? values.summary : '',
        ...(workId ? { lastActiveWorkId: workId } : {}),
        createdAt: stamp,
        updatedAt: stamp
      };
    }

    async function createSeries(db, values = {}) {
      const record = makeSeriesRecord(values);
      const tx = db.transaction('series', 'readwrite');
      tx.objectStore('series').add(record);
      await transactionPromise(tx);
      return record;
    }

    async function updateSeries(db, seriesId, changes = {}) {
      const current = await getSeries(db, seriesId);
      if (!current) throw new Error('シリーズが見つかりません。');
      if (changes.title !== undefined && typeof changes.title !== 'string') throw new Error('シリーズ名は文字列である必要があります。');
      if (changes.summary !== undefined && typeof changes.summary !== 'string') throw new Error('シリーズ概要は文字列である必要があります。');
      const next = {
        ...current,
        title: changes.title ?? current.title,
        summary: changes.summary ?? current.summary,
        updatedAt: now()
      };
      const tx = db.transaction('series', 'readwrite');
      tx.objectStore('series').put(next);
      await transactionPromise(tx);
      return next;
    }

    async function listWorks(db, seriesId) {
      const tx = db.transaction('works', 'readonly');
      const store = tx.objectStore('works');
      const rows = store.indexNames.contains('seriesId')
        ? await requestPromise(store.index('seriesId').getAll(seriesId))
        : (await requestPromise(store.getAll())).filter(work => work.seriesId === seriesId);
      await transactionPromise(tx);
      return rows.map(({ schemaVersion, id, seriesId: sid, title, summary, _revision }) => ({ schemaVersion, id, seriesId: sid, title, summary, _revision }));
    }

    async function getWorkspaceMeta(db) {
      const tx = db.transaction('workspaceMeta', 'readonly');
      const value = await requestPromise(tx.objectStore('workspaceMeta').get(WORKSPACE_ID));
      await transactionPromise(tx);
      return value || null;
    }

    async function setActiveWorkspace(db, seriesId, workId) {
      const [series, work] = await Promise.all([getSeries(db, seriesId), getWorkRecord(db, workId)]);
      if (!series) throw new Error('シリーズが見つかりません。');
      if (!work || work.seriesId !== seriesId) throw new Error('選択した作品はこのシリーズに属していません。');
      const stamp = now();
      const value = { id: WORKSPACE_ID, activeSeriesId: seriesId, activeWorkId: workId };
      const tx = db.transaction(['series', 'workspaceMeta'], 'readwrite');
      tx.objectStore('series').put({ ...series, lastActiveWorkId: workId, updatedAt: stamp });
      tx.objectStore('workspaceMeta').put(value);
      await transactionPromise(tx);
      return value;
    }

    async function setActiveSeries(db, seriesId) {
      const targetSeries = await getSeries(db, seriesId);
      if (!targetSeries) throw new Error('シリーズが見つかりません。');
      const targetWorks = (await listWorks(db, seriesId)).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (!targetWorks.length) throw new Error('作品がないシリーズは開けません。');

      const currentMeta = await getWorkspaceMeta(db);
      let currentSeries = currentMeta?.activeSeriesId ? await getSeries(db, currentMeta.activeSeriesId) : null;
      let rememberedTarget = targetSeries;
      if (currentSeries && currentMeta?.activeWorkId) {
        const currentWork = await getWorkRecord(db, currentMeta.activeWorkId);
        if (currentWork?.seriesId === currentSeries.id) {
          currentSeries = { ...currentSeries, lastActiveWorkId: currentWork.id, updatedAt: now() };
          if (currentSeries.id === targetSeries.id) rememberedTarget = currentSeries;
        }
      }

      const rememberedId = rememberedTarget.lastActiveWorkId;
      const rememberedWork = rememberedId ? targetWorks.find(work => work.id === rememberedId) : null;
      const targetWork = rememberedWork || targetWorks[0];
      const stamp = now();
      const nextTarget = { ...rememberedTarget, lastActiveWorkId: targetWork.id, updatedAt: stamp };
      const value = { id: WORKSPACE_ID, activeSeriesId: seriesId, activeWorkId: targetWork.id };
      const tx = db.transaction(['series', 'workspaceMeta'], 'readwrite');
      if (currentSeries && currentSeries.id !== nextTarget.id) tx.objectStore('series').put(currentSeries);
      tx.objectStore('series').put(nextTarget);
      tx.objectStore('workspaceMeta').put(value);
      await transactionPromise(tx);
      return value;
    }

    async function activeWorkId(db, requestedWorkId = null) {
      if (requestedWorkId) return requestedWorkId;
      const meta = await getWorkspaceMeta(db) || await repairWorkspace(db);
      return meta?.activeWorkId || null;
    }

    async function loadWorkIndex(db, workId = null) {
      const target = await activeWorkId(db, workId);
      if (!target) return null;
      const scope = await getScope(db, target);
      const result = await baseStorage.loadWorkIndex(scope.proxy);
      scope.seeded = Boolean(result);
      return result;
    }

    async function loadWork(db, workId = null) {
      const target = await activeWorkId(db, workId);
      if (!target) return null;
      const scope = await getScope(db, target);
      return baseStorage.loadWork(scope.proxy);
    }

    async function saveChanges(db, changes) {
      if (!changes || typeof changes.workId !== 'string' || !changes.workId) throw new Error('差分保存にはworkIdが必要です。');
      const scope = await seedScope(db, changes.workId);
      return baseStorage.saveChanges(scope.proxy, changes);
    }

    async function ensureInitialSeries(db, rawPackage) {
      const meta = await getWorkspaceMeta(db);
      if (meta?.activeSeriesId && await getSeries(db, meta.activeSeriesId)) return { seriesId: meta.activeSeriesId, seriesRecord: null };
      const series = await listSeries(db);
      if (series.length) return { seriesId: series[0].id, seriesRecord: null };
      const work = rawPackage?.work;
      const seriesId = `series-${work?.id || 'initial'}`;
      return {
        seriesId,
        seriesRecord: makeSeriesRecord({ id: seriesId, title: work?.title || '無題のシリーズ', summary: '' }, work?.id || null)
      };
    }

    async function saveWork(db, rawPackage) {
      const validated = await packageTools.validatePackage(rawPackage);
      const newWorkId = validated.work.id;
      const meta = await getWorkspaceMeta(db) || await repairWorkspace(db);
      const oldWorkId = meta?.activeWorkId || null;
      const existingNew = await getWorkRecord(db, newWorkId);
      if (existingNew && existingNew.id !== oldWorkId) throw new Error('同じ作品IDの別作品がすでにシリーズ内にあります。');

      let scope;
      if (oldWorkId) {
        const oldRecord = await getWorkRecord(db, oldWorkId);
        if (!oldRecord) throw new Error('置き換える作品が見つかりません。');
        const series = await getSeries(db, oldRecord.seriesId);
        if (!series) throw new Error('置き換える作品のシリーズが見つかりません。');
        scope = await seedScope(db, oldWorkId);
        scope.seriesId = oldRecord.seriesId;
        scope.seriesRecord = { ...series, lastActiveWorkId: newWorkId, updatedAt: now() };
      } else {
        const initial = await ensureInitialSeries(db, validated);
        scope = await getScope(db, newWorkId);
        scope.seriesId = initial.seriesId;
        const existingSeries = initial.seriesRecord ? null : await getSeries(db, initial.seriesId);
        scope.seriesRecord = initial.seriesRecord || (existingSeries ? { ...existingSeries, lastActiveWorkId: newWorkId, updatedAt: now() } : null);
      }
      scope.clearKeys = oldWorkId ? await snapshotWorkKeys(db, oldWorkId) : new Map(BASE_STORE_NAMES.map(name => [name, []]));
      scope.activateOnSave = true;
      try {
        const result = await baseStorage.saveWork(scope.proxy, validated);
        const scopes = scopesFor(db);
        if (oldWorkId) scopes.delete(oldWorkId);
        scopes.delete(newWorkId);
        return result;
      } finally {
        scope.activateOnSave = false;
        scope.seriesRecord = null;
        scope.clearKeys = null;
      }
    }

    async function createWorkInSeries(db, seriesId, rawPackage) {
      const series = await getSeries(db, seriesId);
      if (!series) throw new Error('追加先のシリーズが見つかりません。');
      const validated = await packageTools.validatePackage(rawPackage);
      if (await getWorkRecord(db, validated.work.id)) throw new Error('同じ作品IDの作品がすでにあります。');
      const scope = await getScope(db, validated.work.id);
      scope.seriesId = seriesId;
      scope.seriesRecord = { ...series, lastActiveWorkId: validated.work.id, updatedAt: now() };
      scope.clearKeys = new Map(BASE_STORE_NAMES.map(name => [name, []]));
      scope.activateOnSave = true;
      try {
        const result = await baseStorage.saveWork(scope.proxy, validated);
        scopesFor(db).delete(validated.work.id);
        return result;
      } finally {
        scope.activateOnSave = false;
        scope.seriesRecord = null;
        scope.clearKeys = null;
      }
    }

    async function createSeriesWithInitialWork(db, seriesValues, rawWorkPackage) {
      const validated = await packageTools.validatePackage(rawWorkPackage);
      if (await getWorkRecord(db, validated.work.id)) throw new Error('同じ作品IDの作品がすでにあります。');
      const record = makeSeriesRecord(seriesValues, validated.work.id);
      if (await getSeries(db, record.id)) throw new Error('同じシリーズIDのシリーズがすでにあります。');
      const scope = await getScope(db, validated.work.id);
      scope.seriesId = record.id;
      scope.seriesRecord = record;
      scope.clearKeys = new Map(BASE_STORE_NAMES.map(name => [name, []]));
      scope.activateOnSave = true;
      try {
        await baseStorage.saveWork(scope.proxy, validated);
        scopesFor(db).delete(validated.work.id);
        return {
          series: record,
          workspaceMeta: { id: WORKSPACE_ID, activeSeriesId: record.id, activeWorkId: validated.work.id }
        };
      } finally {
        scope.activateOnSave = false;
        scope.seriesRecord = null;
        scope.clearKeys = null;
      }
    }

    async function deleteWorkRows(db, workId, nextMeta, nextSeries = null) {
      const names = [...BASE_STORE_NAMES, 'workspaceMeta', 'series'];
      const tx = db.transaction(names, 'readwrite');
      for (const name of BASE_STORE_NAMES) deleteRowsForWork(name, tx.objectStore(name), workId);
      if (nextSeries) tx.objectStore('series').put(nextSeries);
      if (nextMeta) tx.objectStore('workspaceMeta').put(nextMeta);
      await transactionPromise(tx);
    }

    async function deleteWork(db, workId) {
      const work = await getWorkRecord(db, workId);
      if (!work) throw new Error('削除する作品が見つかりません。');
      const siblings = await listWorks(db, work.seriesId);
      if (siblings.length <= 1) throw new Error('シリーズの最後の1作品は削除できません。');
      const meta = await getWorkspaceMeta(db);
      let nextMeta = null;
      let nextSeries = null;
      if (meta?.activeWorkId === workId) {
        const next = siblings.filter(item => item.id !== workId).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
        nextMeta = { id: WORKSPACE_ID, activeSeriesId: work.seriesId, activeWorkId: next.id };
        const series = await getSeries(db, work.seriesId);
        if (series) nextSeries = { ...series, lastActiveWorkId: next.id, updatedAt: now() };
      }
      await deleteWorkRows(db, workId, nextMeta, nextSeries);
      scopesFor(db).delete(workId);
      return nextMeta || meta;
    }

    return Object.freeze({
      ...baseStorage,
      openStore,
      loadWorkIndex,
      loadWork,
      saveWork,
      saveChanges,
      listSeries,
      getSeries,
      createSeries,
      updateSeries,
      listWorks,
      createWorkInSeries,
      createSeriesWithInitialWork,
      deleteWork,
      getWorkspaceMeta,
      setActiveWorkspace,
      setActiveSeries,
      repairWorkspace,
      SERIES_DATABASE_VERSION
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createSeriesStorage, SERIES_DATABASE_VERSION };
  } else if (root.NovelStorage) {
    root.NovelStorage = createSeriesStorage({
      baseStorage: root.NovelStorage,
      packageTools: root.NovelPackage,
      indexedDB: root.indexedDB
    });
  }
})(globalThis);