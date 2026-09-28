(function (root) {
  'use strict';

  const core = typeof module !== 'undefined' && module.exports ? require('./core') : root.NovelCore;
  const objectById = records => Object.fromEntries((records || []).map(record => [record.id, record]));
  const scenesById = state => Object.values(state.scenesByEpisodeId).flat();
  const episodeSceneKey = episodeId => `episode:${episodeId}`;
  const sceneStateKey = scene => scene.episodeId !== null ? episodeSceneKey(scene.episodeId) : scene.chapterId !== null ? `chapter:${scene.chapterId}` : 'unassigned';
  const imageMetadata = image => {
    const { blob, ...metadata } = image;
    return metadata;
  };
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sameImage = (left, right) => Boolean(left && right && left.blob === right.blob && same(imageMetadata(left), imageMetadata(right)));

  function createState(index, episode, scenes = [], images = []) {
    if (!index || !index.work || !episode || episode.workId !== index.work.id) throw new Error('本文編集状態を作成できません。');
    return {
      work: { ...index.work },
      chapters: [...index.chapters],
      episodeMetas: [...index.episodes],
      characters: [...index.characters],
      episodesById: { [episode.id]: episode },
      scenesByEpisodeId: { [episodeSceneKey(episode.id)]: [...scenes] },
      imagesById: objectById(images),
      activeEpisodeId: episode.id
    };
  }

  function activateEpisode(state, episode, scenes = [], images = []) {
    if (!episode || episode.workId !== state.work.id) throw new Error('選択した話を読み込めません。');
    const episodeMetas = state.episodeMetas.some(item => item.id === episode.id)
      ? state.episodeMetas.map(item => item.id === episode.id ? { id: episode.id, workId: episode.workId, chapterId: episode.chapterId, title: episode.title, order: episode.order } : item)
      : [...state.episodeMetas, { id: episode.id, workId: episode.workId, chapterId: episode.chapterId, title: episode.title, order: episode.order }];
    return {
      ...state,
      episodeMetas,
      episodesById: { ...state.episodesById, [episode.id]: episode },
      scenesByEpisodeId: { ...state.scenesByEpisodeId, [episodeSceneKey(episode.id)]: [...scenes] },
      imagesById: { ...state.imagesById, ...objectById(images) },
      activeEpisodeId: episode.id
    };
  }

  function retainLoaded(previous, selected) {
    const imagesById = Object.fromEntries(Object.entries(selected.imagesById).map(([id, image]) => {
      const blob = image.blob ?? previous.imagesById[id]?.blob;
      return [id, blob ? { ...image, blob } : image];
    }));
    return {
      ...selected,
      episodesById: { ...previous.episodesById, ...selected.episodesById },
      scenesByEpisodeId: { ...previous.scenesByEpisodeId, ...selected.scenesByEpisodeId },
      imagesById
    };
  }

  function episodeView(state) {
    const episode = state.episodesById[state.activeEpisodeId];
    if (!episode) throw new Error('選択中の話の本文が読み込まれていません。');
    const scenes = (state.scenesByEpisodeId[episodeSceneKey(episode.id)] || []).slice().sort((a, b) => a.order - b.order).map(scene => ({
      ...scene,
      description: scene.summary,
      images: scene.imageIds.map(id => state.imagesById[id]).filter(Boolean)
    }));
    return { ...episode, scenes };
  }

  function replaceEpisodeView(state, view) {
    const previousEpisode = state.episodesById[view.id];
    if (!previousEpisode) throw new Error('編集対象の話が見つかりません。');
    const previousLines = new Map(previousEpisode.lines.map(line => [line.id, line]));
    const episode = {
      ...previousEpisode,
      title: view.title,
      lines: view.lines.map(line => ({
        ...line,
        characterId: Object.prototype.hasOwnProperty.call(line, 'characterId') ? line.characterId : previousLines.get(line.id)?.characterId ?? null
      }))
    };
    const previousScenes = new Map((state.scenesByEpisodeId[episodeSceneKey(view.id)] || []).map(scene => [scene.id, scene]));
    const episodeMeta = state.episodeMetas.find(item => item.id === view.id);
    const scenes = view.scenes.map((scene, order) => {
      const previous = previousScenes.get(scene.id);
      if (previous) {
        return {
          ...previous,
          order,
          startLineId: scene.startLineId,
          endLineId: scene.endLineId,
          summary: scene.description,
          nextImageNumber: scene.nextImageNumber
        };
      }
      return {
        id: scene.id,
        workId: state.work.id,
        chapterId: episodeMeta.chapterId,
        episodeId: view.id,
        order,
        startLineId: scene.startLineId,
        endLineId: scene.endLineId,
        summary: scene.description,
        purpose: '',
        characterIds: [],
        viewpoint: '',
        location: '',
        time: '',
        notes: '',
        imageIds: (scene.images || []).map(image => image.id),
        nextImageNumber: scene.nextImageNumber
      };
    });
    return {
      ...state,
      episodeMetas: state.episodeMetas.map(item => item.id === view.id ? { ...item, title: view.title } : item),
      episodesById: { ...state.episodesById, [view.id]: episode },
      scenesByEpisodeId: { ...state.scenesByEpisodeId, [episodeSceneKey(view.id)]: scenes }
    };
  }

  function currentWork(state) {
    const episodes = state.episodeMetas.map(meta => state.episodesById[meta.id] || meta);
    const scenes = scenesById(state);
    const images = Object.values(state.imagesById).map(imageMetadata);
    return { ...state.work, chapters: state.chapters, episodes, scenes, characters: state.characters, images };
  }

  function mapDiff(previous, next, collection, equal = same) {
    const before = new Map(previous.map(record => [record.id, record]));
    const after = new Map(next.map(record => [record.id, record]));
    const upsert = [];
    const deleteIds = [];
    for (const record of next) {
      if (!before.has(record.id) || !equal(before.get(record.id), record)) upsert.push(record);
    }
    for (const record of previous) if (!after.has(record.id)) deleteIds.push(record.id);
    return { [collection]: { upsert, deleteIds } };
  }

  function records(state, collection) {
    if (collection === 'chapters') return state.chapters;
    if (collection === 'episodes') return state.episodeMetas.map(meta => state.episodesById[meta.id] || meta);
    if (collection === 'scenes') return scenesById(state);
    if (collection === 'characters') return state.characters;
    if (collection === 'images') return Object.values(state.imagesById);
    return [];
  }

  function diffChanges(previous, next) {
    const patch = { workId: next.work.id };
    if (!same(previous.work, next.work)) patch.work = next.work;
    for (const collection of ['chapters', 'episodes', 'scenes', 'characters']) {
      Object.assign(patch, mapDiff(records(previous, collection), records(next, collection), collection));
    }
    Object.assign(patch, mapDiff(records(previous, 'images'), records(next, 'images'), 'images', sameImage));
    const hasChanges = patch.work || ['chapters', 'episodes', 'scenes', 'characters', 'images'].some(name => patch[name].upsert.length || patch[name].deleteIds.length);
    return hasChanges ? patch : null;
  }

  function mergeChanges(current, incoming) {
    if (!incoming) return current;
    if (!current) current = { workId: incoming.workId };
    const result = { ...current, ...incoming, workId: incoming.workId || current.workId };
    if (current.work && incoming.work) result.work = incoming.work;
    for (const name of ['chapters', 'episodes', 'scenes', 'characters', 'images']) {
      const left = current[name] || { upsert: [], deleteIds: [] };
      const right = incoming[name] || { upsert: [], deleteIds: [] };
      const upsert = new Map(left.upsert.map(record => [record.id, record]));
      const deletes = new Set(left.deleteIds);
      for (const id of right.deleteIds) { upsert.delete(id); deletes.add(id); }
      for (const record of right.upsert) { deletes.delete(record.id); upsert.set(record.id, record); }
      result[name] = { upsert: [...upsert.values()], deleteIds: [...deletes] };
    }
    return result;
  }

  function updateRecords(records, section) {
    const next = new Map((records || []).map(record => [record.id, record]));
    for (const id of section?.deleteIds || []) next.delete(id);
    for (const record of section?.upsert || []) next.set(record.id, record);
    return [...next.values()];
  }

  function applyPatch(state, patch) {
    if (!patch) return state;
    if (patch.workId !== state.work.id) throw new Error('差分の作品IDが一致しません。');
    const next = { ...state };
    if (patch.work) next.work = { ...state.work, ...patch.work };
    if (patch.chapters) next.chapters = updateRecords(state.chapters, patch.chapters);
    if (patch.episodes) {
      const metas = state.episodeMetas.slice();
      const episodeMap = { ...state.episodesById };
      for (const id of patch.episodes.deleteIds || []) delete episodeMap[id];
      for (const episode of patch.episodes.upsert || []) if (Array.isArray(episode.lines)) episodeMap[episode.id] = episode;
      next.episodesById = episodeMap;
      next.episodeMetas = updateRecords(metas, {
        deleteIds: patch.episodes.deleteIds,
        upsert: (patch.episodes.upsert || []).map(({ id, workId, chapterId, title, order }) => ({ id, workId, chapterId, title, order }))
      });
    }
    if (patch.scenes) {
      const byEpisode = Object.fromEntries(Object.entries(state.scenesByEpisodeId).map(([key, records]) => [key, records.slice()]));
      for (const id of patch.scenes.deleteIds || []) {
        for (const key of Object.keys(byEpisode)) byEpisode[key] = byEpisode[key].filter(scene => scene.id !== id);
      }
      for (const scene of patch.scenes.upsert || []) {
        const key = sceneStateKey(scene);
        for (const otherKey of Object.keys(byEpisode)) byEpisode[otherKey] = byEpisode[otherKey].filter(item => item.id !== scene.id);
        byEpisode[key] = updateRecords(byEpisode[key], { upsert: [scene] });
      }
      next.scenesByEpisodeId = byEpisode;
    }
    if (patch.characters) next.characters = updateRecords(state.characters, patch.characters);
    if (patch.images) {
      const images = { ...state.imagesById };
      for (const id of patch.images.deleteIds || []) delete images[id];
      for (const image of patch.images.upsert || []) {
        const blob = image.blob ?? images[image.id]?.blob;
        images[image.id] = blob ? { ...image, blob } : image;
      }
      next.imagesById = images;
    }
    return next;
  }

  const api = { episodeSceneKey, createState, activateEpisode, retainLoaded, episodeView, replaceEpisodeView, currentWork, diffChanges, mergeChanges, applyPatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelEditorState = api;
})(globalThis);
