(function (root) {
  'use strict';

  const HASH = /^[a-f0-9]{64}$/;
  const clone = value => structuredClone(value);

  function normalizeWorkspaceMeta(raw) {
    if (raw == null) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.mode !== 'chapter-workspace' ||
        raw.id !== 'active' || typeof raw.sourceWorkId !== 'string' || !raw.sourceWorkId || raw.sharedReadOnly !== true ||
        !Array.isArray(raw.catalog) || !Array.isArray(raw.loadedChapterIds) || raw.loadedChapterIds.length !== 1 ||
        !raw.baselines || typeof raw.baselines !== 'object' || Array.isArray(raw.baselines)) {
      throw new Error('章ワークスペース情報が不正です。');
    }
    const catalogIds = new Set();
    const catalog = raw.catalog.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || catalogIds.has(item.id) ||
          typeof item.title !== 'string' || !Number.isSafeInteger(item.order) || item.order < 0 ||
          !Number.isSafeInteger(item.episodeCount) || item.episodeCount < 0 || !Number.isSafeInteger(item.textLength) || item.textLength < 0) {
        throw new Error('章ワークスペースのカタログが不正です。');
      }
      catalogIds.add(item.id);
      return clone(item);
    });
    const chapterId = raw.loadedChapterIds[0];
    if (typeof chapterId !== 'string' || !chapterId || !catalogIds.has(chapterId)) throw new Error('読み込み済み章がカタログと一致しません。');
    const baseline = raw.baselines[chapterId];
    if (!baseline || typeof baseline !== 'object' || !HASH.test(baseline.baseChapterHash) ||
        typeof baseline.exportedAt !== 'string' || !baseline.exportedAt || Number.isNaN(Date.parse(baseline.exportedAt))) {
      throw new Error('章ワークスペースの基準情報が不正です。');
    }
    return {
      id: 'active', mode: 'chapter-workspace', sourceWorkId: raw.sourceWorkId,
      catalog, loadedChapterIds: [chapterId],
      baselines: { [chapterId]: { baseChapterHash: baseline.baseChapterHash, exportedAt: baseline.exportedAt } },
      sharedReadOnly: true
    };
  }

  function createChapterWorkspaceMeta(bundle, baseChapterHash, exportedAt) {
    if (!bundle?.sourceWork?.id || !bundle?.chapter?.id || !Array.isArray(bundle.catalog)) throw new Error('章バンドルが不正です。');
    return normalizeWorkspaceMeta({
      id: 'active', mode: 'chapter-workspace', sourceWorkId: bundle.sourceWork.id,
      catalog: bundle.catalog, loadedChapterIds: [bundle.chapter.id],
      baselines: { [bundle.chapter.id]: { baseChapterHash, exportedAt } }, sharedReadOnly: true
    });
  }

  function hasMutation(section) {
    return Boolean(section && ((section.upsert?.length || 0) > 0 || (section.deleteIds?.length || 0) > 0));
  }

  function assertPatchAllowed(rawMeta, patch, currentState) {
    const meta = normalizeWorkspaceMeta(rawMeta);
    if (!meta) return;
    if (!patch || typeof patch !== 'object' || patch.workId !== meta.sourceWorkId) throw new Error('章ワークスペースの作品IDと変更先が一致しません。');
    const loaded = new Set(meta.loadedChapterIds);
    const loadedChapter = chapterId => {
      if (!loaded.has(chapterId)) throw new Error('読み込まれていない章は変更できません。');
    };
    if (patch.work !== undefined && patch.work !== null) throw new Error('章ワークスペースでは作品全体の共有設定を変更できません。');
    if (hasMutation(patch.characters)) throw new Error('章ワークスペースでは人物の共有設定を変更できません。');

    for (const chapter of patch.chapters?.upsert || []) loadedChapter(chapter.chapterId || chapter.id);
    for (const id of patch.chapters?.deleteIds || []) loadedChapter(id);

    const episodeById = new Map([
      ...(currentState?.episodeMetas || []).map(item => [item.id, item]),
      ...Object.values(currentState?.episodesById || {}).map(item => [item.id, item]),
      ...(patch.episodes?.upsert || []).map(item => [item.id, item])
    ]);
    for (const episode of patch.episodes?.upsert || []) loadedChapter(episode.chapterId);
    for (const id of patch.episodes?.deleteIds || []) {
      const episode = episodeById.get(id);
      if (!episode) throw new Error('削除する話の章を確認できません。');
      loadedChapter(episode.chapterId);
    }

    const stateScenes = Object.values(currentState?.scenesByEpisodeId || {}).flat();
    const sceneById = new Map([...stateScenes.map(item => [item.id, item]), ...(patch.scenes?.upsert || []).map(item => [item.id, item])]);
    for (const scene of patch.scenes?.upsert || []) loadedChapter(scene.chapterId);
    for (const id of patch.scenes?.deleteIds || []) {
      const scene = sceneById.get(id);
      if (!scene) throw new Error('削除するシーンの章を確認できません。');
      loadedChapter(scene.chapterId);
    }

    const imageById = new Map(Object.entries(currentState?.imagesById || {}));
    for (const image of patch.images?.upsert || []) imageById.set(image.id, image);
    const assertSceneImage = image => {
      if (!image) throw new Error('画像の所有者を確認できません。');
      if (image.ownerType === 'character') throw new Error('章ワークスペースでは人物画像の共有データを変更できません。');
      if (image.ownerType !== 'scene') throw new Error('画像の所有者種別が不正です。');
      const scene = sceneById.get(image.ownerId);
      if (!scene) throw new Error('シーン画像の所有シーンを確認できません。');
      loadedChapter(scene.chapterId);
    };
    for (const image of patch.images?.upsert || []) assertSceneImage(image);
    for (const id of patch.images?.deleteIds || []) assertSceneImage(imageById.get(id));
  }

  const api = { normalizeWorkspaceMeta, createChapterWorkspaceMeta, assertPatchAllowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelWorkspaceMode = api;
})(globalThis);
