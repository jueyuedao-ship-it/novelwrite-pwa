const fs = require('node:fs');

const path = 'storage.js';
let source = fs.readFileSync(path, 'utf8');
const startMarker = '  async function saveWork(store, rawPackage) {';
const endMarker = '\n\n  function loadWorkIndex(store) {';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('saveWork block markers not found');

const replacement = `  function writeValidatedWorkToTransaction(tx, value, { revision, workRecordExtras = {} } = {}) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('作品revisionが不正です。');
    if (!value || typeof value !== 'object' || !value.work || !Array.isArray(value.images)) {
      throw new Error('検証済み作品パッケージが必要です。');
    }
    const work = value.work;
    tx.objectStore('works').put({
      ...workRecordExtras,
      schemaVersion: work.schemaVersion,
      id: work.id,
      title: work.title,
      summary: work.summary,
      _revision: revision
    });
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
      if (!payload?.blob) throw new Error('作品から参照されている画像本体がありません。');
      tx.objectStore('imageBlobs').put({ id: metadata.id, workId: work.id, mimeType: metadata.mimeType, blob: payload.blob });
    });
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
        writeValidatedWorkToTransaction(tx, value, { revision: nextRevision });
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch { /* A request may already have aborted the transaction. */ }
      }
    };
    try { await saved; }
    catch (error) { throw failure || error; }
    workRevisions.set(store, nextRevision);
    return value;
  }`;

source = source.slice(0, start) + replacement + source.slice(end);
const oldApi = "  const api = { openStore, loadWork, loadWorkIndex, loadEpisode, loadScenes, loadImage, saveWork, saveChanges };";
const newApi = "  const api = { openStore, loadWork, loadWorkIndex, loadEpisode, loadScenes, loadImage, saveWork, saveChanges, writeValidatedWorkToTransaction };";
if (!source.includes(oldApi)) throw new Error('storage api marker not found');
source = source.replace(oldApi, newApi);
fs.writeFileSync(path, source);
