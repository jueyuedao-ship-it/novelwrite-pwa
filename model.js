/*
 * Normalized, DOM-free schema for the integrated writing workspace.
 * A work contains chapter/episode/scene/character/image metadata; image bytes
 * are carried beside it as `{ id, mimeType, blob }` records.
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 4;
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const uid = (prefix = 'id') => `${prefix}-${globalThis.crypto.randomUUID()}`;
  const makeLine = () => ({ id: uid('line'), speaker: '', characterId: null, text: '' });

  function createWork(options = {}) {
    const id = options.id ?? uid('work');
    const chapterId = uid('chapter');
    const episodeId = uid('episode');
    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      title: options.title ?? '無題の作品',
      summary: options.summary ?? '',
      chapters: [{ id: chapterId, workId: id, title: '未分類の章', order: 0 }],
      episodes: [{ id: episodeId, workId: id, chapterId, title: '第1話', order: 0, lines: [makeLine()] }],
      scenes: [],
      characters: [],
      images: []
    };
  }

  function validateWork(raw) {
    const fail = message => { throw new Error(message); };
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const string = (value, label) => typeof value === 'string' ? value : fail(`${label}は文字列である必要があります。`);
    const id = (value, used) => {
      if (typeof value !== 'string' || value.length === 0) fail('空のIDまたは不正なIDがあります。');
      if (used.has(value)) fail('重複するIDがあります。');
      used.add(value);
      return value;
    };
    const order = value => {
      if (!Number.isSafeInteger(value) || value < 0) fail('並び順が不正です。');
      return value;
    };
    const list = (value, label) => Array.isArray(value) ? value : fail(`${label}一覧が不正です。`);
    if (!object(raw) || raw.schemaVersion !== SCHEMA_VERSION) fail(`対応していない作品形式です。schemaVersion: ${SCHEMA_VERSION} が必要です。`);

    const usedIds = new Set();
    const workId = id(raw.id, usedIds);
    const result = {
      schemaVersion: SCHEMA_VERSION,
      id: workId,
      title: string(raw.title, '作品名'),
      summary: string(raw.summary, '作品概要'),
      chapters: [],
      episodes: [],
      scenes: [],
      characters: [],
      images: []
    };

    result.chapters = list(raw.chapters, '章').map(chapter => {
      if (!object(chapter) || chapter.workId !== workId) fail('章の構造または作品参照が不正です。');
      return {
        id: id(chapter.id, usedIds), workId,
        title: string(chapter.title, '章タイトル'), order: order(chapter.order)
      };
    });
    const chaptersById = new Map(result.chapters.map(chapter => [chapter.id, chapter]));
    const chapterOrders = new Set();
    for (const chapter of result.chapters) {
      const key = `${chapter.workId}\u0000${chapter.order}`;
      if (chapterOrders.has(key)) fail('章の並び順が重複しています。');
      chapterOrders.add(key);
    }

    result.episodes = list(raw.episodes, '話').map(episode => {
      if (!object(episode) || episode.workId !== workId || !chaptersById.has(episode.chapterId)) fail('話の構造または章参照が不正です。');
      const lines = list(episode.lines, '本文行');
      if (!lines.length) fail('話には少なくとも1行の本文が必要です。');
      return {
        id: id(episode.id, usedIds), workId, chapterId: episode.chapterId,
        title: string(episode.title, '話タイトル'), order: order(episode.order),
        lines: lines.map(line => {
          if (!object(line)) fail('本文行が不正です。');
          const lineId = id(line.id, usedIds);
          const speaker = string(line.speaker, '人物名');
          const text = string(line.text, '本文');
          if (/[\r\n]/.test(text)) fail('行の本文に改行が含まれています。改行は行を分けて保存してください。');
          if (line.characterId !== null && typeof line.characterId !== 'string') fail('本文の人物参照が不正です。');
          return { id: lineId, speaker, characterId: line.characterId, text };
        })
      };
    });
    if (!result.episodes.length) fail('作品には少なくとも1話が必要です。');
    const episodesById = new Map(result.episodes.map(episode => [episode.id, episode]));
    const episodeOrders = new Set();
    for (const episode of result.episodes) {
      const key = `${episode.chapterId}\u0000${episode.order}`;
      if (episodeOrders.has(key)) fail('話の並び順が重複しています。');
      episodeOrders.add(key);
    }
    const linesById = new Map();
    for (const episode of result.episodes) {
      episode.lines.forEach((line, index) => linesById.set(line.id, { episode, index }));
    }

    result.characters = list(raw.characters, '人物').map(character => {
      if (!object(character) || character.workId !== workId) fail('人物の構造または作品参照が不正です。');
      const customFields = list(character.customFields, '人物の自由項目').map(field => {
        if (!object(field)) fail('人物の自由項目が不正です。');
        return { id: id(field.id, usedIds), label: string(field.label, '項目名'), value: string(field.value, '項目内容') };
      });
      return {
        id: id(character.id, usedIds), workId,
        name: string(character.name, '人物名'), role: string(character.role, '役割'),
        description: string(character.description, '人物説明'), appearance: string(character.appearance, '外見'),
        personality: string(character.personality, '性格'), goal: string(character.goal, '目的'),
        background: string(character.background, '背景'), relationshipNotes: string(character.relationshipNotes, '関係メモ'),
        customFields,
        imageIds: list(character.imageIds, '人物画像').map(imageId => string(imageId, '画像ID'))
      };
    });
    const charactersById = new Map(result.characters.map(character => [character.id, character]));
    for (const episode of result.episodes) {
      for (const line of episode.lines) {
        if (line.characterId !== null && !charactersById.has(line.characterId)) fail('本文の人物参照が存在しません。');
      }
    }

    result.scenes = list(raw.scenes, 'シーン').map(scene => {
      if (!object(scene) || scene.workId !== workId) fail('シーンの構造または作品参照が不正です。');
      const chapterId = scene.chapterId === null ? null : string(scene.chapterId, '章ID');
      const episodeId = scene.episodeId === null ? null : string(scene.episodeId, '話ID');
      if (chapterId !== null && !chaptersById.has(chapterId)) fail('シーンの章参照が存在しません。');
      const episode = episodeId === null ? null : episodesById.get(episodeId);
      if (episodeId !== null && (!episode || episode.chapterId !== chapterId)) fail('シーンの話参照が存在しないか、章と一致しません。');
      const startLineId = scene.startLineId === null ? null : string(scene.startLineId, '開始行ID');
      const endLineId = scene.endLineId === null ? null : string(scene.endLineId, '終了行ID');
      if ((startLineId === null) !== (endLineId === null)) fail('シーンの本文範囲は両端を指定するか、両方を未設定にしてください。');
      if (startLineId !== null) {
        if (!episode) fail('未割当シーンに本文範囲は指定できません。');
        const start = linesById.get(startLineId), end = linesById.get(endLineId);
        if (!start || !end || start.episode.id !== episode.id || end.episode.id !== episode.id || start.index > end.index) fail('シーンの対象範囲が存在しないか、逆順です。');
      }
      const characterIds = list(scene.characterIds, 'シーン登場人物').map(characterId => string(characterId, '人物ID'));
      if (new Set(characterIds).size !== characterIds.length || characterIds.some(characterId => !charactersById.has(characterId))) fail('シーンの人物参照が不正です。');
      return {
        id: id(scene.id, usedIds), workId, chapterId, episodeId, order: order(scene.order),
        startLineId, endLineId,
        summary: string(scene.summary, 'シーン要約'), purpose: string(scene.purpose, 'シーンの目的'), characterIds,
        viewpoint: string(scene.viewpoint, '視点'), location: string(scene.location, '場所'), time: string(scene.time, '時間'),
        notes: string(scene.notes, 'シーンメモ'),
        imageIds: list(scene.imageIds, 'シーン画像').map(imageId => string(imageId, '画像ID')),
        nextImageNumber: scene.nextImageNumber
      };
    });
    const scenesById = new Map(result.scenes.map(scene => [scene.id, scene]));
    const sceneOrders = new Set();
    for (const scene of result.scenes) {
      const scope = scene.episodeId !== null ? `episode:${scene.episodeId}` : scene.chapterId !== null ? `chapter:${scene.chapterId}` : 'unassigned';
      const key = `${scope}\u0000${scene.order}`;
      if (sceneOrders.has(key)) fail('シーンの並び順が重複しています。');
      sceneOrders.add(key);
    }

    result.images = list(raw.images, '画像').map(image => {
      if (!object(image) || image.workId !== workId) fail('画像の構造または作品参照が不正です。');
      if (!['scene', 'character'].includes(image.ownerType)) fail('画像の所有者種別が不正です。');
      if (typeof image.ownerId !== 'string' || image.ownerId.length === 0) fail('画像の所有者IDが不正です。');
      if (!IMAGE_TYPES.has(image.mimeType)) fail('画像形式が不正です。');
      const referenceNumber = image.referenceNumber;
      if (image.ownerType === 'scene') {
        if (!Number.isSafeInteger(referenceNumber) || referenceNumber < 1) fail('シーン画像番号が不正です。');
      } else if (referenceNumber !== null) fail('人物画像にシーン画像番号は設定できません。');
      return {
        id: id(image.id, usedIds), workId, ownerType: image.ownerType, ownerId: image.ownerId,
        order: order(image.order), name: string(image.name, '画像名'), mimeType: string(image.mimeType, '画像形式'),
        referenceNumber
      };
    });

    const imagesById = new Map(result.images.map(image => [image.id, image]));
    const imageNumbersByScene = new Map();
    for (const image of result.images) {
      const owner = image.ownerType === 'scene' ? scenesById.get(image.ownerId) : charactersById.get(image.ownerId);
      if (!owner) fail('画像の所有者参照が存在しません。');
      const key = `${image.ownerType}\u0000${image.ownerId}`;
      if (!imageNumbersByScene.has(key)) imageNumbersByScene.set(key, new Set());
      if (image.ownerType === 'scene') {
        const numbers = imageNumbersByScene.get(key);
        if (numbers.has(image.referenceNumber)) fail('シーン内の画像番号が重複しています。');
        numbers.add(image.referenceNumber);
      }
    }
    const checkImageIds = (owner, ownerType) => {
      if (new Set(owner.imageIds).size !== owner.imageIds.length) fail('画像IDが重複しています。');
      owner.imageIds.forEach((imageId, index) => {
        const image = imagesById.get(imageId);
        if (!image || image.ownerType !== ownerType || image.ownerId !== owner.id || image.order !== index) fail('画像参照が存在しないか、所有者・並び順と一致しません。');
      });
    };
    for (const character of result.characters) checkImageIds(character, 'character');
    for (const scene of result.scenes) {
      checkImageIds(scene, 'scene');
      const highest = scene.imageIds.reduce((max, imageId) => Math.max(max, imagesById.get(imageId).referenceNumber), 0);
      if (!Number.isSafeInteger(scene.nextImageNumber) || scene.nextImageNumber <= highest) fail('シーンの次の画像番号が不正です。');
    }
    if (result.images.some(image => {
      const owner = image.ownerType === 'scene' ? scenesById.get(image.ownerId) : charactersById.get(image.ownerId);
      return !owner.imageIds.includes(image.id);
    })) fail('どの人物・シーンからも参照されていない画像があります。');

    return result;
  }

  const api = { SCHEMA_VERSION, createWork, validateWork };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelModel = api;
})(globalThis);
