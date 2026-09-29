/* IndexedDB persistence for the integrated writing workspace. */
(function (root) {
  'use strict';

  const packageTools = typeof module !== 'undefined' && module.exports ? require('./package') : root.NovelPackage;
  const DATABASE_NAME = 'fumizukue-integrated-work';
  const DATABASE_VERSION = 4;
  const STORE_NAMES = ['works', 'chapters', 'episodes', 'episodeBodies', 'scenes', 'characters', 'images', 'imageBlobs', 'lineCharacterRefs', 'idRegistry'];
  const MODEL_VERSION = 4;
  const workRevisions = new WeakMap();
  const savedRevision = work => Number.isSafeInteger(work?._revision) ? work._revision : 0;
  const conflictError = () => new Error('別の画面で作品が更新されました。現在の編集をコピーするか、ZIP・TXTで退避し、画面を再読み込みしてください。');

  function openStore(options = {}) {
    const factory = options.indexedDB || root.indexedDB;
    const name = options.name || DATABASE_NAME;
    if (!factory || typeof factory.open !== 'function') return Promise.reject(new Error('IndexedDBを利用できません。'));
    return new Promise((resolve, reject) => {
      let request;
      let settled = false;
      try { request = factory.open(name, options.version || DATABASE_VERSION); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = event => {
        const db = request.result;
        const tx = request.transaction;
        const ensureStore = storeName => db.objectStoreNames.contains(storeName)
          ? tx.objectStore(storeName)
          : db.createObjectStore(storeName, { keyPath: 'id' });
        const stores = Object.fromEntries(STORE_NAMES.map(storeName => [storeName, ensureStore(storeName)]));
        const ensureIndex = (store, indexName, keyPath, multiEntry = false) => {
          if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, { unique: false, multiEntry });
        };
        ensureIndex(stores.chapters, 'workId', 'workId');
        ensureIndex(stores.episodes, 'workId', 'workId');
        ensureIndex(stores.episodes, 'chapterId', 'chapterId');
        ensureIndex(stores.episodeBodies, 'workId', 'workId');
        ensureIndex(stores.scenes, 'workId', 'workId');
        ensureIndex(stores.scenes, 'chapterId', 'chapterId');
        ensureIndex(stores.scenes, 'episodeId', 'episodeId');
        ensureIndex(stores.scenes, 'scopeKey', 'scopeKey');
        ensureIndex(stores.scenes, 'characterIds', 'characterIds', true);
        ensureIndex(stores.scenes, 'imageIds', 'imageIds', true);
        ensureIndex(stores.characters, 'workId', 'workId');
        ensureIndex(stores.characters, 'imageIds', 'imageIds', true);
        ensureIndex(stores.images, 'workId', 'workId');
        ensureIndex(stores.images, 'ownerId', 'ownerId');
        ensureIndex(stores.imageBlobs, 'workId', 'workId');
        ensureIndex(stores.lineCharacterRefs, 'workId', 'workId');
        ensureIndex(stores.lineCharacterRefs, 'episodeId', 'episodeId');
        ensureIndex(stores.lineCharacterRefs, 'characterId', 'characterId');
        ensureIndex(stores.idRegistry, 'workId', 'workId');
        ensureIndex(stores.idRegistry, 'ownerKey', 'ownerKey');
        ensureIndex(stores.idRegistry, 'globalId', 'globalId');

        if (event.oldVersion === 1) {
          let episodeSequence = 0;
          const episodeCursor = stores.episodes.openCursor();
          episodeCursor.onsuccess = () => {
            const cursor = episodeCursor.result;
            if (!cursor) return;
            const value = cursor.value;
            const { lines = [], ...metadata } = value;
            metadata._sequence = Number.isSafeInteger(value._sequence) ? value._sequence : episodeSequence;
            stores.episodeBodies.put({ id: value.id, workId: value.workId, lines });
            addLineCharacterRefs(stores.lineCharacterRefs, value.id, value.workId, lines);
            putRegistry(stores.idRegistry, value.id, value.workId, 'episode', 'episode', value.id, true);
            for (const line of lines) putRegistry(stores.idRegistry, line.id, value.workId, 'line', 'episodeLine', value.id, true);
            cursor.update(metadata);
            episodeSequence++;
            cursor.continue();
          };

          let imageSequence = 0;
          const imageCursor = stores.images.openCursor();
          imageCursor.onsuccess = () => {
            const cursor = imageCursor.result;
            if (!cursor) return;
            const value = cursor.value;
            const { blob, ...metadata } = value;
            metadata._sequence = Number.isSafeInteger(value._sequence) ? value._sequence : imageSequence;
            if (blob instanceof Blob) stores.imageBlobs.put({ id: value.id, workId: value.workId, mimeType: value.mimeType, blob });
            cursor.update(metadata);
            imageSequence++;
            cursor.continue();
          };
        }

        const addSequenceAndScope = (store, makeExtra = () => ({})) => {
          let sequence = 0;
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const row = cursor.value;
            cursor.update({ ...row, _sequence: Number.isSafeInteger(row._sequence) ? row._sequence : sequence, ...makeExtra(row) });
            sequence++;
            cursor.continue();
          };
        };
        for (const storeName of ['chapters', 'scenes', 'characters']) {
          const isNewVersion1Upgrade = event.oldVersion === 1;
          if (isNewVersion1Upgrade) addSequenceAndScope(stores[storeName], storeName === 'scenes' ? scene => ({ scopeKey: sceneScopeKey(scene) }) : undefined);
        }
        if (event.oldVersion === 0) {
          for (const storeName of ['chapters', 'scenes', 'characters', 'images']) {
            addSequenceAndScope(stores[storeName], storeName === 'scenes' ? scene => ({ scopeKey: sceneScopeKey(scene) }) : undefined);
          }
        }
        if (event.oldVersion > 0) {
          const registerRows = (storeName, kind, ownerType = kind, nestedFields = null) => {
            const rowCursor = stores[storeName].openCursor();
            rowCursor.onsuccess = () => {
              const cursor = rowCursor.result;
              if (!cursor) return;
              const row = cursor.value;
              putRegistry(stores.idRegistry, row.id, row.workId, kind, ownerType, row.id, true);
              if (nestedFields) {
                for (const nested of row[nestedFields] || []) {
                  putRegistry(stores.idRegistry, nested.id, row.workId, 'customField', 'customField', row.id, true);
                }
              }
              cursor.continue();
            };
          };
          registerRows('works', 'work');
          registerRows('chapters', 'chapter');
          registerRows('scenes', 'scene');
          registerRows('characters', 'character', 'character', 'customFields');
          registerRows('images', 'image');
          if (event.oldVersion !== 1) registerRows('episodes', 'episode');
        }
        if (event.oldVersion === 2 || event.oldVersion === 3) {
          const bodyCursor = stores.episodeBodies.openCursor();
          bodyCursor.onsuccess = () => {
            const cursor = bodyCursor.result;
            if (!cursor) return;
            if (event.oldVersion === 2) addLineCharacterRefs(stores.lineCharacterRefs, cursor.value.id, cursor.value.workId, cursor.value.lines);
            for (const line of cursor.value.lines || []) putRegistry(stores.idRegistry, line.id, cursor.value.workId, 'line', 'episodeLine', cursor.value.id, true);
            cursor.continue();
          };
        }
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error || new Error('作品データベースを開けません。'));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error('別の画面が作品データベースを使用中です。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => db.close();
        try {
          const tx = db.transaction('works', 'readonly');
          const workRequest = tx.objectStore('works').getAll();
          tx.oncomplete = () => {
            if (settled) { db.close(); return; }
            settled = true;
            workRevisions.set(db, savedRevision(workRequest.result[0]));
            resolve(db);
          };
          tx.onabort = () => {
            if (settled) return;
            settled = true;
            db.close();
            reject(tx.error || new Error('作品データベースを開けません。'));
          };
        } catch (error) {
          settled = true;
          db.close();
          reject(error);
        }
      };
    });
  }

  function sceneScopeKey(scene) {
    if (scene.episodeId !== null) return `episode:${scene.episodeId}`;
    if (scene.chapterId !== null) return `chapter:${scene.chapterId}`;
    return 'unassigned';
  }

  function addLineCharacterRefs(store, episodeId, workId, lines) {
    for (const line of lines || []) {
      if (line.characterId !== null && typeof line.characterId === 'string') {
        store.put({
          id: JSON.stringify(['line-character', episodeId, line.id, line.characterId]),
          workId, episodeId, lineId: line.id, characterId: line.characterId
        });
      }
    }
  }

  function registryOwnerKey(ownerType, ownerId) {
    return JSON.stringify([ownerType, ownerId]);
  }

  function putRegistry(store, globalId, workId, kind, ownerType, ownerId, add = false) {
    const record = {
      id: JSON.stringify([kind, ownerType, ownerId, globalId]),
      globalId, workId, kind, ownerType, ownerId,
      ownerKey: registryOwnerKey(ownerType, ownerId)
    };
    return store[add ? 'add' : 'put'](record);
  }

  function transactionPromise(tx, onComplete) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error || new Error('作品データを保存できませんでした。'));
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        try { resolve(onComplete()); } catch (error) { reject(error); }
      };
      tx.onabort = () => fail(tx.error);
    });
  }

  function readRequest(request, tx) {
    return new Promise(resolve => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        try { tx.abort(); } catch { /* The request may already have aborted the transaction. */ }
      };
    });
  }

  function removeStorageFields(record) {
    const { _sequence, scopeKey, ...value } = record;
    return value;
  }

  function sequenceOf(record, fallback = 0) {
    return Number.isSafeInteger(record._sequence) ? record._sequence : fallback;
  }

  function orderCompare(left, right) {
    return (left.order ?? 0) - (right.order ?? 0) || sequenceOf(left) - sequenceOf(right) || String(left.id).localeCompare(String(right.id));
  }

  async function saveWork(store, rawPackage) {
    if (!packageTools) throw new Error('作品保存モジュールが読み込まれていません。');
    const value = await packageTools.validatePackage(rawPackage);
    const tx = store.transaction(STORE_NAMES, 'readwrite');
    const saved = transactionPromise(tx, () => value);
    const expectedRevision = workRevisions.get(store);
    let failure, nextRevision;
    const currentRequest = tx.objectStore('works').getAll();
    currentRequest.onsuccess = () => {
      try {
        const currentRevision = savedRevision(currentRequest.result[0]);
        if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw conflictError();
        nextRevision = currentRevision + 1;
        for (const name of STORE_NAMES) tx.objectStore(name).clear();
        const work = value.work;
        tx.objectStore('works').put({ schemaVersion: work.schemaVersion, id: work.id, title: work.title, summary: work.summary, _revision: nextRevision });
        const idRegistry = tx.objectStore('idRegistry');
        putRegistry(idRegistry, work.id, work.id, 'work', 'work', work.id);
        work.chapters.forEach((chapter, index) => {
          tx.objectStore('chapters').put({ ...chapter, _sequence: index });
          putRegistry(idRegistry, chapter.id, work.id, 'chapter', 'chapter', chapter.id);
        });
        work.episodes.forEach((episode, index) => {
          const { lines, ...metadata } = episode;
          tx.objectStore('episodes').put({ ...metadata, _sequence: index });
          tx.objectStore('episodeBodies').put({ id: episode.id, workId: episode.workId, lines });
          putRegistry(idRegistry, episode.id, work.id, 'episode', 'episode', episode.id);
          addLineCharacterRefs(tx.objectStore('lineCharacterRefs'), episode.id, episode.workId, lines);
          for (const line of lines) putRegistry(idRegistry, line.id, work.id, 'line', 'episodeLine', episode.id);
        });
        work.scenes.forEach((scene, index) => {
          tx.objectStore('scenes').put({ ...scene, _sequence: index, scopeKey: sceneScopeKey(scene) });
          putRegistry(idRegistry, scene.id, work.id, 'scene', 'scene', scene.id);
        });
        work.characters.forEach((character, index) => {
          tx.objectStore('characters').put({ ...character, _sequence: index });
          putRegistry(idRegistry, character.id, work.id, 'character', 'character', character.id);
          for (const field of character.customFields) putRegistry(idRegistry, field.id, work.id, 'customField', 'customField', character.id);
        });
        const payloadById = new Map(value.images.map(image => [image.id, image]));
        work.images.forEach((metadata, index) => {
          tx.objectStore('images').put({ ...metadata, _sequence: index });
          putRegistry(idRegistry, metadata.id, work.id, 'image', 'image', metadata.id);
          const payload = payloadById.get(metadata.id);
          tx.objectStore('imageBlobs').put({ id: metadata.id, workId: work.id, mimeType: metadata.mimeType, blob: payload.blob });
        });
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch { /* A request may already have aborted the transaction. */ }
      }
    };
    try { await saved; }
    catch (error) { throw failure || error; }
    workRevisions.set(store, nextRevision);
    return value;
  }

  function loadWorkIndex(store) {
    const tx = store.transaction(['works', 'chapters', 'episodes', 'characters'], 'readonly');
    const requests = {
      works: tx.objectStore('works').getAll(),
      chapters: tx.objectStore('chapters').index('workId'),
      episodes: tx.objectStore('episodes').index('workId'),
      characters: tx.objectStore('characters').index('workId')
    };
    const workPromise = readRequest(requests.works, tx);
    const indexPromise = readRequest(requests.chapters.getAll(), tx);
    const episodePromise = readRequest(requests.episodes.getAll(), tx);
    const characterPromise = readRequest(requests.characters.getAll(), tx);
    return transactionPromise(tx, () => Promise.all([workPromise, indexPromise, episodePromise, characterPromise]))
      .then(([works, chapters, episodes, characters]) => {
        if (works.length > 1) throw new Error('複数の作品が保存されています。');
        if (!works.length) { workRevisions.set(store, 0); return null; }
        const work = works[0];
        workRevisions.set(store, savedRevision(work));
        const chapterValues = chapters.filter(record => record.workId === work.id).sort(orderCompare).map(removeStorageFields);
        const chapterOrder = new Map(chapterValues.map(chapter => [chapter.id, chapter.order]));
        const episodeValues = episodes.filter(record => record.workId === work.id)
          .sort((a, b) => (chapterOrder.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER) - (chapterOrder.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER) || orderCompare(a, b))
          .map(removeStorageFields);
        return {
          work: { schemaVersion: work.schemaVersion, id: work.id, title: work.title, summary: work.summary },
          chapters: chapterValues,
          episodes: episodeValues,
          characters: characters.filter(record => record.workId === work.id)
            .sort((a, b) => sequenceOf(a) - sequenceOf(b) || String(a.id).localeCompare(String(b.id))).map(removeStorageFields)
        };
      });
  }

  function loadEpisode(store, episodeId) {
    if (typeof episodeId !== 'string' || !episodeId) return Promise.reject(new Error('話IDが不正です。'));
    const tx = store.transaction(['episodes', 'episodeBodies'], 'readonly');
    const episodePromise = readRequest(tx.objectStore('episodes').get(episodeId), tx);
    const bodyPromise = readRequest(tx.objectStore('episodeBodies').get(episodeId), tx);
    return transactionPromise(tx, () => Promise.all([episodePromise, bodyPromise]))
      .then(([episode, body]) => {
        if (!episode && !body) return null;
        if (!episode || !body) throw new Error('話の本文または話情報が保存されていません。');
        return { ...removeStorageFields(episode), lines: body.lines };
      });
  }

  function loadScenes(store, scope) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return Promise.reject(new Error('シーンの読込範囲が不正です。'));
    const selectors = ['episodeId', 'chapterId'].filter(name => typeof scope[name] === 'string' && scope[name]);
    if (scope.unassigned === true) selectors.push('unassigned');
    if (selectors.length !== 1) return Promise.reject(new Error('episodeId、chapterId、unassignedのいずれか一つを指定してください。'));
    const tx = store.transaction(['scenes'], 'readonly');
    let request;
    let filter;
    if (selectors[0] === 'episodeId') {
      request = tx.objectStore('scenes').index('episodeId').getAll(scope.episodeId);
      filter = scene => scene.episodeId === scope.episodeId;
    } else if (selectors[0] === 'chapterId') {
      request = tx.objectStore('scenes').index('chapterId').getAll(scope.chapterId);
      filter = scene => scene.episodeId === null && scene.chapterId === scope.chapterId;
    } else {
      request = tx.objectStore('scenes').index('scopeKey').getAll('unassigned');
      filter = scene => scene.chapterId === null && scene.episodeId === null;
    }
    const rows = readRequest(request, tx);
    return transactionPromise(tx, () => rows).then(values => values.filter(filter).sort(orderCompare).map(removeStorageFields));
  }

  function loadImage(store, imageId) {
    if (typeof imageId !== 'string' || !imageId) return Promise.reject(new Error('画像IDが不正です。'));
    const tx = store.transaction(['images', 'imageBlobs'], 'readonly');
    const metadataPromise = readRequest(tx.objectStore('images').get(imageId), tx);
    const blobPromise = readRequest(tx.objectStore('imageBlobs').get(imageId), tx);
    return transactionPromise(tx, () => Promise.all([metadataPromise, blobPromise]))
      .then(([metadata, payload]) => {
        if (!metadata && !payload) return null;
        if (!metadata || !payload) throw new Error('画像情報または画像Blobが保存されていません。');
        return { ...removeStorageFields(metadata), blob: payload.blob };
      });
  }

  function loadWork(store) {
    if (!packageTools) return Promise.reject(new Error('作品保存モジュールが読み込まれていません。'));
    const tx = store.transaction(STORE_NAMES, 'readonly');
    const results = {};
    for (const name of STORE_NAMES) results[name] = readRequest(tx.objectStore(name).getAll(), tx);
    return transactionPromise(tx, () => Promise.all(Object.values(results))).then(async arrays => {
      const rows = Object.fromEntries(STORE_NAMES.map((name, index) => [name, arrays[index]]));
      if (rows.works.length > 1) throw new Error('複数の作品が保存されています。');
      if (!rows.works.length) {
        if (STORE_NAMES.slice(1).some(name => rows[name].length > 0)) throw new Error('作品に紐づかない保存データがあります。');
        return null;
      }
      const base = rows.works[0];
      const chapters = rows.chapters.filter(item => item.workId === base.id).sort(orderCompare).map(removeStorageFields);
      const chapterOrder = new Map(chapters.map(item => [item.id, item.order]));
      const bodies = new Map(rows.episodeBodies.map(item => [item.id, item]));
      const episodes = rows.episodes.filter(item => item.workId === base.id)
        .sort((a, b) => (chapterOrder.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER) - (chapterOrder.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER) || orderCompare(a, b))
        .map(item => {
          const body = bodies.get(item.id);
          if (!body) throw new Error('話の本文が保存されていません。');
          return { ...removeStorageFields(item), lines: body.lines };
        });
      const scenes = rows.scenes.filter(item => item.workId === base.id).sort(orderCompare).map(removeStorageFields);
      const characters = rows.characters.filter(item => item.workId === base.id)
        .sort((a, b) => sequenceOf(a) - sequenceOf(b) || String(a.id).localeCompare(String(b.id))).map(removeStorageFields);
      const blobs = new Map(rows.imageBlobs.map(item => [item.id, item]));
      const imageRecords = rows.images.filter(item => item.workId === base.id)
        .sort((a, b) => sequenceOf(a) - sequenceOf(b) || String(a.id).localeCompare(String(b.id)));
      const images = imageRecords.map(item => {
        const payload = blobs.get(item.id);
        if (!payload) throw new Error('画像Blobが保存されていません。');
        return { id: item.id, mimeType: item.mimeType, blob: payload.blob };
      });
      if (bodies.size !== episodes.length || blobs.size !== imageRecords.length) throw new Error('本文または画像データに孤立した記録があります。');
      const work = {
        schemaVersion: base.schemaVersion, id: base.id, title: base.title, summary: base.summary,
        chapters, episodes, scenes, characters,
        images: imageRecords.map(removeStorageFields)
      };
      return packageTools.validatePackage({ work, images });
    });
  }

  function validateSection(changes, name, workId, validators = {}) {
    if (changes[name] === undefined) return null;
    const section = changes[name];
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(`${name}の差分が不正です。`);
    const upsert = section.upsert ?? [];
    const deleteIds = section.deleteIds ?? [];
    if (!Array.isArray(upsert) || !Array.isArray(deleteIds)) throw new Error(`${name}の差分配列が不正です。`);
    const ids = new Set();
    for (const id of deleteIds) {
      if (typeof id !== 'string' || !id || ids.has(id)) throw new Error(`${name}の削除IDが不正か重複しています。`);
      ids.add(id);
    }
    for (const record of upsert) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !record.id ||
          ids.has(record.id) || record.workId !== workId) throw new Error(`${name}の更新レコードが不正か重複しています。`);
      ids.add(record.id);
      validators.validate?.(record);
    }
    return { upsert, deleteIds };
  }

  function requireString(value, label) {
    if (typeof value !== 'string') throw new Error(`${label}は文字列である必要があります。`);
  }

  function validateOrderedRecord(record, label) {
    requireString(record.title, `${label}タイトル`);
    if (!Number.isSafeInteger(record.order) || record.order < 0) throw new Error(`${label}の並び順が不正です。`);
  }

  function validateEpisodeRecord(episode) {
    validateOrderedRecord(episode, '話');
    requireString(episode.chapterId, '章ID');
    if (!Array.isArray(episode.lines) || !episode.lines.length) throw new Error('話には本文行が必要です。');
    const ids = new Set();
    for (const line of episode.lines) {
      if (!line || typeof line !== 'object' || Array.isArray(line) || typeof line.id !== 'string' || !line.id || ids.has(line.id)) throw new Error('本文行IDが不正か重複しています。');
      ids.add(line.id);
      requireString(line.speaker, '人物名');
      requireString(line.text, '本文');
      if (/[\r\n]/.test(line.text) || (line.characterId !== null && typeof line.characterId !== 'string')) throw new Error('本文行の内容が不正です。');
    }
  }

  function validateSceneRecord(scene) {
    if (!Number.isSafeInteger(scene.order) || scene.order < 0) throw new Error('シーンの並び順が不正です。');
    for (const [key, label] of [['summary', 'シーン要約'], ['purpose', 'シーンの目的'], ['viewpoint', '視点'], ['location', '場所'], ['time', '時間'], ['notes', 'シーンメモ']]) {
      requireString(scene[key], label);
    }
    if (scene.chapterId !== null) requireString(scene.chapterId, '章ID');
    if (scene.episodeId !== null) requireString(scene.episodeId, '話ID');
    if (!Array.isArray(scene.characterIds) || !Array.isArray(scene.imageIds)) throw new Error('シーンの参照配列が不正です。');
    if ((scene.startLineId === null) !== (scene.endLineId === null) ||
        (scene.startLineId !== null && (typeof scene.startLineId !== 'string' || typeof scene.endLineId !== 'string')) ||
        !Number.isSafeInteger(scene.nextImageNumber) || scene.nextImageNumber < 1) throw new Error('シーンの本文範囲または画像番号が不正です。');
    for (const list of [scene.characterIds, scene.imageIds]) {
      if (list.some(id => typeof id !== 'string' || !id) || new Set(list).size !== list.length) throw new Error('シーンの参照IDが不正か重複しています。');
    }
  }

  function validateCharacterRecord(character) {
    for (const [key, label] of [
      ['name', '人物名'], ['role', '役割'], ['description', '人物説明'], ['appearance', '外見'],
      ['personality', '性格'], ['goal', '目的'], ['background', '背景'], ['relationshipNotes', '関係メモ']
    ]) requireString(character[key], label);
    if (!Array.isArray(character.imageIds) || !Array.isArray(character.customFields)) throw new Error('人物の参照配列が不正です。');
    if (character.imageIds.some(id => typeof id !== 'string' || !id) || new Set(character.imageIds).size !== character.imageIds.length) {
      throw new Error('人物画像の参照IDが不正か重複しています。');
    }
    for (const field of character.customFields) {
      if (!field || typeof field.id !== 'string' || !field.id || typeof field.label !== 'string' || typeof field.value !== 'string') {
        throw new Error('人物の自由項目が不正です。');
      }
    }
  }

  function validateImageRecord(image) {
    if (!['scene', 'character'].includes(image.ownerType) || typeof image.ownerId !== 'string' || !image.ownerId ||
        !Number.isSafeInteger(image.order) || image.order < 0 || typeof image.name !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)) throw new Error('画像メタデータが不正です。');
    if (image.ownerType === 'scene' && (!Number.isSafeInteger(image.referenceNumber) || image.referenceNumber < 1)) throw new Error('シーン画像番号が不正です。');
    if (image.ownerType === 'character' && image.referenceNumber !== null) throw new Error('人物画像番号が不正です。');
  }

  async function saveChanges(store, changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || typeof changes.workId !== 'string' || !changes.workId) {
      throw new Error('差分保存にはworkIdが必要です。');
    }
    const workId = changes.workId;
    const expectedRevision = workRevisions.get(store);
    if (changes.work !== undefined) {
      const work = changes.work;
      if (!work || work.id !== workId || work.schemaVersion !== MODEL_VERSION) throw new Error('作品の差分が不正です。');
      requireString(work.title, '作品名');
      requireString(work.summary, '作品概要');
    }
    const sections = {
      chapters: validateSection(changes, 'chapters', workId, { validate: record => validateOrderedRecord(record, '章') }),
      episodes: validateSection(changes, 'episodes', workId, { validate: validateEpisodeRecord }),
      scenes: validateSection(changes, 'scenes', workId, { validate: validateSceneRecord }),
      characters: validateSection(changes, 'characters', workId, { validate: validateCharacterRecord }),
      images: validateSection(changes, 'images', workId, { validate: validateImageRecord })
    };
    const anyChanges = changes.work !== undefined || Object.values(sections).some(section => section && (section.upsert.length || section.deleteIds.length));
    if (!anyChanges) throw new Error('保存する差分がありません。');
    if (sections.images) {
      for (const image of sections.images.upsert) await packageTools.validateImageBlob(image.mimeType, image.blob);
    }

    const storeNames = new Set(['works']);
    if (sections.chapters) ['chapters', 'episodes', 'scenes'].forEach(name => storeNames.add(name));
    if (sections.episodes) ['episodes', 'episodeBodies', 'lineCharacterRefs', 'chapters', 'scenes', 'characters'].forEach(name => storeNames.add(name));
    if (sections.scenes) ['scenes', 'chapters', 'episodes', 'episodeBodies', 'characters', 'images'].forEach(name => storeNames.add(name));
    if (sections.characters) ['characters', 'images', 'scenes'].forEach(name => storeNames.add(name));
    if (sections.characters?.deleteIds.length) storeNames.add('lineCharacterRefs');
    if (sections.images) ['images', 'imageBlobs', 'scenes', 'characters'].forEach(name => storeNames.add(name));
    storeNames.add('idRegistry');
    const tx = store.transaction([...storeNames], 'readwrite');
    let failure;
    let nextRevision;
    let sequenceSeed = Date.now() * 1000;
    const complete = transactionPromise(tx, () => ({ workId }));
    const abort = error => {
      failure = error;
      try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
    };
    const sequenceStore = { chapters: 'chapters', episodes: 'episodes', scenes: 'scenes', characters: 'characters', images: 'images' };
    function createReadStage(onReady) {
      let pending = 1;
      let sealed = false;
      let finished = false;
      const values = new Map();
      const maybeReady = () => {
        if (!sealed || pending || finished) return;
        finished = true;
        try { onReady(values); } catch (error) { abort(error); }
      };
      return {
        values,
        request(key, request) {
          if (values.has(key)) return values.get(key);
          const entry = { value: undefined };
          values.set(key, entry);
          pending++;
          request.onsuccess = () => {
            entry.value = request.result;
            pending--;
            maybeReady();
          };
          request.onerror = () => abort(request.error);
          return entry;
        },
        seal() {
          sealed = true;
          pending--;
          maybeReady();
        }
      };
    }
    const initial = createReadStage(values => applyChanges(values));
    const initialRow = (kind, name, id) => initial.request(
      JSON.stringify([kind, name, id]), tx.objectStore(name).get(id)
    );
    const workEntry = initialRow('work', 'works', workId);
    const previousRows = new Map();
    for (const [kind, section] of Object.entries(sections)) {
      if (!section) continue;
      const targetStore = sequenceStore[kind];
      for (const record of section.upsert) {
        previousRows.set(`${kind}\u0000${record.id}`, initialRow('previous', targetStore, record.id));
      }
    }
    const registryOwners = new Map();
    const registerOwnerMutation = (ownerType, ownerId) => {
      const ownerKey = registryOwnerKey(ownerType, ownerId);
      if (!registryOwners.has(ownerKey)) {
        registryOwners.set(ownerKey, initial.request(
          JSON.stringify(['registry-owner', ownerKey]), tx.objectStore('idRegistry').index('ownerKey').getAll(ownerKey)
        ));
      }
    };
    const addOwnerMutations = (section, ownerTypes) => {
      if (!section || (!section.upsert.length && !section.deleteIds.length)) return;
      for (const record of section.upsert) for (const ownerType of ownerTypes) registerOwnerMutation(ownerType, record.id);
      for (const id of section.deleteIds) for (const ownerType of ownerTypes) registerOwnerMutation(ownerType, id);
    };
    addOwnerMutations(sections.chapters, ['chapter']);
    addOwnerMutations(sections.episodes, ['episode', 'episodeLine']);
    addOwnerMutations(sections.scenes, ['scene']);
    addOwnerMutations(sections.characters, ['character', 'customField']);
    addOwnerMutations(sections.images, ['image']);
    const oldLineRefs = new Map();
    if (sections.episodes) {
      const target = tx.objectStore('lineCharacterRefs').index('episodeId');
      for (const id of [...sections.episodes.deleteIds, ...sections.episodes.upsert.map(item => item.id)]) {
        oldLineRefs.set(id, initial.request(JSON.stringify(['line-refs', id]), target.getAll(id)));
      }
    }
    const candidateIds = new Map();
    const addCandidateId = (id, label) => {
      if (typeof id !== 'string' || !id || id === workId) throw new Error('IDが空か、作品IDと重複しています。');
      if (candidateIds.has(id)) throw new Error(`更新patch内でIDが重複しています: ${id}`);
      candidateIds.set(id, label);
    };
    for (const [kind, section] of Object.entries(sections)) {
      if (!section) continue;
      for (const record of section.upsert) addCandidateId(record.id, kind);
      if (kind === 'characters') {
        for (const character of section.upsert) for (const field of character.customFields) addCandidateId(field.id, 'customField');
      }
    }
    const upsertLineIds = new Map();
    for (const episode of sections.episodes?.upsert || []) {
      for (const line of episode.lines) {
        if (upsertLineIds.has(line.id)) throw new Error(`更新patch内で本文行IDが重複しています: ${line.id}`);
        upsertLineIds.set(line.id, episode.id);
      }
    }
    initial.seal();

    function applyChanges(initialValues) {
      const savedWork = workEntry.value;
      if (!savedWork || savedWork.id !== workId) throw new Error('差分保存先の作品がありません。');
      const currentRevision = savedRevision(savedWork);
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw conflictError();
      nextRevision = currentRevision + 1;
      for (const [ownerKey, entry] of registryOwners) {
        for (const row of entry.value) tx.objectStore('idRegistry').delete(row.id);
      }
      for (const episode of sections.episodes?.upsert || []) {
        const existingLines = new Set((registryOwners.get(registryOwnerKey('episodeLine', episode.id))?.value || []).map(row => row.globalId));
        for (const line of episode.lines) if (!existingLines.has(line.id)) addCandidateId(line.id, 'line');
      }
      tx.objectStore('works').put({
        schemaVersion: MODEL_VERSION, id: workId,
        title: changes.work?.title ?? savedWork.title,
        summary: changes.work?.summary ?? savedWork.summary,
        _revision: nextRevision
      });
      const registry = tx.objectStore('idRegistry');
      if (sections.chapters) {
        const target = tx.objectStore('chapters');
        sections.chapters.deleteIds.forEach(id => target.delete(id));
        sections.chapters.upsert.forEach(record => {
          putPreservingSequence('chapters', record);
          putRegistry(registry, record.id, workId, 'chapter', 'chapter', record.id);
        });
      }
      if (sections.episodes) {
        const metadataStore = tx.objectStore('episodes'), bodyStore = tx.objectStore('episodeBodies');
        const refsStore = tx.objectStore('lineCharacterRefs');
        for (const refs of oldLineRefs.values()) for (const ref of refs.value) refsStore.delete(ref.id);
        sections.episodes.deleteIds.forEach(id => { metadataStore.delete(id); bodyStore.delete(id); });
        sections.episodes.upsert.forEach(episode => {
          const { lines, ...metadata } = episode;
          putPreservingSequence('episodes', metadata);
          bodyStore.put({ id: episode.id, workId, lines });
          addLineCharacterRefs(refsStore, episode.id, workId, lines);
          putRegistry(registry, episode.id, workId, 'episode', 'episode', episode.id);
          for (const line of lines) putRegistry(registry, line.id, workId, 'line', 'episodeLine', episode.id);
        });
      }
      if (sections.scenes) {
        const target = tx.objectStore('scenes');
        sections.scenes.deleteIds.forEach(id => target.delete(id));
        sections.scenes.upsert.forEach(scene => {
          putPreservingSequence('scenes', scene, { scopeKey: sceneScopeKey(scene) });
          putRegistry(registry, scene.id, workId, 'scene', 'scene', scene.id);
        });
      }
      if (sections.characters) {
        const target = tx.objectStore('characters');
        sections.characters.deleteIds.forEach(id => target.delete(id));
        sections.characters.upsert.forEach(record => {
          putPreservingSequence('characters', record);
          putRegistry(registry, record.id, workId, 'character', 'character', record.id);
          for (const field of record.customFields) putRegistry(registry, field.id, workId, 'customField', 'customField', record.id);
        });
      }
      if (sections.images) {
        const metadataStore = tx.objectStore('images'), blobStore = tx.objectStore('imageBlobs');
        sections.images.deleteIds.forEach(id => { metadataStore.delete(id); blobStore.delete(id); });
        sections.images.upsert.forEach(image => {
          const { blob, ...metadata } = image;
          putPreservingSequence('images', metadata);
          blobStore.put({ id: image.id, workId, mimeType: image.mimeType, blob });
          putRegistry(registry, image.id, workId, 'image', 'image', image.id);
        });
      }

      function putPreservingSequence(name, record, extra = {}) {
        const kind = Object.keys(sequenceStore).find(key => sequenceStore[key] === name);
        const previous = previousRows.get(`${kind}\u0000${record.id}`)?.value;
        const sequence = previous && Number.isSafeInteger(previous._sequence) ? previous._sequence : sequenceSeed++;
        sequenceSeed = Math.max(sequenceSeed, sequence + 1);
        tx.objectStore(name).put({ ...record, ...extra, _sequence: sequence });
      }

      const validation = createReadStage(values => validateFinalState(values));
      const readKey = (kind, name, key, request) => validation.request(JSON.stringify([kind, name, key]), request);
      const get = (name, id) => readKey('get', name, id, tx.objectStore(name).get(id));
      const byIndex = (name, index, key) => readKey('index', `${name}.${index}`, key, tx.objectStore(name).index(index).getAll(key));
      for (const id of candidateIds.keys()) byIndex('idRegistry', 'globalId', id);

      if (sections.chapters) {
        if (sections.chapters.upsert.length) byIndex('chapters', 'workId', workId);
        for (const id of sections.chapters.deleteIds) {
          byIndex('episodes', 'chapterId', id);
          byIndex('scenes', 'chapterId', id);
        }
      }
      if (sections.episodes) {
        for (const episode of sections.episodes.upsert) {
          get('chapters', episode.chapterId);
          byIndex('episodes', 'chapterId', episode.chapterId);
          byIndex('scenes', 'episodeId', episode.id);
          for (const line of episode.lines) if (line.characterId !== null) get('characters', line.characterId);
        }
        for (const id of sections.episodes.deleteIds) byIndex('scenes', 'episodeId', id);
      }
      if (sections.scenes) {
        for (const scene of sections.scenes.upsert) {
          if (scene.chapterId !== null) get('chapters', scene.chapterId);
          if (scene.episodeId !== null) {
            get('episodes', scene.episodeId);
            get('episodeBodies', scene.episodeId);
          }
          byIndex('scenes', 'scopeKey', sceneScopeKey(scene));
          byIndex('images', 'ownerId', scene.id);
          for (const id of scene.characterIds) get('characters', id);
          for (const id of scene.imageIds) get('images', id);
        }
        for (const id of sections.scenes.deleteIds) byIndex('images', 'ownerId', id);
      }
      if (sections.characters) {
        for (const character of sections.characters.upsert) {
          byIndex('images', 'ownerId', character.id);
          for (const id of character.imageIds) get('images', id);
        }
        for (const id of sections.characters.deleteIds) {
          byIndex('scenes', 'characterIds', id);
          byIndex('lineCharacterRefs', 'characterId', id);
          byIndex('images', 'ownerId', id);
        }
      }
      if (sections.images) {
        for (const image of sections.images.upsert) {
          get(image.ownerType === 'scene' ? 'scenes' : 'characters', image.ownerId);
          byIndex('images', 'ownerId', image.ownerId);
          const previous = previousRows.get(`images\u0000${image.id}`)?.value;
          if (previous && (previous.ownerType !== image.ownerType || previous.ownerId !== image.ownerId)) {
            get(previous.ownerType === 'scene' ? 'scenes' : 'characters', previous.ownerId);
            byIndex('images', 'ownerId', previous.ownerId);
          }
        }
        for (const id of sections.images.deleteIds) {
          byIndex('scenes', 'imageIds', id);
          byIndex('characters', 'imageIds', id);
        }
      }
      validation.seal();

      function validateFinalState(values) {
        const read = (kind, name, key) => values.get(JSON.stringify([kind, name, key]))?.value;
        const one = (name, id) => read('get', name, id);
        const many = (name, index, key) => read('index', `${name}.${index}`, key) || [];
        const requireRow = (name, id, label) => {
          const row = one(name, id);
          if (!row || row.workId !== workId) throw new Error(`${label}の参照先が存在しません。`);
          return row;
        };
        const assertUniqueOrders = (rows, label) => {
          const orders = new Set();
          for (const row of rows.filter(item => item.workId === workId)) {
            if (orders.has(row.order)) throw new Error(`${label}の並び順が重複しています。`);
            orders.add(row.order);
          }
        };
        for (const id of candidateIds.keys()) {
          const occurrences = many('idRegistry', 'globalId', id).filter(row => row.workId === workId);
          if (occurrences.length !== 1) throw new Error(`IDが作品内で重複しています: ${id}`);
        }
        const lineIndexes = episode => new Map(episode.lines.map((line, index) => [line.id, index]));
        const assertOwnerImageList = (ownerType, ownerId) => {
          const ownerStore = ownerType === 'scene' ? 'scenes' : 'characters';
          const owner = one(ownerStore, ownerId);
          const ownerImages = many('images', 'ownerId', ownerId).filter(image => image.workId === workId && image.ownerType === ownerType);
          if (!owner) {
            if (ownerImages.length) throw new Error('画像の所有者が存在しません。');
            return;
          }
          if (owner.workId !== workId || !Array.isArray(owner.imageIds) || ownerImages.length !== owner.imageIds.length ||
              ownerImages.some(image => owner.imageIds[image.order] !== image.id)) {
            throw new Error('画像所有者の一覧と画像記録が一致しません。');
          }
        };
        const validRange = (scene, episode, body) => {
          if ((scene.startLineId === null) !== (scene.endLineId === null)) return false;
          if (scene.startLineId === null) return true;
          if (!episode || !body || scene.episodeId !== episode.id || scene.chapterId !== episode.chapterId) return false;
          const positions = lineIndexes({ lines: body.lines });
          const start = positions.get(scene.startLineId), end = positions.get(scene.endLineId);
          return start !== undefined && end !== undefined && start <= end;
        };

        if (sections.chapters?.upsert.length) assertUniqueOrders(many('chapters', 'workId', workId), '章');
        for (const chapterId of sections.chapters?.deleteIds || []) {
          if (many('episodes', 'chapterId', chapterId).some(row => row.workId === workId) ||
              many('scenes', 'chapterId', chapterId).some(row => row.workId === workId)) throw new Error('使用中の章は削除できません。');
        }
        for (const episodeId of sections.episodes?.deleteIds || []) {
          if (many('scenes', 'episodeId', episodeId).some(row => row.workId === workId)) throw new Error('シーンが参照している話は削除できません。');
        }
        for (const characterId of sections.characters?.deleteIds || []) {
          if (many('scenes', 'characterIds', characterId).some(row => row.workId === workId) ||
              many('lineCharacterRefs', 'characterId', characterId).some(row => row.workId === workId) ||
              many('images', 'ownerId', characterId).some(row => row.workId === workId && row.ownerType === 'character')) {
            throw new Error('本文・シーン・画像が参照している人物は削除できません。');
          }
        }
        for (const sceneId of sections.scenes?.deleteIds || []) {
          if (many('images', 'ownerId', sceneId).some(row => row.workId === workId && row.ownerType === 'scene')) throw new Error('画像が参照しているシーンは削除できません。');
        }
        for (const imageId of sections.images?.deleteIds || []) {
          if (many('scenes', 'imageIds', imageId).some(row => row.workId === workId) ||
              many('characters', 'imageIds', imageId).some(row => row.workId === workId)) throw new Error('シーンまたは人物が参照している画像は削除できません。');
        }

        for (const chapter of sections.chapters?.upsert || []) {
          const rows = many('chapters', 'workId', workId);
          assertUniqueOrders(rows, '章');
        }
        for (const episode of sections.episodes?.upsert || []) {
          const chapter = requireRow('chapters', episode.chapterId, '話の章');
          const sameChapter = many('episodes', 'chapterId', episode.chapterId).filter(row => row.workId === workId);
          assertUniqueOrders(sameChapter, '話');
          for (const line of episode.lines) if (line.characterId !== null) requireRow('characters', line.characterId, '本文の人物');
          for (const scene of many('scenes', 'episodeId', episode.id).filter(row => row.workId === workId)) {
            if (scene.chapterId !== chapter.id || !validRange(scene, episode, { lines: episode.lines })) throw new Error('話の変更でシーン本文参照が切れます。');
          }
        }
        for (const scene of sections.scenes?.upsert || []) {
          let episode = null, body = null;
          if (scene.chapterId !== null) requireRow('chapters', scene.chapterId, 'シーンの章');
          if (scene.episodeId !== null) {
            episode = requireRow('episodes', scene.episodeId, 'シーンの話');
            if (episode.chapterId !== scene.chapterId) throw new Error('シーンの章と話が一致しません。');
            body = one('episodeBodies', scene.episodeId);
          }
          if (!validRange(scene, episode, body)) throw new Error('シーンの本文範囲が存在しないか逆順です。');
          const sameScope = many('scenes', 'scopeKey', sceneScopeKey(scene)).filter(row => row.workId === workId);
          assertUniqueOrders(sameScope, 'シーン');
          let highestImageNumber = 0;
          for (let index = 0; index < scene.characterIds.length; index++) requireRow('characters', scene.characterIds[index], 'シーンの人物');
          for (let index = 0; index < scene.imageIds.length; index++) {
            const image = requireRow('images', scene.imageIds[index], 'シーンの画像');
            if (image.ownerType !== 'scene' || image.ownerId !== scene.id || image.order !== index) throw new Error('シーン画像の所有者または並び順が一致しません。');
            highestImageNumber = Math.max(highestImageNumber, image.referenceNumber);
          }
          const ownerImages = many('images', 'ownerId', scene.id).filter(image => image.workId === workId && image.ownerType === 'scene');
          if (ownerImages.length !== scene.imageIds.length || scene.nextImageNumber <= highestImageNumber) throw new Error('シーン画像一覧または次の画像番号が不正です。');
          const numbers = new Set();
          for (const image of ownerImages) {
            if (numbers.has(image.referenceNumber)) throw new Error('シーン内の画像番号が重複しています。');
            numbers.add(image.referenceNumber);
          }
        }
        for (const character of sections.characters?.upsert || []) {
          for (let index = 0; index < character.imageIds.length; index++) {
            const image = requireRow('images', character.imageIds[index], '人物の画像');
            if (image.ownerType !== 'character' || image.ownerId !== character.id || image.order !== index) throw new Error('人物画像の所有者または並び順が一致しません。');
          }
          const ownerImages = many('images', 'ownerId', character.id).filter(image => image.workId === workId && image.ownerType === 'character');
          if (ownerImages.length !== character.imageIds.length) throw new Error('人物画像一覧が一致しません。');
        }
        for (const image of sections.images?.upsert || []) {
          const ownerStore = image.ownerType === 'scene' ? 'scenes' : 'characters';
          const owner = requireRow(ownerStore, image.ownerId, '画像の所有者');
          if (owner.imageIds[image.order] !== image.id) throw new Error('画像所有者の一覧に同じ位置で登録されていません。');
          const ownerImages = many('images', 'ownerId', image.ownerId).filter(row => row.workId === workId && row.ownerType === image.ownerType);
          if (ownerImages.some(row => owner.imageIds[row.order] !== row.id)) throw new Error('画像の所有者・並び順が一致しません。');
          if (image.ownerType === 'scene') {
            const numbers = ownerImages.map(row => row.referenceNumber);
            if (new Set(numbers).size !== numbers.length || owner.nextImageNumber <= Math.max(0, ...numbers)) throw new Error('シーン画像番号が重複するか次の番号が不正です。');
          }
          const previous = previousRows.get(`images\u0000${image.id}`)?.value;
          if (previous && (previous.ownerType !== image.ownerType || previous.ownerId !== image.ownerId)) {
            assertOwnerImageList(previous.ownerType, previous.ownerId);
          }
        }
      }
    };
    try { await complete; }
    catch (error) { throw failure || error; }
    workRevisions.set(store, nextRevision);
    return { workId };
  }

  const api = { openStore, loadWork, loadWorkIndex, loadEpisode, loadScenes, loadImage, saveWork, saveChanges };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelStorage = api;
})(globalThis);
