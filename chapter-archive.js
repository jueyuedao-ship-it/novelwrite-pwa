/* Dedicated one-chapter ZIP work pack. Loaded only when ZIP operations are requested. */
(function (root) {
  'use strict';

  const packageTools = typeof module !== 'undefined' && module.exports ? require('./package') : root.NovelPackage;
  const common = typeof module !== 'undefined' && module.exports ? require('./archive-common') : root.NovelArchiveCommon;
  const bundleTools = typeof module !== 'undefined' && module.exports ? require('./chapter-bundle') : root.NovelChapterBundle;
  const FORMAT = 'fumizukue-chapter-archive';
  const FORMAT_VERSION = 1;
  const JSON_FILES = [
    'work-ref.json', 'catalog.json', 'chapter/chapter.json', 'chapter/episodes.json',
    'chapter/scenes.json', 'refs/characters.json', 'refs/shared.json'
  ];
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hashPattern = /^[a-f0-9]{64}$/;

  function requireServices() {
    if (!packageTools || !common || !bundleTools) throw new Error('章アーカイブ用モジュールが読み込まれていません。');
  }

  function exportedAtValue(value) {
    const result = value ?? new Date().toISOString();
    if (typeof result !== 'string' || !result || Number.isNaN(Date.parse(result))) throw new Error('章ZIPの書き出し日時が不正です。');
    return result;
  }

  function baseRevisionValue(value) {
    const result = value ?? 0;
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('章ZIPの基準リビジョンが不正です。');
    return result;
  }

  async function exportChapterArchive(rawPackage, chapterId, options = {}) {
    requireServices();
    const validatedPackage = await packageTools.validatePackage(rawPackage);
    const bundle = await bundleTools.buildChapterBundle(validatedPackage, chapterId);
    const payloads = {
      'work-ref.json': { id: bundle.sourceWork.id, title: bundle.sourceWork.title, summary: bundle.sourceWork.summary },
      'catalog.json': { chapters: bundle.catalog },
      'chapter/chapter.json': bundle.chapter,
      'chapter/episodes.json': { episodes: bundle.episodes },
      'chapter/scenes.json': { scenes: bundle.scenes },
      'refs/characters.json': { characters: bundle.characters },
      'refs/shared.json': { title: bundle.sourceWork.title, summary: bundle.sourceWork.summary }
    };
    const hashes = {}, entries = [];
    for (const name of JSON_FILES) {
      const bytes = common.encodeJson(payloads[name]);
      hashes[name] = await common.sha256(bytes);
      entries.push({ name, bytes });
    }

    const counters = { scene: 0, character: 0 };
    const sceneImageHashes = {};
    const imageManifest = [];
    for (const image of bundle.images) {
      const extension = common.extensionFor(image.mimeType);
      if (!extension) throw new Error('対応していない画像形式です。');
      const index = ++counters[image.ownerType];
      const path = `images/${image.ownerType}/${String(index).padStart(4, '0')}.${extension}`;
      const bytes = new Uint8Array(await image.blob.arrayBuffer());
      const digest = await common.sha256(bytes);
      if (image.ownerType === 'scene') sceneImageHashes[image.id] = digest;
      imageManifest.push({
        id: image.id, ownerType: image.ownerType, ownerId: image.ownerId, order: image.order,
        name: image.name, mimeType: image.mimeType, referenceNumber: image.referenceNumber, path, sha256: digest
      });
      entries.push({ name: path, bytes });
    }

    let baseChapterHash = options.baseChapterHash;
    if (baseChapterHash !== undefined && (typeof baseChapterHash !== 'string' || !hashPattern.test(baseChapterHash))) throw new Error('章ZIPの基準ハッシュが不正です。');
    if (baseChapterHash === undefined) {
      baseChapterHash = await common.sha256(common.encodeJson(bundleTools.canonicalChapterValue(bundle, sceneImageHashes)));
    }
    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      schemaVersion: bundle.sourceWork.schemaVersion,
      sourceWorkId: bundle.sourceWork.id,
      chapterId: bundle.chapter.id,
      baseRevision: baseRevisionValue(options.baseRevision),
      baseChapterHash,
      exportedAt: exportedAtValue(options.exportedAt),
      hashes,
      images: imageManifest
    };
    entries.push({ name: 'manifest.json', bytes: common.encodeJson(manifest) });
    return common.writeArchive(entries);
  }

  function validateManifest(manifest) {
    if (!isObject(manifest) || manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION || manifest.schemaVersion !== 4 ||
        typeof manifest.sourceWorkId !== 'string' || !manifest.sourceWorkId || typeof manifest.chapterId !== 'string' || !manifest.chapterId ||
        !Number.isSafeInteger(manifest.baseRevision) || manifest.baseRevision < 0 || typeof manifest.baseChapterHash !== 'string' || !hashPattern.test(manifest.baseChapterHash) ||
        typeof manifest.exportedAt !== 'string' || !manifest.exportedAt || Number.isNaN(Date.parse(manifest.exportedAt)) ||
        !isObject(manifest.hashes) || !Array.isArray(manifest.images)) {
      throw new Error('対応していない章ZIP形式またはmanifestです。');
    }
    const expected = [...JSON_FILES].sort(), actual = Object.keys(manifest.hashes).sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error('章JSONのチェックサム一覧が不正です。');
    for (const name of JSON_FILES) if (typeof manifest.hashes[name] !== 'string' || !hashPattern.test(manifest.hashes[name])) throw new Error('章JSONのチェックサム一覧が不正です。');
  }

  async function importChapterArchiveRead(readResult) {
    requireServices();
    if (!readResult || !readResult.files || !readResult.manifest || !Array.isArray(readResult.entries)) throw new Error('ZIP読み込み結果が不正です。');
    const { files, manifest, entries } = readResult;
    validateManifest(manifest);

    for (const name of JSON_FILES) {
      if (!(files[name] instanceof Uint8Array) || await common.sha256(files[name]) !== manifest.hashes[name]) throw new Error(`${name}のチェックサムが一致しません。`);
    }
    const workRef = common.parseJson(files, 'work-ref.json');
    const catalog = common.parseJson(files, 'catalog.json');
    const chapter = common.parseJson(files, 'chapter/chapter.json');
    const episodes = common.parseJson(files, 'chapter/episodes.json');
    const scenes = common.parseJson(files, 'chapter/scenes.json');
    const characters = common.parseJson(files, 'refs/characters.json');
    const shared = common.parseJson(files, 'refs/shared.json');
    if (!isObject(workRef) || typeof workRef.id !== 'string' || typeof workRef.title !== 'string' || typeof workRef.summary !== 'string' ||
        !isObject(catalog) || !Array.isArray(catalog.chapters) || !isObject(chapter) || !isObject(episodes) || !Array.isArray(episodes.episodes) ||
        !isObject(scenes) || !Array.isArray(scenes.scenes) || !isObject(characters) || !Array.isArray(characters.characters) ||
        !isObject(shared) || typeof shared.title !== 'string' || typeof shared.summary !== 'string') {
      throw new Error('章ZIP内のJSON構造が不正です。');
    }
    if (workRef.id !== manifest.sourceWorkId || chapter.id !== manifest.chapterId || chapter.workId !== manifest.sourceWorkId) throw new Error('章ZIPの作品IDまたは章IDがmanifestと一致しません。');
    if (shared.title !== workRef.title || shared.summary !== workRef.summary) throw new Error('章ZIPの共有設定スナップショットが一致しません。');

    const counters = { scene: 0, character: 0 }, ids = new Set(), paths = new Set(), images = [];
    for (const image of manifest.images) {
      const extension = image && common.extensionFor(image.mimeType);
      if (!isObject(image) || typeof image.id !== 'string' || !image.id || ids.has(image.id) || !['scene', 'character'].includes(image.ownerType) ||
          typeof image.ownerId !== 'string' || !image.ownerId || !Number.isSafeInteger(image.order) || image.order < 0 || typeof image.name !== 'string' ||
          !extension || typeof image.sha256 !== 'string' || !hashPattern.test(image.sha256) || paths.has(image.path)) throw new Error('章ZIP内の画像一覧が不正です。');
      if ((image.ownerType === 'scene' && (!Number.isSafeInteger(image.referenceNumber) || image.referenceNumber < 1)) ||
          (image.ownerType === 'character' && image.referenceNumber !== null)) throw new Error('章ZIP内の画像一覧が不正です。');
      const expectedPath = `images/${image.ownerType}/${String(++counters[image.ownerType]).padStart(4, '0')}.${extension}`;
      if (image.path !== expectedPath) throw new Error('章ZIP内の画像パスが不正です。');
      ids.add(image.id); paths.add(image.path);
      const bytes = files[image.path];
      if (!(bytes instanceof Uint8Array) || await common.sha256(bytes) !== image.sha256) throw new Error('章ZIP内の画像ファイルのチェックサムが一致しません。');
      images.push({
        id: image.id, workId: manifest.sourceWorkId, ownerType: image.ownerType, ownerId: image.ownerId, order: image.order,
        name: image.name, mimeType: image.mimeType, referenceNumber: image.referenceNumber,
        blob: new Blob([bytes], { type: image.mimeType })
      });
    }
    const expectedNames = new Set(['manifest.json', ...JSON_FILES, ...paths]);
    if (entries.some(entry => !expectedNames.has(entry.name)) || [...expectedNames].some(name => !(files[name] instanceof Uint8Array))) throw new Error('章ZIP内のファイル一覧がmanifestと一致しません。');

    const bundle = bundleTools.validateChapterBundle({
      sourceWork: { schemaVersion: manifest.schemaVersion, id: workRef.id, title: workRef.title, summary: workRef.summary },
      catalog: catalog.chapters,
      chapter,
      episodes: episodes.episodes,
      scenes: scenes.scenes,
      characters: characters.characters,
      images
    });
    if (bundle.sourceWork.id !== manifest.sourceWorkId || bundle.chapter.id !== manifest.chapterId) throw new Error('章ZIPのIDがmanifestと一致しません。');
    const packageValue = await packageTools.validatePackage(bundleTools.chapterBundleToPackage(bundle));
    const workspaceMeta = {
      id: 'active', mode: 'chapter-workspace', sourceWorkId: manifest.sourceWorkId,
      catalog: structuredClone(bundle.catalog), loadedChapterIds: [manifest.chapterId],
      baselines: { [manifest.chapterId]: { baseChapterHash: manifest.baseChapterHash, exportedAt: manifest.exportedAt } },
      sharedReadOnly: true
    };
    return { bundle, packageValue, workspaceMeta };
  }

  async function importChapterArchive(file) {
    requireServices();
    return importChapterArchiveRead(await common.readArchive(file));
  }

  const api = { FORMAT, FORMAT_VERSION, exportChapterArchive, importChapterArchiveRead, importChapterArchive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelChapterArchive = api;
})(globalThis);
