const test = require('node:test');
const assert = require('node:assert/strict');
const common = require('../archive-common.js');

function set16(bytes, offset, value) { bytes[offset] = value & 255; bytes[offset + 1] = value >>> 8 & 255; }
function set32(bytes, offset, value) { set16(bytes, offset, value & 65535); set16(bytes, offset + 2, value >>> 16); }
function makeZip(entries, options = {}) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let localOffset = 0;
  for (const spec of entries) {
    const nameBytes = spec.nameBytes || enc.encode(spec.name);
    const data = spec.data || new Uint8Array();
    const flags = spec.flags || 0;
    const method = spec.method ?? 0;
    const compressedSize = spec.compressedSize ?? data.length;
    const uncompressedSize = spec.uncompressedSize ?? data.length;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    set32(local, 0, 0x04034b50); set16(local, 4, 20); set16(local, 6, flags); set16(local, 8, method);
    set32(local, 18, compressedSize); set32(local, 22, uncompressedSize); set16(local, 26, nameBytes.length); local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    locals.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    set32(central, 0, 0x02014b50); set16(central, 4, 20); set16(central, 6, 20); set16(central, 8, flags); set16(central, 10, method);
    set32(central, 20, compressedSize); set32(central, 24, uncompressedSize); set16(central, 28, nameBytes.length); set32(central, 42, localOffset); central.set(nameBytes, 46);
    centrals.push(central); localOffset += local.length;
  }
  const cdirLength = centrals.reduce((n, item) => n + item.length, 0);
  const eocd = new Uint8Array(22);
  set32(eocd, 0, options.badEocd ? 0xdeadbeef : 0x06054b50);
  set16(eocd, 8, entries.length); set16(eocd, 10, options.zip64Count ? 0xffff : entries.length);
  set32(eocd, 12, options.zip64Directory ? 0xffffffff : cdirLength); set32(eocd, 16, localOffset);
  const total = [...locals, ...centrals, eocd];
  const out = new Uint8Array(total.reduce((n, item) => n + item.length, 0)); let offset = 0;
  for (const item of total) { out.set(item, offset); offset += item.length; }
  return out;
}
const asFile = bytes => new Blob([bytes], { type: 'application/zip' });

async function rejects(bytes, pattern) {
  await assert.rejects(() => common.readArchive(asFile(bytes)), pattern);
}

test('writeArchive and readArchive round-trip manifest bytes', async () => {
  const blob = await common.writeArchive([{ name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify({ format: 'x' })) }]);
  const read = await common.readArchive(blob);
  assert.equal(read.manifest.format, 'x');
  assert.deepEqual(Object.keys(read.files), ['manifest.json']);
  assert.equal(read.entries.length, 1);
});

test('preflight rejects malformed EOCD and duplicate names', async () => {
  await rejects(makeZip([{ name: 'manifest.json' }], { badEocd: true }), /終了レコード/);
  await rejects(makeZip([{ name: 'manifest.json' }, { name: 'manifest.json' }]), /同じファイル名/);
});

test('preflight rejects encrypted and unsupported compression entries', async () => {
  await rejects(makeZip([{ name: 'manifest.json', flags: 1 }]), /対応範囲/);
  await rejects(makeZip([{ name: 'manifest.json', method: 99 }]), /対応範囲/);
});

test('preflight rejects ZIP64 sentinels and oversized expanded entries', async () => {
  await rejects(makeZip([{ name: 'manifest.json' }], { zip64Count: true }), /ZIP64/);
  await rejects(makeZip([{ name: 'manifest.json' }], { zip64Directory: true }), /ZIP64/);
  await rejects(makeZip([{ name: 'manifest.json', uncompressedSize: common.MAX_ENTRY_BYTES + 1 }]), /対応範囲/);
});

test('preflight rejects expanded total over limit without inflating', async () => {
  const each = common.MAX_ENTRY_BYTES;
  await rejects(makeZip([
    { name: 'a', uncompressedSize: each },
    { name: 'b', uncompressedSize: each },
    { name: 'c', uncompressedSize: each },
    { name: 'd', uncompressedSize: each },
    { name: 'manifest.json', uncompressedSize: each }
  ]), /展開後/);
});

test('preflight rejects invalid UTF-8 names', async () => {
  await rejects(makeZip([{ nameBytes: Uint8Array.of(0xc3, 0x28) }]), /ファイル名/);
});

test('writeArchive rejects duplicate names and oversized entries', async () => {
  const bytes = new Uint8Array();
  await assert.rejects(() => common.writeArchive([{ name: 'a', bytes }, { name: 'a', bytes }]), /重複/);
  const tooBig = { byteLength: common.MAX_ENTRY_BYTES + 1 };
  await assert.rejects(() => common.writeArchive([{ name: 'a', bytes: tooBig }]), /Uint8Array|サイズ/);
});
