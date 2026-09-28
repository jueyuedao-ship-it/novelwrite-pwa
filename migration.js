/*
 * Migration from schema v1-v3 JSON exports and the legacy recovery envelope.
 * `migrateLegacy` returns `{ work, images }`, with binary payloads kept apart
 * from the validated metadata aggregate for storage and archive operations.
 */
(function (root) {
  'use strict';
  const core = typeof module !== 'undefined' && module.exports ? require('./core') : root.NovelCore;
  const model = typeof module !== 'undefined' && module.exports ? require('./model') : root.NovelModel;

  function decodeImage(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
    const binary = globalThis.atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return { mimeType, blob: new Blob([bytes], { type: mimeType }) };
  }

  function parseInput(raw) {
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch { throw new Error('旧作品JSONを読み込めません。'); }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('旧作品データが不正です。');
    if (raw.schemaVersion === undefined && raw.work && typeof raw.work === 'object' && !Array.isArray(raw.work)) return raw.work;
    return raw;
  }

  function migrateLegacy(raw) {
    if (!core || !model) throw new Error('旧作品の移行モジュールが読み込まれていません。');
    const source = core.validateWork(parseInput(raw));
    const work = {
      schemaVersion: model.SCHEMA_VERSION,
      id: source.id,
      title: source.title,
      summary: '',
      chapters: [],
      episodes: [],
      scenes: [],
      characters: [],
      images: []
    };
    const images = [];
    const legacyIds = new Set([source.id]);
    source.characters.forEach(character => {
      legacyIds.add(character.id);
      character.images.forEach(image => legacyIds.add(image.id));
    });
    source.chapters.forEach(episode => {
      legacyIds.add(episode.id);
      episode.lines.forEach(line => legacyIds.add(line.id));
      episode.scenes.forEach(scene => {
        legacyIds.add(scene.id);
        scene.images.forEach(image => legacyIds.add(image.id));
      });
    });
    let chapterId = core.uid('chapter');
    while (legacyIds.has(chapterId)) chapterId = core.uid('chapter');
    work.chapters.push({ id: chapterId, workId: work.id, title: '未分類の章', order: 0 });

    const matchingCharactersByName = new Map();
    source.characters.forEach(character => {
      if (character.name !== '') {
        if (!matchingCharactersByName.has(character.name)) matchingCharactersByName.set(character.name, []);
        matchingCharactersByName.get(character.name).push(character.id);
      }
      work.characters.push({
        id: character.id,
        workId: work.id,
        name: character.name,
        role: '',
        description: character.description,
        appearance: '',
        personality: '',
        goal: '',
        background: '',
        relationshipNotes: '',
        customFields: [],
        imageIds: []
      });
      character.images.forEach((image, index) => {
        const decoded = decodeImage(image.dataUrl);
        work.images.push({
          id: image.id, workId: work.id, ownerType: 'character', ownerId: character.id, order: index,
          name: image.name, mimeType: decoded.mimeType, referenceNumber: null
        });
        work.characters.at(-1).imageIds.push(image.id);
        images.push({ id: image.id, mimeType: decoded.mimeType, blob: decoded.blob });
      });
    });

    source.chapters.forEach((oldEpisode, episodeOrder) => {
      const episode = {
        id: oldEpisode.id,
        workId: work.id,
        chapterId,
        title: oldEpisode.title,
        order: episodeOrder,
        lines: oldEpisode.lines.map(line => {
          const matches = matchingCharactersByName.get(line.speaker) || [];
          return { id: line.id, speaker: line.speaker, characterId: matches.length === 1 ? matches[0] : null, text: line.text };
        })
      };
      work.episodes.push(episode);
      oldEpisode.scenes.forEach((oldScene, sceneOrder) => {
        const scene = {
          id: oldScene.id,
          workId: work.id,
          chapterId,
          episodeId: episode.id,
          order: sceneOrder,
          startLineId: oldScene.startLineId,
          endLineId: oldScene.endLineId,
          summary: oldScene.description,
          purpose: '',
          characterIds: [],
          viewpoint: '',
          location: '',
          time: '',
          notes: '',
          imageIds: [],
          nextImageNumber: oldScene.nextImageNumber
        };
        work.scenes.push(scene);
        oldScene.images.forEach((image, imageOrder) => {
          const decoded = decodeImage(image.dataUrl);
          work.images.push({
            id: image.id, workId: work.id, ownerType: 'scene', ownerId: scene.id, order: imageOrder,
            name: image.name, mimeType: decoded.mimeType, referenceNumber: image.referenceNumber
          });
          scene.imageIds.push(image.id);
          images.push({ id: image.id, mimeType: decoded.mimeType, blob: decoded.blob });
        });
      });
    });

    return { work: model.validateWork(work), images };
  }

  const api = { migrateLegacy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelMigration = api;
})(globalThis);
