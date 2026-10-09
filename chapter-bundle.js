(function (root) {
  'use strict';

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => structuredClone(value);
  const orderCompare = (left, right) => (left.order ?? 0) - (right.order ?? 0) || String(left.id).localeCompare(String(right.id));
  const sceneCompare = (left, right) => {
    const scope = scene => scene.episodeId !== null ? `episode:${scene.episodeId}` : `chapter:${scene.chapterId}`;
    return scope(left).localeCompare(scope(right)) || orderCompare(left, right);
  };
  const stripBlob = image => {
    const { blob, ...metadata } = image;
    return metadata;
  };

  function requireArray(value, label) {
    if (!Array.isArray(value)) throw new Error(`${label}一覧が不正です。`);
    return value;
  }

  function requireString(value, label) {
    if (typeof value !== 'string' || !value) throw new Error(`${label}が不正です。`);
    return value;
  }

  function collectPayloads(rawPackage) {
    const payloads = new Map();
    for (const image of requireArray(rawPackage.images, '画像本体')) {
      if (!isObject(image) || typeof image.id !== 'string' || typeof image.mimeType !== 'string' || !image.blob || typeof image.blob.arrayBuffer !== 'function') {
        throw new Error('画像本体が不正です。');
      }
      if (payloads.has(image.id)) throw new Error('画像本体IDが重複しています。');
      payloads.set(image.id, image);
    }
    return payloads;
  }

  async function buildChapterBundle(rawPackage, chapterId) {
    if (!isObject(rawPackage) || !isObject(rawPackage.work)) throw new Error('作品パッケージが不正です。');
    const work = rawPackage.work;
    const chapter = requireArray(work.chapters, '章').find(item => item.id === chapterId);
    if (!chapter) throw new Error('保存する章が見つかりません。');
    const episodes = requireArray(work.episodes, '話').filter(item => item.chapterId === chapterId).sort(orderCompare);
    if (!episodes.length) throw new Error('話がない章は章ZIPとして保存できません。');
    const episodeIds = new Set(episodes.map(item => item.id));
    const scenes = requireArray(work.scenes, 'シーン')
      .filter(scene => scene.chapterId === chapterId && (scene.episodeId === null || episodeIds.has(scene.episodeId)))
      .sort(sceneCompare);

    const characterIds = new Set();
    for (const episode of episodes) for (const line of requireArray(episode.lines, '本文行')) if (line.characterId !== null) characterIds.add(line.characterId);
    for (const scene of scenes) for (const id of requireArray(scene.characterIds, 'シーン登場人物')) characterIds.add(id);
    const charactersById = new Map(requireArray(work.characters, '人物').map(character => [character.id, character]));
    const characters = [...characterIds].map(id => charactersById.get(id)).filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const sceneImageIds = new Set(scenes.flatMap(scene => requireArray(scene.imageIds, 'シーン画像')));
    const characterImageIds = new Set(characters.flatMap(character => requireArray(character.imageIds, '人物画像')));
    const neededImageIds = new Set([...sceneImageIds, ...characterImageIds]);
    const metadataById = new Map(requireArray(work.images, '画像').map(image => [image.id, image]));
    const payloadById = collectPayloads(rawPackage);
    const images = [...neededImageIds].map(id => {
      const metadata = metadataById.get(id);
      const payload = payloadById.get(id);
      if (!metadata || !payload) throw new Error(`参照画像 ${id} のメタデータまたは本体がありません。`);
      return { ...copy(metadata), blob: payload.blob };
    }).sort((a, b) => a.ownerType.localeCompare(b.ownerType) || a.ownerId.localeCompare(b.ownerId) || orderCompare(a, b));

    const catalog = requireArray(work.chapters, '章').slice().sort(orderCompare).map(item => {
      const chapterEpisodes = requireArray(work.episodes, '話').filter(episode => episode.chapterId === item.id);
      return {
        id: item.id,
        title: item.title,
        order: item.order,
        episodeCount: chapterEpisodes.length,
        textLength: chapterEpisodes.reduce((total, episode) => total + requireArray(episode.lines, '本文行').reduce((sum, line) => sum + (typeof line.text === 'string' ? line.text.length : 0), 0), 0)
      };
    });

    const bundle = {
      sourceWork: { schemaVersion: work.schemaVersion, id: work.id, title: work.title, summary: work.summary },
      catalog,
      chapter: copy(chapter),
      episodes: copy(episodes),
      scenes: copy(scenes),
      characters: copy(characters),
      images
    };
    return validateChapterBundle(bundle);
  }

  function validateChapterBundle(rawBundle) {
    if (!isObject(rawBundle) || !isObject(rawBundle.sourceWork)) throw new Error('章バンドルが不正です。');
    const sourceWork = rawBundle.sourceWork;
    if (sourceWork.schemaVersion !== 4) throw new Error('対応していない章バンドルのschemaVersionです。');
    const workId = requireString(sourceWork.id, '元作品ID');
    if (typeof sourceWork.title !== 'string' || typeof sourceWork.summary !== 'string') throw new Error('元作品情報が不正です。');
    const chapter = rawBundle.chapter;
    if (!isObject(chapter) || chapter.workId !== workId) throw new Error('章の作品参照が不正です。');
    requireString(chapter.id, '章ID');
    if (typeof chapter.title !== 'string' || !Number.isSafeInteger(chapter.order) || chapter.order < 0) throw new Error('章が不正です。');

    const catalog = requireArray(rawBundle.catalog, '章カタログ');
    const catalogIds = new Set();
    for (const item of catalog) {
      if (!isObject(item) || catalogIds.has(item.id) || typeof item.id !== 'string' || typeof item.title !== 'string' ||
          !Number.isSafeInteger(item.order) || item.order < 0 || !Number.isSafeInteger(item.episodeCount) || item.episodeCount < 0 ||
          !Number.isSafeInteger(item.textLength) || item.textLength < 0) throw new Error('章カタログが不正です。');
      catalogIds.add(item.id);
    }
    if (!catalogIds.has(chapter.id)) throw new Error('章カタログに対象章がありません。');

    const usedIds = new Set([workId]);
    const register = (id, label) => {
      requireString(id, `${label}ID`);
      if (usedIds.has(id)) throw new Error(`IDが重複しています: ${id}`);
      usedIds.add(id);
    };
    register(chapter.id, '章');

    const episodes = requireArray(rawBundle.episodes, '話');
    if (!episodes.length) throw new Error('章ワークパックには少なくとも1話が必要です。');
    const episodeIds = new Set();
    const lineIds = new Set();
    const referencedCharacters = new Set();
    for (const episode of episodes) {
      if (!isObject(episode) || episode.workId !== workId || episode.chapterId !== chapter.id || typeof episode.title !== 'string' ||
          !Number.isSafeInteger(episode.order) || episode.order < 0) throw new Error('話の章参照または構造が不正です。');
      register(episode.id, '話'); episodeIds.add(episode.id);
      const lines = requireArray(episode.lines, '本文行');
      if (!lines.length) throw new Error('話には少なくとも1行必要です。');
      for (const line of lines) {
        if (!isObject(line) || typeof line.speaker !== 'string' || typeof line.text !== 'string' || /[\r\n]/.test(line.text) ||
            (line.characterId !== null && typeof line.characterId !== 'string')) throw new Error('本文行が不正です。');
        register(line.id, '本文行'); lineIds.add(line.id);
        if (line.characterId !== null) referencedCharacters.add(line.characterId);
      }
    }

    const characters = requireArray(rawBundle.characters, '人物');
    const charactersById = new Map();
    for (const character of characters) {
      if (!isObject(character) || character.workId !== workId || !Array.isArray(character.customFields) || !Array.isArray(character.imageIds)) throw new Error('人物が不正です。');
      register(character.id, '人物'); charactersById.set(character.id, character);
      for (const field of character.customFields) {
        if (!isObject(field) || typeof field.label !== 'string' || typeof field.value !== 'string') throw new Error('人物の自由項目が不正です。');
        register(field.id, '人物自由項目');
      }
    }

    const scenes = requireArray(rawBundle.scenes, 'シーン');
    const scenesById = new Map();
    for (const scene of scenes) {
      if (!isObject(scene) || scene.workId !== workId || scene.chapterId !== chapter.id ||
          (scene.episodeId !== null && !episodeIds.has(scene.episodeId)) || !Array.isArray(scene.characterIds) || !Array.isArray(scene.imageIds)) {
        throw new Error('シーンの章・話参照または構造が不正です。');
      }
      if ((scene.startLineId === null) !== (scene.endLineId === null)) throw new Error('シーン本文範囲が不正です。');
      if (scene.startLineId !== null && (!lineIds.has(scene.startLineId) || !lineIds.has(scene.endLineId) || scene.episodeId === null)) throw new Error('シーン本文参照が不正です。');
      register(scene.id, 'シーン'); scenesById.set(scene.id, scene);
      for (const id of scene.characterIds) referencedCharacters.add(id);
    }
    for (const id of referencedCharacters) if (!charactersById.has(id)) throw new Error(`参照人物 ${id} が章バンドルにありません。`);
    for (const character of characters) if (!referencedCharacters.has(character.id)) throw new Error('未参照の人物が章バンドルに含まれています。');

    const images = requireArray(rawBundle.images, '画像');
    const imagesById = new Map();
    for (const image of images) {
      if (!isObject(image) || image.workId !== workId || !['scene', 'character'].includes(image.ownerType) ||
          typeof image.ownerId !== 'string' || !IMAGE_TYPES.has(image.mimeType) || !image.blob || typeof image.blob.arrayBuffer !== 'function') {
        throw new Error('画像が不正です。');
      }
      register(image.id, '画像'); imagesById.set(image.id, image);
      const owner = image.ownerType === 'scene' ? scenesById.get(image.ownerId) : charactersById.get(image.ownerId);
      if (!owner) throw new Error('画像所有者が章バンドルにありません。');
    }

    const expectedImageIds = new Set();
    const checkImages = (owner, type) => {
      if (new Set(owner.imageIds).size !== owner.imageIds.length) throw new Error('画像IDが重複しています。');
      owner.imageIds.forEach((id, index) => {
        expectedImageIds.add(id);
        const image = imagesById.get(id);
        if (!image || image.ownerType !== type || image.ownerId !== owner.id || image.order !== index) throw new Error('画像参照が存在しないか所有者と一致しません。');
      });
    };
    for (const scene of scenes) checkImages(scene, 'scene');
    for (const character of characters) checkImages(character, 'character');
    if (images.some(image => !expectedImageIds.has(image.id))) throw new Error('未参照画像が章バンドルに含まれています。');

    return {
      sourceWork: copy(sourceWork),
      catalog: copy(catalog),
      chapter: copy(chapter),
      episodes: copy(episodes),
      scenes: copy(scenes),
      characters: copy(characters),
      images: images.map(image => ({ ...copy(stripBlob(image)), blob: image.blob }))
    };
  }

  function chapterBundleToPackage(rawBundle) {
    const bundle = validateChapterBundle(rawBundle);
    return {
      work: {
        schemaVersion: bundle.sourceWork.schemaVersion,
        id: bundle.sourceWork.id,
        title: bundle.sourceWork.title,
        summary: bundle.sourceWork.summary,
        chapters: [copy(bundle.chapter)],
        episodes: copy(bundle.episodes),
        scenes: copy(bundle.scenes),
        characters: copy(bundle.characters),
        images: bundle.images.map(image => copy(stripBlob(image)))
      },
      images: bundle.images.map(image => ({ id: image.id, mimeType: image.mimeType, blob: image.blob }))
    };
  }

  function canonicalChapterValue(rawBundle, sceneImageHashes = {}) {
    const bundle = validateChapterBundle(rawBundle);
    const sceneImages = bundle.images.filter(image => image.ownerType === 'scene').sort((a, b) => a.ownerId.localeCompare(b.ownerId) || orderCompare(a, b));
    return {
      chapter: copy(bundle.chapter),
      episodes: bundle.episodes.slice().sort(orderCompare).map(copy),
      scenes: bundle.scenes.slice().sort(sceneCompare).map(copy),
      sceneImages: sceneImages.map(image => ({ ...copy(stripBlob(image)), sha256: sceneImageHashes[image.id] || null }))
    };
  }

  const api = { buildChapterBundle, validateChapterBundle, chapterBundleToPackage, canonicalChapterValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelChapterBundle = api;
})(globalThis);
