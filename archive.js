/* ZIP import/export is loaded on demand so normal editing does not load the codec. */
(function (root) {
  'use strict';

  const packageTools = typeof module !== 'undefined' && module.exports ? require('./package') : root.NovelPackage;
  const FORMAT = 'fumizukue-work-archive';
  const FORMAT_VERSION = 1;
  const JSON_FILES = ['work.json', 'manuscript.json', 'plot.json', 'characters.json'];
  const MAX_ZIP_BYTES = 258 * 1024 * 1024;
  const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
  const MAX_ENTRIES = 10010;
  let zipPromise;

  function loadZipLibrary() {
    if (!zipPromise) {
      zipPromise = typeof module !== 'undefined' && module.exports
        ? Promise.resolve().then(() => require('fflate'))
        : import('./vendor/fflate.mjs');
      zipPromise = zipPromise.catch(error => {
        zipPromise = undefined;
        throw error;
      });
    }
    return zipPromise;
  }

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const encode = value => new TextEncoder().encode(value);
  const decodeText = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');

  async function sha256(bytes) {
    const cryptoApi = root.crypto || globalThis.crypto;
    if (!cryptoApi || !cryptoApi.subtle) throw new Error('SHA-256検証を利用できません。');
    return hex(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes)));
  }

  function extensionFor(mimeType) {
    return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mimeType];
  }

  function parseJson(files, name) {
    try { return JSON.parse(decodeText(files[name])); }
    catch { throw new Error(`${name}を読み込めません。`); }
  }

  function preflightZip(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 22 || bytes.length > MAX_ZIP_BYTES) {
      throw new Error('ZIPファイルのサイズが不正です。');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = offset => view.getUint16(offset, true);
    const u32 = offset => view.getUint32(offset, true);
    let endOffset = -1;
    const earliest = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= earliest; offset--) {
      if (u32(offset) === 0x06054b50) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error('ZIPの終了レコードがありません。');
    const disk = u16(endOffset + 4);
    const directoryDisk = u16(endOffset + 6);
    const diskEntries = u16(endOffset + 8);
    const entryCount = u16(endOffset + 10);
    const directorySize = u32(endOffset + 12);
    const directoryOffset = u32(endOffset + 16);
    const commentLength = u16(endOffset + 20);
    if (endOffset + 22 + commentLength !== bytes.length || disk !== 0 || directoryDisk !== 0 ||
        diskEntries !== entryCount || entryCount === 0 || entryCount > MAX_ENTRIES ||
        entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff ||
        directoryOffset + directorySize > endOffset) {
      throw new Error('複数ディスク・ZIP64・不正な中央ディレクトリには対応していません。');
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const entries = [];
    const seenNames = new Set();
    let totalSize = 0;
    let offset = directoryOffset;
    for (let index = 0; index < entryCount; index++) {
      if (offset + 46 > directoryOffset + directorySize || u32(offset) !== 0x02014b50) {
        throw new Error('ZIPの中央ディレクトリが不正です。');
      }
      const flags = u16(offset + 8);
      const method = u16(offset + 10);
      const compressedSize = u32(offset + 20);
      const uncompressedSize = u32(offset + 24);
      const nameLength = u16(offset + 28);
      const extraLength = u16(offset + 30);
      const entryCommentLength = u16(offset + 32);
      const entryDisk = u16(offset + 34);
      const localOffset = u32(offset + 42);
      const nextOffset = offset + 46 + nameLength + extraLength + entryCommentLength;
      if (!nameLength || nextOffset > directoryOffset + directorySize || entryDisk !== 0 ||
          (flags & 1) !== 0 || (method !== 0 && method !== 8) ||
          compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
          uncompressedSize > MAX_ENTRY_BYTES || localOffset + 30 > directoryOffset) {
        throw new Error('ZIP内のファイル情報が不正か、対応範囲を超えています。');
      }
      let name;
      try { name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)); }
      catch { throw new Error('ZIP内のファイル名が不正です。'); }
      if (seenNames.has(name)) throw new Error('ZIP内に同じファイル名が複数あります。');
      seenNames.add(name);

      if (u32(localOffset) !== 0x04034b50) throw new Error('ZIP内のファイル本体がありません。');
      const localFlags = u16(localOffset + 6);
      const localMethod = u16(localOffset + 8);
      const localNameLength = u16(localOffset + 26);
      const localExtraLength = u16(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      let localName;
      try { localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)); }
      catch { throw new Error('ZIP内のファイル名が不正です。'); }
      if (localName !== name || localFlags !== flags || localMethod !== method ||
          dataOffset + compressedSize > directoryOffset) {
        throw new Error('ZIP内の見出しとファイル本体が一致しません。');
      }
      totalSize += uncompressedSize;
      if (totalSize > MAX_TOTAL_BYTES) throw new Error('展開後のZIPサイズが上限を超えています。');
      entries.push({ name, compressedSize, uncompressedSize, method });
      offset = nextOffset;
    }
    if (offset !== directoryOffset + directorySize) throw new Error('ZIPの中央ディレクトリ長が一致しません。');
    return entries;
  }

  async function exportArchive(rawPackage) {
    if (!packageTools) throw new Error('作品アーカイブ用モジュールが読み込まれていません。');
    if (!rawPackage || !Array.isArray(rawPackage.images)) throw new Error('作品パッケージが不正です。');
    if (rawPackage.images.length + JSON_FILES.length + 1 > MAX_ENTRIES) throw new Error('ZIP内のファイル数が上限を超えています。');
    let estimatedImageBytes = 0;
    for (const image of rawPackage.images) {
      if (!image || !image.blob || typeof image.blob.size !== 'number' || image.blob.size > MAX_ENTRY_BYTES) {
        throw new Error('ZIP内の画像サイズが上限を超えています。');
      }
      estimatedImageBytes += image.blob.size;
      if (estimatedImageBytes > MAX_TOTAL_BYTES) throw new Error('ZIP展開後の画像サイズが上限を超えています。');
    }
    const value = await packageTools.validatePackage(rawPackage);
    const zip = await loadZipLibrary();
    const payloads = {
      'work.json': {
        schemaVersion: value.work.schemaVersion, id: value.work.id,
        title: value.work.title, summary: value.work.summary, images: value.work.images
      },
      'manuscript.json': { episodes: value.work.episodes },
      'plot.json': { chapters: value.work.chapters, scenes: value.work.scenes },
      'characters.json': { characters: value.work.characters }
    };
    const hashes = {};
    const jsonFiles = [];
    let totalBytes = 0;
    for (const name of JSON_FILES) {
      const bytes = encode(JSON.stringify(payloads[name]));
      if (bytes.length > MAX_ENTRY_BYTES) throw new Error(`${name}のサイズが上限を超えています。`);
      totalBytes += bytes.length;
      jsonFiles.push([name, bytes]);
      hashes[name] = await sha256(bytes);
    }

    const payloadById = new Map(value.images.map(image => [image.id, image]));
    const imageEntries = value.work.images.map((metadata, index) => {
      const image = payloadById.get(metadata.id);
      if (!image) throw new Error('作品から参照されている画像本体がありません。');
      totalBytes += image.blob.size;
      return { image, path: `images/${String(index + 1).padStart(4, '0')}.${extensionFor(image.mimeType)}` };
    });
    const manifest = {
      format: FORMAT, formatVersion: FORMAT_VERSION, workId: value.work.id,
      hashes, images: imageEntries.map(({ image, path }) => ({ id: image.id, mimeType: image.mimeType, path, sha256: '0'.repeat(64) }))
    };
    const manifestSize = encode(JSON.stringify(manifest)).length;
    if (manifestSize > MAX_ENTRY_BYTES || totalBytes + manifestSize > MAX_TOTAL_BYTES) {
      throw new Error('ZIP展開後のデータサイズが上限を超えています。');
    }

    const chunks = [];
    let zipSize = 0;
    let writer;
    const output = new Promise((resolve, reject) => {
      writer = new zip.Zip((error, chunk, final) => {
        if (error) { reject(error); return; }
        zipSize += chunk.length;
        if (zipSize > MAX_ZIP_BYTES) { reject(new Error('ZIPファイルのサイズが上限を超えています。')); return; }
        chunks.push(chunk);
        if (final) resolve(new Blob(chunks, { type: 'application/zip' }));
      });
    });
    const add = (name, bytes) => {
      const entry = new zip.ZipPassThrough(name);
      writer.add(entry);
      entry.push(bytes, true);
    };
    for (const [name, bytes] of jsonFiles) add(name, bytes);
    for (let index = 0; index < imageEntries.length; index++) {
      const { image, path } = imageEntries[index];
      const bytes = new Uint8Array(await image.blob.arrayBuffer());
      if (bytes.length > MAX_ENTRY_BYTES) throw new Error('ZIP内の画像サイズが上限を超えています。');
      manifest.images[index].sha256 = await sha256(bytes);
      add(path, bytes);
    }
    add('manifest.json', encode(JSON.stringify(manifest)));
    writer.end();
    return output;
  }

  async function importArchive(file) {
    if (!packageTools) throw new Error('作品アーカイブ用モジュールが読み込まれていません。');
    if (!file || typeof file.arrayBuffer !== 'function' || (typeof file.size === 'number' && file.size > MAX_ZIP_BYTES)) {
      throw new Error('ZIPファイルを読み込めません。');
    }
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch { throw new Error('ZIPファイルを読み込めません。'); }
    const entries = preflightZip(bytes);
    const zip = await loadZipLibrary();
    let files;
    try { files = zip.unzipSync(bytes); }
    catch { throw new Error('ZIPを展開できません。'); }
    if (Object.keys(files).length !== entries.length || entries.some(entry => !files[entry.name] || files[entry.name].length !== entry.uncompressedSize)) {
      throw new Error('ZIP内のファイルが欠落しているか、サイズが一致しません。');
    }

    const manifest = parseJson(files, 'manifest.json');
    if (!isObject(manifest) || manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION ||
        typeof manifest.workId !== 'string' || !isObject(manifest.hashes) || !Array.isArray(manifest.images)) {
      throw new Error('対応していない作品ZIP形式です。');
    }
    const hashNames = Object.keys(manifest.hashes).sort();
    if (hashNames.length !== JSON_FILES.length || hashNames.some((name, index) => name !== [...JSON_FILES].sort()[index])) {
      throw new Error('作品JSONのチェックサム一覧が不正です。');
    }
    for (const name of JSON_FILES) {
      const expectedHash = manifest.hashes[name];
      if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) ||
          await sha256(files[name]) !== expectedHash) {
        throw new Error(`${name}のチェックサムが一致しません。`);
      }
    }

    const workRecord = parseJson(files, 'work.json');
    const manuscript = parseJson(files, 'manuscript.json');
    const plot = parseJson(files, 'plot.json');
    const characters = parseJson(files, 'characters.json');
    if (!isObject(workRecord) || !isObject(manuscript) || !Array.isArray(manuscript.episodes) ||
        !isObject(plot) || !Array.isArray(plot.chapters) || !Array.isArray(plot.scenes) ||
        !isObject(characters) || !Array.isArray(characters.characters)) {
      throw new Error('作品ZIP内のJSON構造が不正です。');
    }

    const archiveImages = [];
    const imageIds = new Set();
    for (let index = 0; index < manifest.images.length; index++) {
      const image = manifest.images[index];
      const extension = image && extensionFor(image.mimeType);
      const expectedPath = `images/${String(index + 1).padStart(4, '0')}.${extension || 'invalid'}`;
      if (!isObject(image) || typeof image.id !== 'string' || imageIds.has(image.id) || !extension ||
          image.path !== expectedPath || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) {
        throw new Error('ZIP内の画像一覧が不正です。');
      }
      imageIds.add(image.id);
      const imageBytes = files[image.path];
      if (!imageBytes || await sha256(imageBytes) !== image.sha256) throw new Error('画像ファイルのチェックサムが一致しません。');
      archiveImages.push({ id: image.id, mimeType: image.mimeType, blob: new Blob([imageBytes], { type: image.mimeType }) });
    }
    const expectedNames = new Set(['manifest.json', ...JSON_FILES, ...manifest.images.map(image => image.path)]);
    if (entries.some(entry => !expectedNames.has(entry.name)) || [...expectedNames].some(name => !files[name])) {
      throw new Error('ZIP内のファイル一覧がmanifestと一致しません。');
    }

    const value = await packageTools.validatePackage({
      work: {
        schemaVersion: workRecord.schemaVersion,
        id: workRecord.id,
        title: workRecord.title,
        summary: workRecord.summary,
        chapters: plot.chapters,
        episodes: manuscript.episodes,
        scenes: plot.scenes,
        characters: characters.characters,
        images: workRecord.images
      },
      images: archiveImages
    });
    if (value.work.id !== manifest.workId) throw new Error('作品IDがmanifestと一致しません。');
    return value;
  }

  const api = { exportArchive, importArchive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelArchive = api;
})(globalThis);
