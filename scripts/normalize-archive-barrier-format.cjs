const fs = require('node:fs');

function replaceBetween(source, start, end, replacement, label) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`${label}: start marker not found`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`${label}: end marker not found`);
  return source.slice(0, startIndex) + replacement + source.slice(endIndex);
}

function write(file, transform) {
  const source = fs.readFileSync(file, 'utf8');
  const next = transform(source);
  if (next === source) throw new Error(`${file}: no changes made`);
  fs.writeFileSync(file, next);
}

write('app.js', source => replaceBetween(
  source,
  '  async function deleteScene(sceneId) {',
  '  function renderScenes(episode, force) {',
`  async function deleteScene(sceneId) {
    if (busy) return;
    const yes = await choose('シーン説明を削除', 'このシーン説明と参考画像を削除します。「元に戻す」で復元できます。', [{ label: '取消', value: false }, { label: '削除', value: true, className: 'danger' }]);
    if (!yes) return;
    const finishOperation = beginOperation();
    try {
      const initial = currentState(), episodeId = selectedEpisodeId, workId = initial.work.id;
      const initialScene = scenesForEpisode(initial, episodeId).find(item => item.id === sceneId); if (!initialScene) return;
      let imageRecords;
      try {
        imageRecords = await Promise.all(initialScene.imageIds.map(id => {
          const loaded = initial.imagesById[id];
          return loaded?.blob ? loaded : NovelStorage.loadImage(db, id);
        }));
        if (imageRecords.some(image => !image?.blob)) throw new Error('画像本体が保存先に見つかりません。');
      } catch (error) { toast(\`シーンを削除できませんでした：\${error.message}\`); return; }
      if (currentState().work.id !== workId || selectedEpisodeId !== episodeId) return;
      history.present = E.applyPatch(currentState(), { workId, images: { upsert: imageRecords, deleteIds: [] } });
      const state = currentState(), scenes = scenesForEpisode(state, episodeId);
      const scene = scenes.find(item => item.id === sceneId); if (!scene) return;
      const remaining = scenes.filter(item => item.id !== sceneId).slice().sort((left, right) => left.order - right.order).map((item, order) => ({ ...item, order }));
      const imagesById = { ...state.imagesById }; scene.imageIds.forEach(id => delete imagesById[id]);
      const next = { ...state, scenesByEpisodeId: { ...state.scenesByEpisodeId, [episodeSceneKey(episodeId)]: remaining }, imagesById };
      changed(next, null, {
        workId,
        scenes: { upsert: remaining, deleteIds: [sceneId] },
        images: { upsert: [], deleteIds: scene.imageIds }
      });
      syncImageUrls();
    } finally {
      finishOperation();
    }
  }
`,
  'deleteScene formatting'
));

write('characters.js', source => replaceBetween(
  source,
  '    async function removeImage(character, imageId) {',
  '    async function openCharacter(characterId) {',
`    async function removeImage(character, imageId) {
      const finishOperation = workspace.beginOperation();
      try {
        const latest = getState(), current = latest.characters.find(item => item.id === character.id), workId = latest.work.id;
        if (!current) return;
        let ownerImages;
        try {
          ownerImages = await Promise.all(current.imageIds.map(async id => {
            const image = loadedImages.get(id) || getState().imagesById[id];
            return image?.blob ? image : workspace.loadImage(id);
          }));
          if (ownerImages.some(image => !image?.blob)) throw new Error('画像本体が保存先に見つかりません。');
        } catch (error) { workspace.toast(\`人物画像を削除できません：\${error.message}\`); return; }
        if (getState().work.id !== workId) return;
        workspace.hydrate({ workId, images: { upsert: ownerImages, deleteIds: [] } });
        const updated = detachImage(getState().characters.find(item => item.id === character.id) || current, imageId);
        const images = updated.imageIds.map((id, order) => {
          const image = getState().imagesById[id];
          return image.order === order ? image : { ...image, order };
        });
        commitPatch({ workId, characters: { upsert: [updated], deleteIds: [] }, images: { upsert: images, deleteIds: [imageId] } });
        loadedImages.delete(imageId);
        images.forEach(image => loadedImages.set(image.id, image));
        const url = imageUrls.get(imageId); if (url) URL.revokeObjectURL(url); imageUrls.delete(imageId);
        await render();
      } finally {
        finishOperation();
      }
    }

`,
  'character removeImage formatting'
));

write('plot.js', source => {
  source = replaceBetween(
    source,
    '    async function moveEpisode(episodeId, delta) {',
    '    async function setScope(nextMode, episodeId = null, chapterId = null) {',
`    async function moveEpisode(episodeId, delta) {
      const state = getState(), episodes = sortedEpisodes(state, selectedChapterId), index = episodes.findIndex(item => item.id === episodeId);
      const nextIndex = index + delta; if (index < 0 || nextIndex < 0 || nextIndex >= episodes.length) return;
      const finishOperation = workspace.beginOperation();
      try {
        const beforeRecords = await loadEpisodeBodies([episodes[index], episodes[nextIndex]], state);
        if (getState().work.id !== state.work.id) return;
        const currentBeforeHydration = getState();
        const beforeCache = beforeRecords.filter(episode => !Array.isArray(currentBeforeHydration.episodesById[episode.id]?.lines));
        workspace.hydrate({ workId: state.work.id, episodes: { upsert: beforeCache, deleteIds: [] } });
        const latest = getState();
        const records = beforeRecords.map(episode => ({ ...(latest.episodesById[episode.id] || episode) }));
        [records[0].order, records[1].order] = [records[1].order, records[0].order];
        const patch = { workId: latest.work.id, episodes: { upsert: records, deleteIds: [] } };
        workspace.commit(editorState.applyPatch(latest, patch), patch, \`plot:chapter:\${selectedChapterId}:episodes:order\`);
        void render();
      } finally {
        finishOperation();
      }
    }

`,
    'moveEpisode formatting'
  );
  source = replaceBetween(
    source,
    '    async function removeImage(scene, imageId) {',
    '    async function moveSelectedScene(destination) {',
`    async function removeImage(scene, imageId) {
      const finishOperation = workspace.beginOperation();
      try {
        const state = getState(), current = sceneAt(scene.id) || scene, workId = state.work.id;
        let ownerImages;
        try {
          ownerImages = await Promise.all(current.imageIds.map(async id => {
            const image = loadedImages.get(id) || getState().imagesById[id];
            return image?.blob ? image : workspace.loadImage(id);
          }));
          if (ownerImages.some(image => !image?.blob)) throw new Error('画像本体が保存先に見つかりません。');
        } catch (error) { workspace.toast(\`シーン画像を削除できません：\${error.message}\`); return; }
        if (getState().work.id !== workId) return;
        workspace.hydrate({ workId, images: { upsert: ownerImages, deleteIds: [] } });
        const latest = getState(), latestScene = sceneAt(scene.id) || current;
        const updated = detachImage(latestScene, imageId);
        const images = updated.imageIds.map((id, order) => {
          const image = latest.imagesById[id];
          return image.order === order ? image : { ...image, order };
        });
        const patch = { workId, scenes: { upsert: [updated], deleteIds: [] }, images: { upsert: images, deleteIds: [imageId] } };
        commitPatch(patch); loadedImages.delete(imageId);
        images.forEach(image => loadedImages.set(image.id, image));
        const url = imageUrls.get(imageId); if (url) URL.revokeObjectURL(url); imageUrls.delete(imageId);
        await render();
      } finally {
        finishOperation();
      }
    }

`,
    'plot removeImage formatting'
  );
  source = replaceBetween(
    source,
    '    async function moveSelectedScene(destination) {',
    '    async function render() {',
`    async function moveSelectedScene(destination) {
      const finishOperation = workspace.beginOperation();
      try {
        const scope = activeScope(), source = await ensureBucket(scope), scene = source.find(item => item.id === selectedSceneId);
        if (!scene) return;
        const state = getState();
        if (destination.episodeId) {
          const meta = state.episodeMetas.find(item => item.id === destination.episodeId);
          if (!meta || meta.chapterId !== destination.chapterId) return;
        }
        if (scopeKey(destination) === scopeKey(scope)) return;
        const target = await ensureBucket(destination);
        const moved = moveBetweenScopes(source, target, scene.id, destination, target.length);
        const upsert = [...moved.source, ...moved.destination];
        const patch = { workId: state.work.id, scenes: { upsert, deleteIds: [] } };
        commitPatch(patch);
        buckets.set(keyForScope(scope), moved.source); buckets.set(keyForScope(destination), moved.destination);
        mode = destination.episodeId ? 'episode' : destination.chapterId ? 'chapter' : 'unassigned';
        selectedChapterId = destination.chapterId || selectedChapterId;
        if (destination.episodeId) await workspace.selectEpisode(destination.episodeId);
        if (destination.episodeId) selectedEpisodeId = destination.episodeId;
        selectedSceneId = scene.id; scenePage = 0; imageOpen = false; revokeImages();
        await render();
      } finally {
        finishOperation();
      }
    }

`,
    'moveSelectedScene formatting'
  );
  const chapterStart = "        const chapterSelect = addSelect('話の章', activeEpisodeMeta.chapterId, moveOptions, chapterId => {";
  const chapterEnd = '        episodePanel.append(title.label, chapterSelect.label);';
  source = replaceBetween(
    source,
    chapterStart,
    chapterEnd,
`        const chapterSelect = addSelect('話の章', activeEpisodeMeta.chapterId, moveOptions, chapterId => {
          const snapshot = getState(), meta = snapshot.episodeMetas.find(item => item.id === activeEpisodeMeta.id);
          if (!meta || meta.chapterId === chapterId) return;
          void (async () => {
            const finishOperation = workspace.beginOperation();
            try {
              const sourceMetas = sortedEpisodes(snapshot, meta.chapterId).filter(item => item.id !== meta.id);
              const destinationMetas = sortedEpisodes(snapshot, chapterId);
              const beforeBodies = await loadEpisodeBodies([meta, ...sourceMetas, ...destinationMetas], snapshot);
              if (getState().work.id !== snapshot.work.id) return;
              const currentBeforeHydration = getState();
              const uncached = beforeBodies.filter(episode => !Array.isArray(currentBeforeHydration.episodesById[episode.id]?.lines));
              workspace.hydrate({ workId: snapshot.work.id, episodes: { upsert: uncached, deleteIds: [] } });
              const hydratedState = getState();
              const bodyFor = episode => hydratedState.episodesById[episode.id] || episode;
              const movedBody = bodyFor(beforeBodies.find(episode => episode.id === meta.id));
              const sourceUpdates = sourceMetas.map((item, order) => ({ ...bodyFor(beforeBodies.find(episode => episode.id === item.id)), order }));
              const destinationUpdates = destinationMetas.map((item, order) => ({ ...bodyFor(beforeBodies.find(episode => episode.id === item.id)), order }));
              const changedMeta = { ...movedBody, chapterId, order: destinationUpdates.length };
              const loaded = await ensureBucket({ episodeId: meta.id, chapterId: meta.chapterId });
              if (getState().work.id !== snapshot.work.id) return;
              const changedScenes = loaded.map(scene => ({ ...scene, chapterId }));
              commitPatch({
                workId: snapshot.work.id,
                episodes: { upsert: [...sourceUpdates, ...destinationUpdates, changedMeta], deleteIds: [] },
                scenes: { upsert: changedScenes, deleteIds: [] }
              });
              selectedChapterId = chapterId; mode = 'episode'; void render();
            } finally {
              finishOperation();
            }
          })().catch(error => workspace.toast(\`話を移動できませんでした：\${error.message}\`));
        });
`,
    'chapter move formatting'
  );
  const sceneStart = "      sceneHeading.append(makeButton('＋ シーン', async () => {";
  const sceneEnd = '      const visibleChapterOptions = chapters.slice(chapterPage * pageSize, (chapterPage + 1) * pageSize);';
  source = replaceBetween(
    source,
    sceneStart,
    sceneEnd,
`      sceneHeading.append(makeButton('＋ シーン', async () => {
        const finishOperation = workspace.beginOperation();
        try {
          const latest = getState(), scopeNow = activeScope(), items = await ensureBucket(scopeNow);
          const scene = createScene(latest.work.id, scopeNow, items.length);
          selectedSceneId = scene.id; scenePage = Math.floor(items.length / pageSize); imageOpen = false;
          buckets.set(keyForScope(scopeNow), [...items, scene]);
          commitPatch({ workId: latest.work.id, scenes: { upsert: [scene], deleteIds: [] } });
          await render();
        } finally {
          finishOperation();
        }
      }, 'accent'));
`,
    'scene add formatting'
  );
  return source;
});
