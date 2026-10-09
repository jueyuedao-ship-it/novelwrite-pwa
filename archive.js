/* ZIP import/export is loaded on demand so normal editing does not load the codec. */
(function (root) {
  'use strict';

  const packageTools = typeof module !== 'undefined' && module.exports ? require('./package') : root.NovelPackage;
  const common = typeof module !== 'undefined' && module.exports ? require('./archive-common') : root.NovelArchiveCommon;
  const FORMAT = 'fumizukue-work-archive';
  const FORMAT_VERSION = 1;
  const JSON_FILES = ['work.json', 'manuscript.json', 'plot.json', 'characters.json'];
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  async function exportArchive(rawPackage) {
    if (!packageTools || !common) throw new Error('作品アーカイブ用モジュールが読み込まれていません。');
    if (!rawPackage || !Array.isArray(rawPackage.images)) throw new Error('作品パッケージが不正です。');
    const value = await packageTools.validatePackage(rawPackage);
    const payloads = {
      'work.json': {
        schemaVersion: value.work.schemaVersion, id: value.work.id,
        title: value.work.title, summary: value.work.summary, images: value.work.images
      },
      'manuscript.json': { episodes: value.work.episodes },
      'plot.json': { chapters: value.work.chapters, scenes: value.work.scenes },
      'characters.json': { characters: value.work.characters }
    };
    const hashes = {}, entries = [];
    for (const name of JSON_FILES) {
      const bytes = common.encodeJson(payloads[name]);
      hashes[name] = await common.sha256(bytes);
      entries.push({ name, bytes });
    }
    const payloadById = new Map(value.images.map(image => [image.id, image]));
    const imageManifest = [];
    for (let index = 0; index < value.work.images.length; index++) {
      const metadata = value.work.images[index];
      const image = payloadById.get(metadata.id);
      if (!image) throw new Error('作品から参照されている画像本体がありません。');
      const extension = common.extensionFor(image.mimeType);
      if (!extension) throw new Error('対応していない画像形式です。');
      const path = `images/${String(index + 1).padStart(4, '0')}.${extension}`;
      const bytes = new Uint8Array(await image.blob.arrayBuffer());
      imageManifest.push({ id: image.id, mimeType: image.mimeType, path, sha256: await common.sha256(bytes) });
      entries.push({ name: path, bytes });
    }
    entries.push({
      name: 'manifest.json',
      bytes: common.encodeJson({ format: FORMAT, formatVersion: FORMAT_VERSION, workId: value.work.id, hashes, images: imageManifest })
    });
    return common.writeArchive(entries);
  }

  async function importArchiveRead(readResult) {
    if (!packageTools || !common) throw new Error('作品アーカイブ用モジュールが読み込まれていません。');
    const read = readResult;
    if (!read || !read.files || !read.manifest || !Array.isArray(read.entries)) throw new Error('ZIP読み込み結果が不正です。');
    const { files, manifest, entries } = read;
    if (!isObject(manifest) || manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION ||
        typeof manifest.workId !== 'string' || !isObject(manifest.hashes) || !Array.isArray(manifest.images)) {
      throw new Error('対応していない作品ZIP形式です。');
    }
    const expectedHashNames = [...JSON_FILES].sort();
    const hashNames = Object.keys(manifest.hashes).sort();
    if (hashNames.length !== expectedHashNames.length || hashNames.some((name, index) => name !== expectedHashNames[index])) {
      throw new Error('作品JSONのチェックサム一覧が不正です。');
    }
    for (const name of JSON_FILES) {
      const expectedHash = manifest.hashes[name];
      if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || !(files[name] instanceof Uint8Array) ||
          await common.sha256(files[name]) !== expectedHash) throw new Error(`${name}のチェックサムが一致しません。`);
    }

    const workRecord = common.parseJson(files, 'work.json');
    const manuscript = common.parseJson(files, 'manuscript.json');
    const plot = common.parseJson(files, 'plot.json');
    const characters = common.parseJson(files, 'characters.json');
    if (!isObject(workRecord) || !isObject(manuscript) || !Array.isArray(manuscript.episodes) ||
        !isObject(plot) || !Array.isArray(plot.chapters) || !Array.isArray(plot.scenes) ||
        !isObject(characters) || !Array.isArray(characters.characters)) throw new Error('作品ZIP内のJSON構造が不正です。');

    const archiveImages = [], imageIds = new Set(), imagePaths = new Set();
    for (let index = 0; index < manifest.images.length; index++) {
      const image = manifest.images[index];
      const extension = image && common.extensionFor(image.mimeType);
      const expectedPath = `images/${String(index + 1).padStart(4, '0')}.${extension || 'invalid'}`;
      if (!isObject(image) || typeof image.id !== 'string' || imageIds.has(image.id) || !extension ||
          image.path !== expectedPath || imagePaths.has(image.path) || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) {
        throw new Error('ZIP内の画像一覧が不正です。');
      }
      imageIds.add(image.id); imagePaths.add(image.path);
      const imageBytes = files[image.path];
      if (!(imageBytes instanceof Uint8Array) || await common.sha256(imageBytes) !== image.sha256) throw new Error('画像ファイルのチェックサムが一致しません。');
      archiveImages.push({ id: image.id, mimeType: image.mimeType, blob: new Blob([imageBytes], { type: image.mimeType }) });
    }
    const expectedNames = new Set(['manifest.json', ...JSON_FILES, ...imagePaths]);
    if (entries.some(entry => !expectedNames.has(entry.name)) || [...expectedNames].some(name => !(files[name] instanceof Uint8Array))) {
      throw new Error('ZIP内のファイル一覧がmanifestと一致しません。');
    }

    const value = await packageTools.validatePackage({
      work: {
        schemaVersion: workRecord.schemaVersion, id: workRecord.id, title: workRecord.title, summary: workRecord.summary,
        chapters: plot.chapters, episodes: manuscript.episodes, scenes: plot.scenes, characters: characters.characters, images: workRecord.images
      },
      images: archiveImages
    });
    if (value.work.id !== manifest.workId) throw new Error('作品IDがmanifestと一致しません。');
    return value;
  }

  async function importArchive(file) {
    if (!common) throw new Error('ZIP共通モジュールが読み込まれていません。');
    return importArchiveRead(await common.readArchive(file));
  }

  const api = { exportArchive, importArchive, importArchiveRead };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelArchive = api;
})(globalThis);
