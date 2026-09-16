/* Shared by the standalone browser document and Node tests. No DOM dependency. */
(function (root) {
  'use strict';
  const uid = (prefix = 'id') => `${prefix}-${globalThis.crypto.randomUUID()}`;
  const line = (text = '', speaker = '') => ({ id: uid('line'), speaker, text });
  const chapter = (title = '第1話') => ({ id: uid('chapter'), title, lines: [line()], scenes: [] });
  const work = () => ({ schemaVersion: 3, id: uid('work'), title: '無題の作品', characters: [], chapters: [chapter()] });
  const character = () => ({ id: uid('character'), name: '', description: '', images: [] });
  function appendSceneImages(scene, images) {
    const next = scene.nextImageNumber;
    if (!Number.isSafeInteger(next) || next < 1 || !Number.isSafeInteger(next + images.length)) throw new Error('画像番号の上限に達しました。');
    return { ...scene, images: [...scene.images, ...images.map((img, i) => ({ ...img, referenceNumber: next + i }))], nextImageNumber: next + images.length };
  }
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  function validateImageData(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) throw new Error('画像は1枚10MB以下にしてください。');
    const comma = dataUrl.indexOf(','), header = dataUrl.slice(0, comma);
    const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const mime = types.find(type => header === `data:${type};base64`);
    if (!mime) throw new Error('画像はPNG・JPEG・WebP・GIFの埋め込みデータが必要です。');
    const base64 = dataUrl.slice(comma + 1);
    if (!base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('画像データが不正です。');
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    if (base64.length / 4 * 3 - padding > MAX_IMAGE_BYTES) throw new Error('画像は1枚10MB以下にしてください。');
    const bytes = atob(base64.slice(0, 32));
    const valid = mime === 'image/png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
      : mime === 'image/jpeg' ? bytes.startsWith('\xff\xd8\xff')
      : mime === 'image/gif' ? /^(GIF87a|GIF89a)/.test(bytes)
      : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
    if (!valid) throw new Error('画像の形式とデータが一致しません。');
    return mime;
  }
  const fullText = ch => ch.lines.map(l => l.text).join('\n');
  const normalize = text => text.replace(/\r\n?/g, '\n');
  function offsets(ch) {
    let cursor = 0;
    return ch.lines.map(l => { const start = cursor; cursor += l.text.length + 1; return start; });
  }
  function locate(ch, position) {
    const starts = offsets(ch);
    for (let i = 0; i < ch.lines.length; i++) {
      if (position <= starts[i] + ch.lines[i].text.length) return { index: i, column: position - starts[i] };
    }
    const index = ch.lines.length - 1;
    return { index, column: ch.lines[index].text.length };
  }
  // Prefer the actual pre-input selection. This disambiguates repeated strings/newlines.
  function difference(oldText, newText, selection) {
    if (oldText === newText) return null;
    if (selection) {
      let { start, end, inputType = '' } = selection;
      if (start === end && inputType === 'deleteContentBackward') {
        const p = oldText.codePointAt(start - 2);
        start = Math.max(0, start - (p > 0xffff ? 2 : 1));
      } else if (start === end && inputType === 'deleteContentForward') {
        end = Math.min(oldText.length, end + (oldText.codePointAt(end) > 0xffff ? 2 : 1));
      }
      const prefix = oldText.slice(0, start), suffix = oldText.slice(end);
      if (newText.length >= prefix.length + suffix.length && newText.startsWith(prefix) && newText.endsWith(suffix)) {
        return { start, end, insert: newText.slice(start, newText.length - suffix.length) };
      }
    }
    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
    let end = oldText.length, newEnd = newText.length;
    while (end > start && newEnd > start && oldText[end - 1] === newText[newEnd - 1]) { end--; newEnd--; }
    return { start, end, insert: newText.slice(start, newEnd) };
  }
  function remapScenes(ch, lines, mapping) {
    const oldIndexes = new Map(ch.lines.map((l, i) => [l.id, i]));
    const newIndexes = new Map(lines.map((l, i) => [l.id, i]));
    return ch.scenes.map(scene => {
      if (scene.startLineId === null) return scene;
      const start = oldIndexes.get(scene.startLineId), end = oldIndexes.get(scene.endLineId);
      const survivors = ch.lines.slice(start, end + 1).flatMap(l => mapping.get(l.id) || [l.id]).filter(id => newIndexes.has(id));
      survivors.sort((a, b) => newIndexes.get(a) - newIndexes.get(b));
      return { ...scene, startLineId: survivors[0] ?? null, endLineId: survivors.at(-1) ?? null };
    });
  }
  function replaceText(ch, start, end, rawInsert, chosenSpeaker) {
    const text = fullText(ch), insert = normalize(rawInsert);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) throw new Error('編集範囲が不正です。');
    if (text.slice(start, end) === insert) return { chapter: ch, caret: start + insert.length };
    const a = locate(ch, start), b = locate(ch, end);
    const first = ch.lines[a.index], last = ch.lines[b.index];
    // A normal single-line edit keeps its metadata even when all characters are replaced.
    // Replacing an entire multi-line manuscript has no reliable scene correspondence.
    const wholesale = ch.lines.length > 1 && start === 0 && end === text.length && /[^\n]/.test(text);
    const same = a.index === b.index;
    const prefix = first.text.slice(0, a.column), suffix = last.text.slice(b.column);
    const pieces = (prefix + insert + suffix).split('\n');
    const keepLeft = !wholesale && (same || a.column > 0 || (first.text.length === 0 && a.column === 0));
    const keepRight = !wholesale && !same && (b.column < last.text.length || b.column === 0);
    const merged = pieces.length === 1 && keepLeft && keepRight;
    const speakers = [...new Set([...(keepLeft ? [first.speaker] : []), ...(keepRight ? [last.speaker] : [])])];
    if (merged && speakers.length > 1 && chosenSpeaker === undefined) return { conflict: speakers };
    const replacement = pieces.map(t => line(t, keepLeft ? first.speaker : keepRight ? last.speaker : ''));
    if (keepLeft) replacement[0].id = first.id;
    if (keepRight) {
      if (!keepLeft || replacement.length > 1) replacement.at(-1).id = last.id;
      replacement.at(-1).speaker = last.speaker;
    }
    if (merged) replacement[0].speaker = chosenSpeaker === undefined ? speakers[0] : chosenSpeaker;
    const mapping = new Map(ch.lines.slice(a.index, b.index + 1).map(l => [l.id, []]));
    if (same && keepLeft) mapping.set(first.id, replacement.map(l => l.id));
    else {
      if (keepLeft) mapping.set(first.id, [replacement[0].id]);
      if (keepRight) mapping.set(last.id, [replacement.at(-1).id]);
    }
    const lines = [...ch.lines.slice(0, a.index), ...replacement, ...ch.lines.slice(b.index + 1)];
    return { chapter: { ...ch, lines, scenes: remapScenes(ch, lines, mapping) }, caret: start + insert.length };
  }
  function removeLines(ch, ids) {
    const set = new Set(ids), mapping = new Map([...set].map(id => [id, []]));
    let lines = ch.lines.filter(l => !set.has(l.id));
    if (!lines.length) lines = [line()];
    return { ...ch, lines, scenes: remapScenes(ch, lines, mapping) };
  }
  function validateWork(raw) {
    const fail = message => { throw new Error(message); };
    const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
    const string = (x, label) => typeof x === 'string' ? x : fail(`${label}は文字列である必要があります。`);
    if (!object(raw) || ![1, 2, 3].includes(raw.schemaVersion)) fail('対応していないJSON形式です。schemaVersion: 1〜3 が必要です。');
    const used = new Set();
    const id = x => { string(x, 'ID'); if (!x || used.has(x)) fail('空のIDまたは重複するIDがあります。'); used.add(x); return x; };
    const images = (rawImages, numbered = false) => {
      const list = rawImages === undefined && raw.schemaVersion === 1 ? [] : rawImages;
      if (!Array.isArray(list)) fail('画像一覧が不正です。');
      const numbers = new Set();
      return list.map((img, index) => {
        if (!object(img)) fail('画像が不正です。');
        validateImageData(img.dataUrl);
        const result = { id: id(img.id), name: string(img.name, '画像名'), dataUrl: img.dataUrl };
        if (numbered) {
          const number = raw.schemaVersion < 3 ? index + 1 : img.referenceNumber;
          if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number)) fail('シーンの画像番号が不正、または重複しています。');
          numbers.add(number); result.referenceNumber = number;
        }
        return result;
      });
    };
    const result = { schemaVersion: 3, id: id(raw.id), title: string(raw.title, '作品名'), characters: [], chapters: [] };
    const characters = raw.characters === undefined && raw.schemaVersion === 1 ? [] : raw.characters;
    if (!Array.isArray(characters)) fail('キャラクター一覧が不正です。');
    result.characters = characters.map(c => {
      if (!object(c)) fail('キャラクターが不正です。');
      return { id: id(c.id), name: string(c.name, 'キャラクター名'), description: string(c.description, 'キャラクター説明'), images: images(c.images) };
    });
    if (!Array.isArray(raw.chapters) || !raw.chapters.length) fail('少なくとも1話が必要です。');
    result.chapters = raw.chapters.map(c => {
      if (!object(c) || !Array.isArray(c.lines) || !c.lines.length || !Array.isArray(c.scenes)) fail('話・本文行・シーンの構造が不正です。');
      const cleaned = { id: id(c.id), title: string(c.title, '話タイトル'), lines: [], scenes: [] };
      cleaned.lines = c.lines.map(l => {
        if (!object(l)) fail('本文行が不正です。');
        const text = string(l.text, '本文');
        if (/[\r\n]/.test(text)) fail('行の本文に改行が含まれています。改行は行を分けて保存してください。');
        return { id: id(l.id), speaker: string(l.speaker, '人物名'), text };
      });
      const indexes = new Map(cleaned.lines.map((l, i) => [l.id, i]));
      cleaned.scenes = c.scenes.map(s => {
        if (!object(s)) fail('シーンが不正です。');
        const cleanedScene = { id: id(s.id), startLineId: s.startLineId, endLineId: s.endLineId, description: string(s.description, 'シーン説明'), images: images(s.images, true) };
        const highestNumber = cleanedScene.images.reduce((max, img) => Math.max(max, img.referenceNumber), 0);
        const next = raw.schemaVersion < 3 ? highestNumber + 1 : s.nextImageNumber;
        if (!Number.isSafeInteger(next) || next <= highestNumber) fail('シーンの次の画像番号が不正です。');
        cleanedScene.nextImageNumber = next;
        if (s.startLineId === null && s.endLineId === null) return cleanedScene;
        if (!indexes.has(s.startLineId) || !indexes.has(s.endLineId) || indexes.get(s.startLineId) > indexes.get(s.endLineId)) fail('シーンの対象範囲が存在しないか、逆順です。');
        return cleanedScene;
      });
      return cleaned;
    });
    return result;
  }
  class History {
    constructor(initial) { this.present = initial; this.past = []; this.future = []; this.key = null; this.time = 0; }
    push(next, key = null, now = Date.now()) {
      if (next === this.present) return false;
      if (!key || key !== this.key || now - this.time > 700 || this.future.length) {
        this.past.push(this.present); if (this.past.length > 100) this.past.shift();
      }
      this.present = next; this.key = key; this.time = now; this.future = []; return true;
    }
    boundary() { this.key = null; }
    undo() { if (!this.past.length) return this.present; this.future.push(this.present); this.present = this.past.pop(); this.boundary(); return this.present; }
    redo() { if (!this.future.length) return this.present; this.past.push(this.present); this.present = this.future.pop(); this.boundary(); return this.present; }
  }
  const api = { uid, line, chapter, work, character, appendSceneImages, MAX_IMAGE_BYTES, validateImageData, fullText, normalize, offsets, locate, difference, replaceText, removeLines, validateWork, History };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelCore = api;
})(globalThis);
