/* Validates the shared work plus binary image payload contract. */
(function (root) {
  'use strict';

  const model = typeof module !== 'undefined' && module.exports ? require('./model') : root.NovelModel;
  const core = typeof module !== 'undefined' && module.exports ? require('./core') : root.NovelCore;
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let value = 0; value < table.length; value++) {
      let crc = value;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      table[value] = crc >>> 0;
    }
    return table;
  })();

  function crc32(bytes, start, end) {
    let crc = 0xffffffff;
    for (let index = start; index < end; index++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }

  function validPng(bytes) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 45 || signature.some((value, index) => bytes[index] !== value)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8, sawHeader = false, sawData = false, sawEnd = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset, false);
      const dataStart = offset + 8;
      const crcOffset = dataStart + length;
      if (crcOffset + 4 > bytes.length) return false;
      const type = String.fromCharCode(...bytes.subarray(offset + 4, dataStart));
      if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes, offset + 4, crcOffset) !== view.getUint32(crcOffset, false)) return false;
      if (!sawHeader) {
        if (type !== 'IHDR' || length !== 13) return false;
        const width = view.getUint32(dataStart, false), height = view.getUint32(dataStart + 4, false);
        const depth = bytes[dataStart + 8], color = bytes[dataStart + 9];
        const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!width || !height || !depths[color]?.includes(depth) || bytes[dataStart + 10] !== 0 ||
            bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] > 1) return false;
        sawHeader = true;
      } else if (type === 'IHDR') return false;
      if (type === 'IDAT') {
        if (sawEnd || length === 0) return false;
        sawData = true;
      }
      if (type === 'IEND') {
        if (length !== 0 || !sawData) return false;
        sawEnd = true;
        offset = crcOffset + 4;
        break;
      }
      offset = crcOffset + 4;
    }
    return sawHeader && sawData && sawEnd && offset === bytes.length;
  }

  function validGif(bytes) {
    if (bytes.length < 14 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38 ||
        (bytes[4] !== 0x37 && bytes[4] !== 0x39) || bytes[5] !== 0x61) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!view.getUint16(6, true) || !view.getUint16(8, true)) return false;
    let offset = 13, frames = 0;
    const screen = bytes[10];
    if (screen & 0x80) offset += 3 * (1 << ((screen & 7) + 1));
    const skipSubBlocks = () => {
      while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0) return true;
        offset += length;
        if (offset > bytes.length) return false;
      }
      return false;
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) return frames > 0 && offset === bytes.length;
      if (marker === 0x21) {
        if (offset >= bytes.length) return false;
        offset++;
        if (!skipSubBlocks()) return false;
      } else if (marker === 0x2c) {
        if (offset + 9 > bytes.length) return false;
        const width = view.getUint16(offset + 4, true), height = view.getUint16(offset + 6, true);
        const packed = bytes[offset + 8];
        if (!width || !height) return false;
        offset += 9;
        if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
        if (offset + 1 > bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false;
        offset++;
        if (!skipSubBlocks()) return false;
        frames++;
      } else return false;
      if (offset > bytes.length) return false;
    }
    return false;
  }

  function validJpeg(bytes) {
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
    let offset = 2, sawFrame = false, sawScan = false;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return false;
      const marker = bytes[offset++];
      if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
      if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      if (offset + 2 > bytes.length) return false;
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) return false;
      const segmentStart = offset + 2;
      const segmentEnd = offset + length;
      if ((marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (length < 8 || !view.getUint16(segmentStart + 1, false) || !view.getUint16(segmentStart + 3, false)) return false;
        sawFrame = true;
      }
      if (marker === 0xda) {
        if (!sawFrame || length < 6) return false;
        sawScan = true;
        offset = segmentEnd;
        let nextMarker = -1;
        while (offset < bytes.length) {
          if (bytes[offset++] !== 0xff) continue;
          const markerStart = offset - 1;
          while (offset < bytes.length && bytes[offset] === 0xff) offset++;
          if (offset >= bytes.length) return false;
          const scanMarker = bytes[offset];
          if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) { offset++; continue; }
          nextMarker = markerStart;
          break;
        }
        if (nextMarker < 0) return false;
        offset = nextMarker;
      } else offset = segmentEnd;
    }
    return false;
  }

  function validWebp(bytes) {
    if (bytes.length < 30 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46 ||
        bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.length) return false;
    let offset = 12, hasImage = false;
    while (offset + 8 <= bytes.length) {
      const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      const data = offset + 8;
      const next = data + length + (length & 1);
      if (next > bytes.length) return false;
      if (type === 'VP8 ' && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) hasImage = true;
      if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) hasImage = true;
      if (type === 'VP8X' && length === 10) hasImage = true;
      offset = next;
    }
    return hasImage && offset === bytes.length;
  }

  function validImageBytes(mimeType, bytes) {
    if (!(bytes instanceof Uint8Array)) return false;
    if (mimeType === 'image/png') return validPng(bytes);
    if (mimeType === 'image/jpeg') return validJpeg(bytes);
    if (mimeType === 'image/gif') return validGif(bytes);
    if (mimeType === 'image/webp') return validWebp(bytes);
    return false;
  }

  async function validateImageBlob(mimeType, blob) {
    if (typeof Blob === 'undefined' || !(blob instanceof Blob) || blob.size === 0 ||
        typeof mimeType !== 'string' || blob.type.toLowerCase() !== mimeType || !IMAGE_TYPES.has(mimeType)) {
      throw new Error('画像本体がBlobではないか、形式が一致しません。');
    }
    if (blob.size > core.MAX_IMAGE_BYTES) throw new Error('画像は1枚10MB以下にしてください。');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!validImageBytes(mimeType, bytes)) throw new Error('画像データが破損しているか、形式が一致しません。');
    if (typeof root.createImageBitmap === 'function') {
      let bitmap;
      try {
        bitmap = await root.createImageBitmap(blob);
        if (!bitmap.width || !bitmap.height) throw new Error('画像サイズが不正です。');
      } catch {
        throw new Error('画像データをデコードできません。');
      } finally {
        if (bitmap) bitmap.close();
      }
    }
    return true;
  }

  async function validatePackage(raw) {
    if (!model || !raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.images)) {
      throw new Error('作品パッケージが不正です。');
    }
    const work = model.validateWork(raw.work);
    const expected = new Map(work.images.map(image => [image.id, image]));
    if (raw.images.length !== expected.size) throw new Error('画像データの数が作品情報と一致しません。');
    const seen = new Set();
    const images = [];
    for (const image of raw.images) {
      if (!image || typeof image !== 'object' || Array.isArray(image) || typeof image.id !== 'string' || seen.has(image.id)) {
        throw new Error('画像データのIDが不正か重複しています。');
      }
      seen.add(image.id);
      const metadata = expected.get(image.id);
      if (!metadata || image.mimeType !== metadata.mimeType || !IMAGE_TYPES.has(image.mimeType)) {
        throw new Error('画像データが作品内の参照と一致しません。');
      }
      await validateImageBlob(image.mimeType, image.blob);
      images.push({ id: image.id, mimeType: image.mimeType, blob: image.blob });
    }
    if (seen.size !== expected.size) throw new Error('作品から参照されている画像本体がありません。');
    return { work, images };
  }

  const api = { validatePackage, validateImageBlob };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelPackage = api;
})(globalThis);
