(function (root) {
  'use strict';

  const MAX_ZIP_BYTES = 258 * 1024 * 1024;
  const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
  const MAX_ENTRIES = 10010;
  let zipPromise;

  function loadZipLibrary() {
    if (!zipPromise) {
      zipPromise = import('./vendor/fflate.mjs');
      zipPromise = zipPromise.catch(error => { zipPromise = undefined; throw error; });
    }
    return zipPromise;
  }

  const encodeText = text => new TextEncoder().encode(text);
  const decodeText = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function encodeJson(value) { return encodeText(JSON.stringify(value)); }

  function parseJson(files, name) {
    if (!files || !(files[name] instanceof Uint8Array)) throw new Error(`${name}がありません。`);
    try { return JSON.parse(decodeText(files[name])); }
    catch { throw new Error(`${name}を読み込めません。`); }
  }

  async function sha256(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('SHA-256対象はUint8Arrayである必要があります。');
    const cryptoApi = root.crypto || globalThis.crypto;
    if (!cryptoApi?.subtle) throw new Error('SHA-256検証を利用できません。');
    return hex(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes)));
  }

  function extensionFor(mimeType) {
    return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mimeType];
  }

  function preflightZip(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 22 || bytes.length > MAX_ZIP_BYTES) throw new Error('ZIPファイルのサイズが不正です。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = offset => view.getUint16(offset, true);
    const u32 = offset => view.getUint32(offset, true);
    let endOffset = -1;
    const earliest = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= earliest; offset--) {
      if (u32(offset) === 0x06054b50) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error('ZIPの終了レコードがありません。');
    const disk = u16(endOffset + 4), directoryDisk = u16(endOffset + 6);
    const diskEntries = u16(endOffset + 8), entryCount = u16(endOffset + 10);
    const directorySize = u32(endOffset + 12), directoryOffset = u32(endOffset + 16), commentLength = u16(endOffset + 20);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('複数ディスク・ZIP64・不正な中央ディレクトリには対応していません。');
    if (endOffset + 22 + commentLength !== bytes.length || disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount ||
        entryCount === 0 || entryCount > MAX_ENTRIES || directoryOffset + directorySize > endOffset) {
      throw new Error('複数ディスク・ZIP64・不正な中央ディレクトリには対応していません。');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const seenNames = new Set(), entries = [];
    let totalSize = 0, offset = directoryOffset;
    for (let index = 0; index < entryCount; index++) {
      if (offset + 46 > directoryOffset + directorySize || u32(offset) !== 0x02014b50) throw new Error('ZIPの中央ディレクトリが不正です。');
      const flags = u16(offset + 8), method = u16(offset + 10), compressedSize = u32(offset + 20), uncompressedSize = u32(offset + 24);
      const nameLength = u16(offset + 28), extraLength = u16(offset + 30), entryCommentLength = u16(offset + 32), entryDisk = u16(offset + 34), localOffset = u32(offset + 42);
      const nextOffset = offset + 46 + nameLength + extraLength + entryCommentLength;
      if (!nameLength || nextOffset > directoryOffset + directorySize || entryDisk !== 0 || (flags & 1) !== 0 ||
          (method !== 0 && method !== 8) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
          uncompressedSize > MAX_ENTRY_BYTES || localOffset + 30 > directoryOffset) {
        throw new Error('ZIP内のファイル情報が不正か、対応範囲を超えています。');
      }
      let name;
      try { name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)); }
      catch { throw new Error('ZIP内のファイル名が不正です。'); }
      if (!name || seenNames.has(name)) throw new Error('ZIP内に同じファイル名が複数あります。');
      seenNames.add(name);
      if (u32(localOffset) !== 0x04034b50) throw new Error('ZIP内のファイル本体がありません。');
      const localFlags = u16(localOffset + 6), localMethod = u16(localOffset + 8), localNameLength = u16(localOffset + 26), localExtraLength = u16(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      let localName;
      try { localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)); }
      catch { throw new Error('ZIP内のファイル名が不正です。'); }
      if (localName !== name || localFlags !== flags || localMethod !== method || dataOffset + compressedSize > directoryOffset) throw new Error('ZIP内の見出しとファイル本体が一致しません。');
      totalSize += uncompressedSize;
      if (totalSize > MAX_TOTAL_BYTES) throw new Error('展開後のZIPサイズが上限を超えています。');
      entries.push({ name, compressedSize, uncompressedSize, method });
      offset = nextOffset;
    }
    if (offset !== directoryOffset + directorySize) throw new Error('ZIPの中央ディレクトリ長が一致しません。');
    return entries;
  }

  async function readArchive(file) {
    if (!file || typeof file.arrayBuffer !== 'function' || (typeof file.size === 'number' && file.size > MAX_ZIP_BYTES)) throw new Error('ZIPファイルを読み込めません。');
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch { throw new Error('ZIPファイルを読み込めません。'); }
    const entries = preflightZip(bytes);
    const zip = await loadZipLibrary();
    let files;
    try { files = zip.unzipSync(bytes); }
    catch { throw new Error('ZIPを展開できません。'); }
    const names = Object.keys(files);
    if (names.length !== entries.length || entries.some(entry => !(files[entry.name] instanceof Uint8Array) || files[entry.name].length !== entry.uncompressedSize)) {
      throw new Error('ZIP内のファイルが欠落しているか、サイズが一致しません。');
    }
    const manifest = parseJson(files, 'manifest.json');
    if (!isObject(manifest)) throw new Error('manifest.jsonの構造が不正です。');
    return { bytes, entries, files, manifest };
  }

  function assertUncompressedBudget(items) {
    if (!Array.isArray(items)) throw new TypeError('ZIPサイズ見積りが不正です。');
    let total = 0;
    for (const item of items) {
      const size = item?.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('ZIPサイズ見積りが不正です。');
      if (size > MAX_ENTRY_BYTES) throw new Error(`${item.name || 'ZIPエントリ'}のサイズが上限を超えています。`);
      total += size;
      if (total > MAX_TOTAL_BYTES) throw new Error('ZIP展開後のデータサイズが上限を超えています。');
    }
    return total;
  }

  async function writeArchive(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES) throw new Error('ZIP内のファイル数が上限を超えています。');
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || !(entry.bytes instanceof Uint8Array)) throw new TypeError('ZIPエントリには名前とUint8Arrayが必要です。');
      if (seen.has(entry.name)) throw new Error('ZIPエントリ名が重複しています。');
      seen.add(entry.name);
    }
    assertUncompressedBudget(entries.map(entry => ({ name: entry.name, size: entry.bytes.length })));
    const zip = await loadZipLibrary();
    const chunks = [];
    let size = 0, writer;
    const output = new Promise((resolve, reject) => {
      writer = new zip.Zip((error, chunk, final) => {
        if (error) { reject(error); return; }
        size += chunk.length;
        if (size > MAX_ZIP_BYTES) { reject(new Error('ZIPファイルのサイズが上限を超えています。')); return; }
        chunks.push(chunk);
        if (final) resolve(new Blob(chunks, { type: 'application/zip' }));
      });
    });
    try {
      for (const { name, bytes } of entries) {
        const item = new zip.ZipPassThrough(name);
        writer.add(item);
        item.push(bytes, true);
      }
      writer.end();
    } catch (error) {
      throw new Error(`ZIPを書き出せませんでした：${error?.message || error}`);
    }
    return output;
  }

  const api = { MAX_ZIP_BYTES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, MAX_ENTRIES, readArchive, writeArchive, sha256, encodeJson, parseJson, extensionFor, preflightZip, assertUncompressedBudget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelArchiveCommon = api;
})(globalThis);
