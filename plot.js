(function (root) {
  'use strict';

  const uid = prefix => root.NovelCore?.uid ? root.NovelCore.uid(prefix) : `${prefix}-${root.crypto.randomUUID()}`;
  const byOrder = (left, right) => left.order - right.order;
  const sortAndOrder = records => records.slice().sort(byOrder).map((record, order) => ({ ...record, order }));
  const scopeKey = scope => scope.episodeId ? `episode:${scope.episodeId}` : scope.chapterId ? `chapter:${scope.chapterId}` : 'unassigned';

  function createScene(workId, scope, order = 0) {
    return {
      id: uid('scene'), workId, chapterId: scope.chapterId ?? null, episodeId: scope.episodeId ?? null, order,
      startLineId: null, endLineId: null, summary: '', purpose: '', characterIds: [], viewpoint: '',
      location: '', time: '', notes: '', imageIds: [], nextImageNumber: 1
    };
  }

  function reorderScenes(scenes, sceneId, destinationIndex) {
    const ordered = scenes.slice().sort(byOrder);
    const from = ordered.findIndex(scene => scene.id === sceneId);
    if (from < 0) throw new Error('並べ替えるシーンが見つかりません。');
    const [scene] = ordered.splice(from, 1);
    const index = Math.max(0, Math.min(ordered.length, destinationIndex));
    ordered.splice(index, 0, scene);
    return ordered.map((record, order) => ({ ...record, order }));
  }

  function moveBetweenScopes(sourceScenes, destinationScenes, sceneId, destination, destinationIndex) {
    const sourceScene = sourceScenes.find(scene => scene.id === sceneId);
    if (!sourceScene) throw new Error('移動するシーンが見つかりません。');
    if (scopeKey(destination) === scopeKey(sourceScene)) {
      return { source: reorderScenes(sourceScenes, sceneId, destinationIndex), destination: null };
    }
    const source = sourceScenes.slice().sort(byOrder);
    const index = source.findIndex(scene => scene.id === sceneId);
    const [original] = source.splice(index, 1);
    const moved = {
      ...original,
      chapterId: destination.chapterId ?? null,
      episodeId: destination.episodeId ?? null
    };
    if (original.episodeId !== moved.episodeId) {
      moved.startLineId = null;
      moved.endLineId = null;
    }
    const target = destinationScenes.slice().sort(byOrder);
    const targetIndex = Math.max(0, Math.min(target.length, destinationIndex));
    target.splice(targetIndex, 0, moved);
    return {
      source: sortAndOrder(source),
      destination: target.map((record, order) => ({ ...record, order }))
    };
  }

  function setLineRange(scene, lines, startLineId, endLineId) {
    const start = lines.findIndex(line => line.id === startLineId);
    const end = lines.findIndex(line => line.id === endLineId);
    if (start < 0 || end < 0) throw new Error('指定した本文行が見つかりません。');
    if (start > end) throw new Error('本文範囲の終了行は開始行以降を指定してください。');
    return { ...scene, startLineId, endLineId };
  }

  function clearLineRange(scene) {
    return { ...scene, startLineId: null, endLineId: null };
  }

  function detachImage(scene, imageId) {
    return { ...scene, imageIds: scene.imageIds.filter(id => id !== imageId) };
  }

  function mount() {
    const host = document.getElementById('plot-extension');
    const workspace = root.NovelWorkspace;
    if (!host || !workspace) return;
    const editorState = root.NovelEditorState;
    const pageSize = 30;
    const buckets = new Map();
    const loadedImages = new Map();
    const imageUrls = new Map();
    let chapterPage = 0, episodePage = 0, scenePage = 0;
    let selectedChapterId = null, selectedEpisodeId = null, selectedSceneId = null;
    let listedChapterId = null, listedEpisodeId = null;
    let destinationSceneId = null, destinationChapterId = null, destinationEpisodeId = null;
    let destinationChapterPage = 0, destinationEpisodePage = 0;
    let mode = 'episode', imageOpen = false, renderGeneration = 0;

    const node = (tag, className, text) => {
      const result = document.createElement(tag);
      if (className) result.className = className;
      if (text !== undefined) result.textContent = text;
      return result;
    };
    const makeButton = (label, action, className = '') => {
      const result = node('button', className, label); result.type = 'button';
      result.addEventListener('click', action); return result;
    };
    const makeField = (labelText, value, onInput, tag = 'input', className = '') => {
      const label = node('label', 'plot-field'); label.append(node('span', '', labelText));
      const control = node(tag, className);
      control.setAttribute('aria-label', labelText);
      if (tag === 'textarea') control.value = value ?? ''; else control.value = value ?? '';
      control.addEventListener('input', () => onInput(control.value));
      label.append(control); return { label, control };
    };
    const addSelect = (labelText, value, options, onChange) => {
      const label = node('label', 'plot-field'); label.append(node('span', '', labelText));
      const select = node('select'); select.setAttribute('aria-label', labelText);
      options.forEach(option => {
        const item = node('option', '', option.label); item.value = option.value;
        item.selected = option.value === value; select.append(item);
      });
      select.addEventListener('change', () => onChange(select.value)); label.append(select); return { label, control: select };
    };
    const getState = () => workspace.getState();
    const sortedChapters = state => state.chapters.slice().sort(byOrder);
    const sortedEpisodes = (state, chapterId) => state.episodeMetas.filter(item => item.chapterId === chapterId).slice().sort(byOrder);
    const activeScope = () => {
      if (mode === 'episode' && selectedEpisodeId) {
        const episode = getState().episodeMetas.find(item => item.id === selectedEpisodeId);
        if (episode) return { chapterId: episode.chapterId, episodeId: episode.id };
      }
      if (mode === 'chapter' && selectedChapterId) return { chapterId: selectedChapterId, episodeId: null };
      return { chapterId: null, episodeId: null };
    };
    const storageSelector = scope => scope.episodeId ? { episodeId: scope.episodeId } : scope.chapterId ? { chapterId: scope.chapterId } : { unassigned: true };
    const keyForScope = scope => scope.episodeId ? `episode:${scope.episodeId}` : scope.chapterId ? `chapter:${scope.chapterId}` : 'unassigned';
    const stateBucket = (state, scope) => state.scenesByEpisodeId[keyForScope(scope)];
    const currentBucket = (state, scope) => stateBucket(state, scope) || buckets.get(keyForScope(scope)) || [];
    const revokeImages = () => { for (const url of imageUrls.values()) URL.revokeObjectURL(url); imageUrls.clear(); };

    async function ensureBucket(scope) {
      const state = getState(), key = keyForScope(scope);
      const cached = stateBucket(state, scope);
      if (cached) { buckets.set(key, cached); return cached; }
      if (buckets.has(key)) {
        const records = buckets.get(key);
        const hydrated = workspace.hydrate({ workId: state.work.id, scenes: { upsert: records, deleteIds: [] } });
        const complete = stateBucket(hydrated, scope) || records;
        buckets.set(key, complete); return complete;
      }
      const records = await workspace.loadScenes(storageSelector(scope));
      if (getState().work.id !== state.work.id) return [];
      const hydrated = workspace.hydrate({ workId: state.work.id, scenes: { upsert: records, deleteIds: [] } });
      const complete = stateBucket(hydrated, scope) || records;
      buckets.set(key, complete); return complete;
    }

    function commitPatch(patch, historyKey = null) {
      const current = getState();
      const next = editorState.applyPatch(current, patch);
      const committed = workspace.commit(next, patch, historyKey);
      if (committed) {
        for (const [key, records] of Object.entries(next.scenesByEpisodeId)) buckets.set(key, records);
      }
      return committed;
    }

    function pagination(className, page, total, label, onChange) {
      const wrap = node('div', className);
      const start = total ? page * pageSize + 1 : 0;
      const end = Math.min(total, (page + 1) * pageSize);
      wrap.append(makeButton(`前の${label}`, () => onChange(Math.max(0, page - 1)), 'quiet'));
      wrap.append(node('span', '', `${start}–${end} / ${total}`));
      wrap.append(makeButton(`次の${label}`, () => onChange(Math.min(Math.ceil(total / pageSize) - 1, page + 1)), 'quiet'));
      wrap.firstElementChild.disabled = page <= 0;
      wrap.lastElementChild.disabled = page >= Math.ceil(total / pageSize) - 1;
      return wrap;
    }

    function moveChapter(chapterId, delta) {
      const state = getState(), chapters = sortedChapters(state), index = chapters.findIndex(item => item.id === chapterId);
      const nextIndex = index + delta; if (index < 0 || nextIndex < 0 || nextIndex >= chapters.length) return;
      [chapters[index], chapters[nextIndex]] = [chapters[nextIndex], chapters[index]];
      commitPatch({ workId: state.work.id, chapters: { upsert: chapters.map((item, order) => ({ ...item, order })), deleteIds: [] } }, 'plot:chapters:order');
      void render();
    }

    async function loadEpisodeBodies(metas, state) {
      return Promise.all(metas.map(async meta => {
        const cached = state.episodesById[meta.id];
        const body = Array.isArray(cached?.lines) ? cached : await workspace.loadEpisode(meta.id);
        if (!body) throw new Error(`「${meta.title}」の本文が見つかりません。`);
        return body;
      }));
    }

    async function moveEpisode(episodeId, delta) {
      const state = getState(), episodes = sortedEpisodes(state, selectedChapterId), index = episodes.findIndex(item => item.id === episodeId);
      const nextIndex = index + delta; if (index < 0 || nextIndex < 0 || nextIndex >= episodes.length) return;
      const beforeRecords = await loadEpisodeBodies([episodes[index], episodes[nextIndex]], state);
      if (getState().work.id !== state.work.id) return;
      const currentBeforeHydration = getState();
      const beforeCache = beforeRecords.filter(episode => !Array.isArray(currentBeforeHydration.episodesById[episode.id]?.lines));
      workspace.hydrate({ workId: state.work.id, episodes: { upsert: beforeCache, deleteIds: [] } });
      const latest = getState();
      const records = beforeRecords.map(episode => ({ ...(latest.episodesById[episode.id] || episode) }));
      [records[0].order, records[1].order] = [records[1].order, records[0].order];
      const patch = { workId: latest.work.id, episodes: { upsert: records, deleteIds: [] } };
      workspace.commit(editorState.applyPatch(latest, patch), patch, `plot:chapter:${selectedChapterId}:episodes:order`);
      void render();
    }

    async function setScope(nextMode, episodeId = null, chapterId = null) {
      mode = nextMode; selectedEpisodeId = episodeId || selectedEpisodeId; selectedChapterId = chapterId || selectedChapterId;
      scenePage = 0; selectedSceneId = null; imageOpen = false; revokeImages();
      if (mode === 'episode' && selectedEpisodeId) {
        const meta = getState().episodeMetas.find(item => item.id === selectedEpisodeId);
        if (meta) {
          selectedChapterId = meta.chapterId;
          await workspace.selectEpisode(meta.id);
        }
      }
      await render();
    }

    async function openScene(sceneReference) {
      const state = getState();
      let scene = typeof sceneReference === 'string'
        ? Object.values(state.scenesByEpisodeId).flat().find(item => item.id === sceneReference)
        : sceneReference;
      if (!scene || scene.workId !== state.work.id) { workspace.toast('開くシーンが見つかりません。'); return false; }
      if (!Object.values(state.scenesByEpisodeId).some(records => records.some(item => item.id === scene.id))) {
        workspace.hydrate({ workId: state.work.id, scenes: { upsert: [scene], deleteIds: [] } });
      }
      if (scene.episodeId) await setScope('episode', scene.episodeId, scene.chapterId);
      else if (scene.chapterId) await setScope('chapter', null, scene.chapterId);
      else await setScope('unassigned');
      const records = await ensureBucket(activeScope());
      const index = records.findIndex(item => item.id === scene.id);
      if (index < 0) { workspace.toast('開くシーンが見つかりません。'); return false; }
      selectedSceneId = scene.id; scenePage = Math.floor(index / pageSize); imageOpen = false; revokeImages();
      await render();
      return true;
    }

    function sceneAt(id) { return currentBucket(getState(), activeScope()).find(item => item.id === id); }
    function patchScene(scene, key = null) {
      const state = getState();
      commitPatch({ workId: state.work.id, scenes: { upsert: [scene], deleteIds: [] } }, key);
      const scope = activeScope(), records = currentBucket(getState(), scope);
      buckets.set(keyForScope(scope), records.map(item => item.id === scene.id ? scene : item));
      const row = [...host.querySelectorAll('.plot-scene-row')].find(item => item.dataset.sceneId === scene.id);
      if (row) row.querySelector('.plot-select-row').textContent = `シーン ${scene.order + 1}: ${scene.summary || '要約なし'}`;
    }

    async function readImage(file) {
      if (file.size > root.NovelCore.MAX_IMAGE_BYTES) throw new Error(`「${file.name}」は10MBを超えています。`);
      const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
      const mimeType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
        ? file.type : extensions[file.name.split('.').at(-1).toLowerCase()];
      if (!mimeType) throw new Error('PNG・JPEG・WebP・GIFの画像を選んでください。');
      const blob = new Blob([await file.arrayBuffer()], { type: mimeType });
      await root.NovelPackage.validateImageBlob(mimeType, blob);
      return { id: uid('image'), name: file.name, mimeType, blob };
    }

    async function loadImages(owner) {
      const records = [];
      for (const id of owner.imageIds) {
        let record = loadedImages.get(id) || getState().imagesById[id];
        if (!record?.blob) record = await workspace.loadImage(id);
        if (record) { loadedImages.set(id, record); records.push(record); }
      }
      return records;
    }

    async function addImages(scene) {
      const picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true;
      picker.accept = 'image/png,image/jpeg,image/webp,image/gif'; picker.setAttribute('aria-label', 'シーンの参考画像ファイル');
      picker.addEventListener('change', async () => {
        if (!picker.files.length) return;
        const finishImageLoad = workspace.beginImageLoad();
        try {
          const records = [];
          for (const file of picker.files) records.push(await readImage(file));
          const state = getState(), latest = sceneAt(scene.id);
          if (!latest) throw new Error('シーンが見つかりません。');
          let number = latest.nextImageNumber;
          const images = records.map((record, index) => ({
            id: record.id, workId: state.work.id, ownerType: 'scene', ownerId: latest.id,
            order: latest.imageIds.length + index, name: record.name, mimeType: record.mimeType,
            referenceNumber: number++, blob: record.blob
          }));
          const updated = { ...latest, imageIds: [...latest.imageIds, ...images.map(image => image.id)], nextImageNumber: number };
          images.forEach(image => loadedImages.set(image.id, image));
          commitPatch({ workId: state.work.id, scenes: { upsert: [updated], deleteIds: [] }, images: { upsert: images, deleteIds: [] } }, null);
          await render();
        } catch (error) { workspace.toast(`参考画像を追加できませんでした：${error.message}`); }
        finally { finishImageLoad(); }
      });
      picker.click();
    }

    async function toggleImages(scene) {
      imageOpen = !imageOpen; revokeImages();
      if (imageOpen) {
        try {
          const images = await loadImages(scene);
          if (!imageOpen || document.getElementById('screen-plot')?.hidden) { loadedImages.clear(); return; }
          images.forEach(image => { if (!imageUrls.has(image.id)) imageUrls.set(image.id, URL.createObjectURL(image.blob)); });
        } catch (error) { workspace.toast(`参考画像を読み込めませんでした：${error.message}`); }
      } else loadedImages.clear();
      await render();
    }

    async function removeImage(scene, imageId) {
      const state = getState(), current = sceneAt(scene.id) || scene, workId = state.work.id;
      let ownerImages;
      try {
        ownerImages = await Promise.all(current.imageIds.map(async id => {
          const image = loadedImages.get(id) || getState().imagesById[id];
          return image?.blob ? image : workspace.loadImage(id);
        }));
        if (ownerImages.some(image => !image?.blob)) throw new Error('画像本体が保存先に見つかりません。');
      } catch (error) { workspace.toast(`シーン画像を削除できません：${error.message}`); return; }
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
    }

    async function moveSelectedScene(destination) {
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
    }

    async function render() {
      if (document.getElementById('screen-plot')?.hidden) return;
      const generation = ++renderGeneration;
      const state = getState();
      if (!selectedChapterId || !state.chapters.some(item => item.id === selectedChapterId)) selectedChapterId = sortedChapters(state)[0]?.id || null;
      if (mode !== 'chapter' && (!selectedEpisodeId || !state.episodeMetas.some(item => item.id === selectedEpisodeId))) selectedEpisodeId = state.activeEpisodeId;
      const selectedMeta = state.episodeMetas.find(item => item.id === selectedEpisodeId);
      if (selectedMeta && !state.chapters.some(item => item.id === selectedMeta.chapterId)) selectedChapterId = sortedChapters(state)[0]?.id || null;
      else if (selectedMeta && mode === 'episode') selectedChapterId = selectedMeta.chapterId;
      const scope = activeScope();
      let scenes = [];
      try { scenes = await ensureBucket(scope); }
      catch (error) { workspace.toast(`シーンを読み込めませんでした：${error.message}`); }
      if (generation !== renderGeneration || document.getElementById('screen-plot')?.hidden) return;
      const currentState = getState();
      const chapters = sortedChapters(currentState), episodes = sortedEpisodes(currentState, selectedChapterId);
      const selectedEpisodeIndex = episodes.findIndex(item => item.id === selectedEpisodeId);
      const selectedChapterIndex = chapters.findIndex(item => item.id === selectedChapterId);
      if (selectedChapterId !== listedChapterId) {
        chapterPage = selectedChapterIndex >= 0 ? Math.floor(selectedChapterIndex / pageSize) : 0;
        listedChapterId = selectedChapterId;
      }
      if (selectedEpisodeId !== listedEpisodeId) {
        if (selectedEpisodeIndex >= 0) episodePage = Math.floor(selectedEpisodeIndex / pageSize);
        listedEpisodeId = selectedEpisodeId;
      }
      if (selectedSceneId && !scenes.some(scene => scene.id === selectedSceneId)) selectedSceneId = null;
      if (!selectedSceneId && scenes.length) selectedSceneId = scenes.slice().sort(byOrder)[scenePage * pageSize]?.id || scenes[0].id;
      const selectedScene = scenes.find(scene => scene.id === selectedSceneId);
      host.className = 'plot-extension-panel'; host.replaceChildren();

      const editor = node('div', 'plot-editor'); editor.id = 'plot-editor';
      const overview = node('section', 'plot-overview'); overview.append(node('h2', '', '作品概要'));
      const summary = makeField('作品概要', currentState.work.summary, value => {
        const latest = getState(); workspace.commit({ ...latest, work: { ...latest.work, summary: value } }, { workId: latest.work.id, work: { ...latest.work, summary: value } }, 'plot:work:summary');
      }, 'textarea', 'plot-overview-text');
      overview.append(summary.label); editor.append(overview);

      const structure = node('div', 'plot-structure');
      const chapterPanel = node('section', 'plot-list-panel'); chapterPanel.append(node('h2', '', '章'));
      chapterPanel.append(makeButton('＋ 章', () => {
        const latest = getState(), list = sortedChapters(latest);
        const chapter = { id: uid('chapter'), workId: latest.work.id, title: `第${list.length + 1}章`, order: list.length };
        commitPatch({ workId: latest.work.id, chapters: { upsert: [chapter], deleteIds: [] } });
        selectedChapterId = chapter.id; selectedEpisodeId = null; mode = 'chapter';
        chapterPage = Math.floor((list.length) / pageSize); episodePage = 0; listedChapterId = null; listedEpisodeId = null; void render();
      }, 'accent'));
      const chapterList = node('div', 'plot-chapter-list');
      chapters.slice(chapterPage * pageSize, (chapterPage + 1) * pageSize).forEach((chapter, index) => {
        const row = node('div', `plot-structure-row${chapter.id === selectedChapterId ? ' selected' : ''}`);
        row.dataset.chapterId = chapter.id;
        row.append(makeButton(chapter.title || '無題の章', () => {
          selectedChapterId = chapter.id; chapterPage = Math.floor(chapters.indexOf(chapter) / pageSize); episodePage = 0;
          const first = sortedEpisodes(getState(), chapter.id)[0];
          if (first) { mode = 'episode'; selectedEpisodeId = first.id; void setScope('episode', first.id, chapter.id); }
          else { mode = 'chapter'; selectedEpisodeId = null; void render(); }
        }, 'plot-select-row'));
        row.append(makeButton('↑', () => moveChapter(chapter.id, -1), 'quiet plot-small-action'));
        row.append(makeButton('↓', () => moveChapter(chapter.id, 1), 'quiet plot-small-action'));
        chapterList.append(row);
      });
      chapterPanel.append(chapterList, pagination('plot-pagination', chapterPage, chapters.length, '章', page => { chapterPage = page; void render(); }));
      const activeChapter = currentState.chapters.find(item => item.id === selectedChapterId);
      if (activeChapter) {
        const title = makeField('章タイトル', activeChapter.title, value => {
          const latest = getState(), record = latest.chapters.find(item => item.id === activeChapter.id);
          commitPatch({ workId: latest.work.id, chapters: { upsert: [{ ...record, title: value }], deleteIds: [] } }, `plot:chapter:${activeChapter.id}:title`);
          const row = [...chapterList.querySelectorAll('.plot-structure-row')].find(item => item.dataset.chapterId === activeChapter.id);
          const button = row?.querySelector('.plot-select-row'); if (button) button.textContent = value || '無題の章';
        });
        chapterPanel.append(title.label);
      }
      structure.append(chapterPanel);

      const episodePanel = node('section', 'plot-list-panel'); episodePanel.append(node('h2', '', '話'));
      episodePanel.append(makeButton('＋ 話', async () => {
        const latest = getState(), parents = sortedEpisodes(latest, selectedChapterId);
        if (!selectedChapterId) { workspace.toast('先に章を追加してください。'); return; }
        const order = Math.max(-1, ...parents.map(item => item.order)) + 1;
        const meta = { id: uid('episode'), workId: latest.work.id, chapterId: selectedChapterId, title: `第${parents.length + 1}話`, order };
        const episode = { ...meta, lines: [{ id: uid('line'), speaker: '', characterId: null, text: '' }] };
        commitPatch({ workId: latest.work.id, episodes: { upsert: [episode], deleteIds: [] } });
        selectedEpisodeId = episode.id; episodePage = Math.floor(parents.length / pageSize); mode = 'episode';
        buckets.set(episode.id, []);
        await workspace.selectEpisode(episode.id);
        await render();
      }, 'accent'));
      const episodeList = node('div', 'plot-episode-list');
      episodes.slice(episodePage * pageSize, (episodePage + 1) * pageSize).forEach(episode => {
        const row = node('div', `plot-structure-row${episode.id === selectedEpisodeId ? ' selected' : ''}`);
        row.dataset.episodeId = episode.id;
        row.append(makeButton(episode.title || '無題の話', () => { void setScope('episode', episode.id, episode.chapterId); }, 'plot-select-row'));
        row.append(makeButton('↑', () => { void moveEpisode(episode.id, -1).catch(error => workspace.toast(`話を並べ替えられませんでした：${error.message}`)); }, 'quiet plot-small-action'));
        row.append(makeButton('↓', () => { void moveEpisode(episode.id, 1).catch(error => workspace.toast(`話を並べ替えられませんでした：${error.message}`)); }, 'quiet plot-small-action'));
        episodeList.append(row);
      });
      episodePanel.append(episodeList, pagination('plot-pagination', episodePage, episodes.length, '話', page => { episodePage = page; void render(); }));
      const activeEpisodeMeta = currentState.episodeMetas.find(item => item.id === selectedEpisodeId);
      if (activeEpisodeMeta) {
        const title = makeField('話タイトル', activeEpisodeMeta.title, value => {
          const latest = getState(), meta = latest.episodeMetas.find(item => item.id === activeEpisodeMeta.id);
          const episode = latest.episodesById[meta.id];
          if (episode) {
            const updated = { ...episode, title: value };
            const next = { ...latest, episodeMetas: latest.episodeMetas.map(item => item.id === meta.id ? { ...item, title: value } : item), episodesById: { ...latest.episodesById, [meta.id]: updated } };
            workspace.commit(next, { workId: latest.work.id, episodes: { upsert: [updated], deleteIds: [] } }, `plot:episode:${meta.id}:title`);
            const row = [...episodeList.querySelectorAll('.plot-structure-row')].find(item => item.dataset.episodeId === meta.id);
            const button = row?.querySelector('.plot-select-row'); if (button) button.textContent = value || '無題の話';
          }
        });
        const chapterRows = chapters.slice(chapterPage * pageSize, (chapterPage + 1) * pageSize);
        if (!chapterRows.some(chapter => chapter.id === selectedChapterId) && selectedChapterId) chapterRows.push(currentState.chapters.find(chapter => chapter.id === selectedChapterId));
        const moveOptions = chapterRows.filter(Boolean).map(chapter => ({ value: chapter.id, label: chapter.title }));
        const chapterSelect = addSelect('話の章', activeEpisodeMeta.chapterId, moveOptions, chapterId => {
          const snapshot = getState(), meta = snapshot.episodeMetas.find(item => item.id === activeEpisodeMeta.id);
          if (!meta || meta.chapterId === chapterId) return;
          void (async () => {
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
          })().catch(error => workspace.toast(`話を移動できませんでした：${error.message}`));
        });
        episodePanel.append(title.label, chapterSelect.label);
      }
      structure.append(episodePanel); editor.append(structure);

      const scenesPanel = node('section', 'plot-scene-panel');
      const sceneHeading = node('div', 'plot-section-heading'); sceneHeading.append(node('h2', '', 'シーン'));
      sceneHeading.append(makeButton('＋ シーン', async () => {
        const latest = getState(), scopeNow = activeScope(), items = await ensureBucket(scopeNow);
        const scene = createScene(latest.work.id, scopeNow, items.length);
        selectedSceneId = scene.id; scenePage = Math.floor(items.length / pageSize); imageOpen = false;
        buckets.set(keyForScope(scopeNow), [...items, scene]);
        commitPatch({ workId: latest.work.id, scenes: { upsert: [scene], deleteIds: [] } });
        await render();
      }, 'accent'));
      const visibleChapterOptions = chapters.slice(chapterPage * pageSize, (chapterPage + 1) * pageSize);
      if (selectedChapterId && !visibleChapterOptions.some(chapter => chapter.id === selectedChapterId)) visibleChapterOptions.push(chapters.find(chapter => chapter.id === selectedChapterId));
      const visibleEpisodeOptions = episodes.slice(episodePage * pageSize, (episodePage + 1) * pageSize);
      if (selectedEpisodeId && !visibleEpisodeOptions.some(episode => episode.id === selectedEpisodeId)) visibleEpisodeOptions.push(episodes.find(episode => episode.id === selectedEpisodeId));
      const scopeOptions = [
        ...visibleChapterOptions.filter(Boolean).map(chapter => ({ value: `chapter:${chapter.id}`, label: `${chapter.title}（章内）` })),
        ...visibleEpisodeOptions.filter(Boolean).map(episode => ({ value: `episode:${episode.id}`, label: `${episode.title}（話）` })),
        { value: 'unassigned', label: '未割当' }
      ];
      const selectedScopeValue = mode === 'episode' ? `episode:${selectedEpisodeId}` : mode === 'chapter' ? `chapter:${selectedChapterId}` : 'unassigned';
      const scopeSelect = addSelect('シーン一覧の範囲', selectedScopeValue, scopeOptions, async value => {
        if (value === 'unassigned') return setScope('unassigned');
        if (value.startsWith('chapter:')) return setScope('chapter', null, value.slice(8));
        const id = value.slice(8), meta = getState().episodeMetas.find(item => item.id === id);
        if (meta) return setScope('episode', id, meta.chapterId);
      });
      sceneHeading.append(scopeSelect.label); scenesPanel.append(sceneHeading);
      scenesPanel.append(node('p', 'plot-scope-label', mode === 'episode' ? activeEpisodeMeta?.title || '話' : mode === 'chapter' ? `${activeChapter?.title || '章'}（話未割当）` : '未割当シーン'));
      const list = node('div', 'plot-scene-list');
      scenes.slice(scenePage * pageSize, (scenePage + 1) * pageSize).forEach((scene, index) => {
        const row = node('div', `plot-scene-row${scene.id === selectedSceneId ? ' selected' : ''}`);
        row.dataset.sceneId = scene.id;
        row.append(makeButton(`シーン ${scene.order + 1}: ${scene.summary || '要約なし'}`, () => { selectedSceneId = scene.id; imageOpen = false; void render(); }, 'plot-select-row'));
        row.append(makeButton('↑', () => {
          const next = reorderScenes(scenes, scene.id, scene.order - 1);
          commitPatch({ workId: getState().work.id, scenes: { upsert: next, deleteIds: [] } }, `plot:scope:${keyForScope(scope)}:order`);
          buckets.set(keyForScope(scope), next); void render();
        }, 'quiet plot-small-action'));
        row.append(makeButton('↓', () => {
          const next = reorderScenes(scenes, scene.id, scene.order + 1);
          commitPatch({ workId: getState().work.id, scenes: { upsert: next, deleteIds: [] } }, `plot:scope:${keyForScope(scope)}:order`);
          buckets.set(keyForScope(scope), next); void render();
        }, 'quiet plot-small-action'));
        list.append(row);
      });
      scenesPanel.append(list, pagination('plot-pagination', scenePage, scenes.length, 'シーン', page => { scenePage = page; selectedSceneId = scenes[page * pageSize]?.id || null; void render(); }));

      if (selectedScene) {
        const detail = node('section', 'plot-detail'); detail.append(node('h3', '', 'シーン詳細'));
        const summary = makeField('シーン要約', selectedScene.summary, value => patchScene({ ...sceneAt(selectedScene.id), summary: value }, `plot:scene:${selectedScene.id}:summary`), 'textarea');
        const purpose = makeField('シーンの目的', selectedScene.purpose, value => patchScene({ ...sceneAt(selectedScene.id), purpose: value }, `plot:scene:${selectedScene.id}:purpose`), 'textarea');
        const characterSearch = node('input'); characterSearch.type = 'search'; characterSearch.setAttribute('aria-label', '人物を検索');
        const characterSearchLabel = node('label', 'plot-field'); characterSearchLabel.append(node('span', '', '人物を検索'), characterSearch);
        const characterOptions = node('select'); characterOptions.setAttribute('aria-label', 'シーンの登場人物');
        const characterOptionPage = node('div', 'plot-character-picker-pages'); let characterPage = 0;
        const previousCharacterPage = makeButton('前の人物候補', () => { characterPage = Math.max(0, characterPage - 1); fillCharacterOptions(); }, 'quiet');
        const characterPageLabel = node('span');
        const nextCharacterPage = makeButton('次の人物候補', () => { characterPage++; fillCharacterOptions(); }, 'quiet');
        characterOptionPage.append(previousCharacterPage, characterPageLabel, nextCharacterPage);
        const fillCharacterOptions = () => {
          const query = characterSearch.value.trim().toLocaleLowerCase('ja');
          const matches = currentState.characters.filter(character => !query || character.name.toLocaleLowerCase('ja').includes(query));
          const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
          characterPage = Math.min(characterPage, pageCount - 1);
          characterOptions.replaceChildren();
          const prompt = node('option', '', matches.length ? '人物を追加…' : '人物が見つかりません'); prompt.value = ''; characterOptions.append(prompt);
          matches.slice(characterPage * pageSize, (characterPage + 1) * pageSize).forEach(character => { const option = node('option', '', character.name || '名前未設定'); option.value = character.id; characterOptions.append(option); });
          characterPageLabel.textContent = `${characterPage + 1} / ${pageCount}`;
          previousCharacterPage.disabled = characterPage <= 0;
          nextCharacterPage.disabled = characterPage >= pageCount - 1;
        };
        fillCharacterOptions(); characterSearch.addEventListener('input', () => { characterPage = 0; fillCharacterOptions(); });
        characterOptions.addEventListener('change', () => {
          const characterId = characterOptions.value;
          if (!characterId || selectedScene.characterIds.includes(characterId)) return;
          patchScene({ ...sceneAt(selectedScene.id), characterIds: [...sceneAt(selectedScene.id).characterIds, characterId] }); void render();
        });
        const characterSelectLabel = node('label', 'plot-field'); characterSelectLabel.append(node('span', '', 'シーンの登場人物'), characterOptions);
        const selectedPeople = node('div', 'plot-character-tags');
        selectedScene.characterIds.forEach(id => {
          const character = currentState.characters.find(item => item.id === id); if (!character) return;
          const tag = node('span', 'plot-character-tag', character.name);
          tag.append(makeButton('×', () => { patchScene({ ...sceneAt(selectedScene.id), characterIds: selectedScene.characterIds.filter(value => value !== id) }); void render(); }, 'quiet'));
          selectedPeople.append(tag);
        });
        const viewpoint = makeField('シーンの視点', selectedScene.viewpoint, value => patchScene({ ...sceneAt(selectedScene.id), viewpoint: value }, `plot:scene:${selectedScene.id}:viewpoint`));
        const location = makeField('シーンの場所', selectedScene.location, value => patchScene({ ...sceneAt(selectedScene.id), location: value }, `plot:scene:${selectedScene.id}:location`));
        const time = makeField('シーンの時間', selectedScene.time, value => patchScene({ ...sceneAt(selectedScene.id), time: value }, `plot:scene:${selectedScene.id}:time`));
        const notes = makeField('シーンメモ', selectedScene.notes, value => patchScene({ ...sceneAt(selectedScene.id), notes: value }, `plot:scene:${selectedScene.id}:notes`), 'textarea');
        detail.append(summary.label, purpose.label, characterSearchLabel, characterSelectLabel, characterOptionPage, selectedPeople, viewpoint.label, location.label, time.label, notes.label);

        if (destinationSceneId !== selectedScene.id) {
          destinationSceneId = selectedScene.id;
          destinationChapterId = selectedScene.chapterId;
          destinationEpisodeId = selectedScene.episodeId;
          const chapterIndex = chapters.findIndex(item => item.id === destinationChapterId);
          destinationChapterPage = chapterIndex >= 0 ? Math.floor(chapterIndex / pageSize) : chapterPage;
          const destinationEpisodes = sortedEpisodes(currentState, destinationChapterId);
          const episodeIndex = destinationEpisodes.findIndex(item => item.id === destinationEpisodeId);
          destinationEpisodePage = episodeIndex >= 0 ? Math.floor(episodeIndex / pageSize) : 0;
        }
        const destinationChapterRows = chapters.slice(destinationChapterPage * pageSize, (destinationChapterPage + 1) * pageSize);
        if (destinationChapterId && !destinationChapterRows.some(item => item.id === destinationChapterId)) {
          const selected = chapters.find(item => item.id === destinationChapterId); if (selected) destinationChapterRows.push(selected);
        }
        const destinationChapter = addSelect('移動先の章', destinationChapterId || '', [
          { value: '', label: '未割当' },
          ...destinationChapterRows.map(chapter => ({ value: chapter.id, label: chapter.title }))
        ], value => { destinationChapterId = value || null; destinationEpisodeId = null; destinationEpisodePage = 0; void render(); });
        const targetEpisodes = sortedEpisodes(currentState, destinationChapterId);
        const targetPageRows = targetEpisodes.slice(destinationEpisodePage * pageSize, (destinationEpisodePage + 1) * pageSize);
        if (destinationEpisodeId && !targetPageRows.some(item => item.id === destinationEpisodeId)) {
          const selected = targetEpisodes.find(item => item.id === destinationEpisodeId); if (selected) targetPageRows.push(selected);
        }
        const destinationEpisode = addSelect('移動先の話', destinationEpisodeId || '', [
          { value: '', label: destinationChapterId ? '章内（話未割当）' : '未割当' },
          ...targetPageRows.map(episode => ({ value: episode.id, label: episode.title }))
        ], value => { destinationEpisodeId = value || null; });
        const movePages = node('div', 'plot-destination-pages');
        movePages.append(makeButton('前の移動先章', () => { destinationChapterPage = Math.max(0, destinationChapterPage - 1); void render(); }, 'quiet'));
        movePages.append(node('span', '', `章 ${destinationChapterPage + 1} / ${Math.max(1, Math.ceil(chapters.length / pageSize))}`));
        movePages.append(makeButton('次の移動先章', () => { destinationChapterPage = Math.min(Math.ceil(chapters.length / pageSize) - 1, destinationChapterPage + 1); void render(); }, 'quiet'));
        const targetEpisodePages = Math.max(1, Math.ceil(targetEpisodes.length / pageSize));
        movePages.append(makeButton('前の移動先話', () => { destinationEpisodePage = Math.max(0, destinationEpisodePage - 1); void render(); }, 'quiet'));
        movePages.append(node('span', '', `話 ${destinationEpisodePage + 1} / ${targetEpisodePages}`));
        movePages.append(makeButton('次の移動先話', () => { destinationEpisodePage = Math.min(targetEpisodePages - 1, destinationEpisodePage + 1); void render(); }, 'quiet'));
        movePages.children[0].disabled = destinationChapterPage <= 0;
        movePages.children[2].disabled = destinationChapterPage >= Math.ceil(chapters.length / pageSize) - 1;
        movePages.children[3].disabled = destinationEpisodePage <= 0;
        movePages.children[5].disabled = destinationEpisodePage >= targetEpisodePages - 1;
        detail.append(destinationChapter.label, destinationEpisode.label, movePages,
          makeButton('割当先へ移動', () => {
            const destination = destinationChapterId ? { chapterId: destinationChapterId, episodeId: destinationEpisodeId } : { chapterId: null, episodeId: null };
            void moveSelectedScene(destination).catch(error => workspace.toast(`シーンを移動できませんでした：${error.message}`));
          }, 'quiet'));
        if (selectedScene.episodeId && state.episodesById[selectedScene.episodeId]) {
          const episode = state.episodesById[selectedScene.episodeId], lines = episode.lines;
          const rangeIndex = id => lines.findIndex(line => line.id === id);
          const startField = makeField('開始行', selectedScene.startLineId ? rangeIndex(selectedScene.startLineId) + 1 : '', () => {});
          const endField = makeField('終了行', selectedScene.endLineId ? rangeIndex(selectedScene.endLineId) + 1 : '', () => {});
          [startField.control, endField.control].forEach(input => { input.type = 'number'; input.min = '1'; input.max = String(lines.length); input.step = '1'; });
          const rangeLabel = node('p', 'plot-scene-range', selectedScene.startLineId && selectedScene.endLineId
            ? `${rangeIndex(selectedScene.startLineId) + 1}–${rangeIndex(selectedScene.endLineId) + 1}行目` : '本文範囲は未設定');
          const setRange = () => {
            if (!startField.control.value || !endField.control.value) return;
            try {
              const updated = setLineRange(sceneAt(selectedScene.id), lines, lines[Number(startField.control.value) - 1]?.id, lines[Number(endField.control.value) - 1]?.id);
              patchScene(updated);
              const start = rangeIndex(updated.startLineId) + 1, end = rangeIndex(updated.endLineId) + 1;
              rangeLabel.textContent = start === end ? `${start}行目` : `${start}–${end}行目`;
            } catch (error) { workspace.toast(error.message); }
          };
          startField.control.addEventListener('input', setRange); endField.control.addEventListener('input', setRange);
          detail.append(node('h4', '', '本文の範囲'), rangeLabel, startField.label, endField.label,
            makeButton('本文範囲を解除', () => { patchScene(clearLineRange(sceneAt(selectedScene.id))); void render(); }, 'quiet'));
        } else {
          detail.append(node('p', 'plot-range-hint', '話を割り当てると本文行の範囲を設定できます。'));
        }

        const imageControls = node('div', 'plot-image-controls');
        imageControls.append(makeButton('参考画像を追加', () => { void addImages(selectedScene); }, 'quiet'));
        imageControls.append(makeButton(imageOpen ? '参考画像を閉じる' : '参考画像を表示', () => { void toggleImages(selectedScene); }, 'quiet'));
        if (selectedScene.imageIds.length) imageControls.append(node('span', '', `${selectedScene.imageIds.length}枚`));
        detail.append(imageControls);
        if (imageOpen) {
          const gallery = node('div', 'plot-image-gallery');
          for (const imageId of selectedScene.imageIds) {
            const image = loadedImages.get(imageId) || getState().imagesById[imageId];
            if (!image?.blob) { gallery.append(node('p', '', '画像を読み込み中…')); continue; }
            const figure = node('figure', 'plot-image-tile');
            if (!imageUrls.has(image.id)) imageUrls.set(image.id, URL.createObjectURL(image.blob));
            const img = node('img', 'plot-image'); img.src = imageUrls.get(image.id); img.alt = image.name; figure.append(img, node('figcaption', '', image.name));
            figure.append(makeButton('画像を削除', () => { void removeImage(sceneAt(selectedScene.id), image.id); }, 'quiet danger'));
            gallery.append(figure);
          }
          detail.append(gallery);
        }
        const clearLink = makeButton('話との割当を解除', () => { void moveSelectedScene({ chapterId: null, episodeId: null }).catch(error => workspace.toast(error.message)); }, 'quiet');
        clearLink.disabled = !selectedScene.episodeId; detail.append(clearLink);
        scenesPanel.append(detail);
      }
      editor.append(scenesPanel); host.append(editor);
    }

    workspace.subscribe(event => {
      if (event.reason === 'package') {
        buckets.clear(); selectedChapterId = null; selectedEpisodeId = event.state.activeEpisodeId; selectedSceneId = null;
        mode = 'episode'; chapterPage = 0; episodePage = 0; scenePage = 0; imageOpen = false; loadedImages.clear(); revokeImages();
      } else if (event.reason === 'episode') {
        selectedEpisodeId = event.state.activeEpisodeId;
        const meta = event.state.episodeMetas.find(item => item.id === selectedEpisodeId);
        if (meta) { selectedChapterId = meta.chapterId; mode = 'episode'; }
        listedChapterId = null; listedEpisodeId = null;
        selectedSceneId = null; scenePage = 0; imageOpen = false; revokeImages();
      } else if (event.reason === 'history') {
        const currentSceneId = selectedSceneId;
        const restoredScene = currentSceneId && Object.values(event.state.scenesByEpisodeId).flat().find(scene => scene.id === currentSceneId);
        buckets.clear(); loadedImages.clear(); imageOpen = false; revokeImages();
        if (restoredScene) {
          selectedSceneId = restoredScene.id;
          scenePage = Math.floor(restoredScene.order / pageSize);
          if (restoredScene.episodeId) {
            mode = 'episode'; selectedEpisodeId = restoredScene.episodeId; selectedChapterId = restoredScene.chapterId;
          } else if (restoredScene.chapterId) {
            mode = 'chapter'; selectedChapterId = restoredScene.chapterId;
          } else mode = 'unassigned';
        } else {
          selectedSceneId = null;
          if (event.state.activeEpisodeId !== selectedEpisodeId) {
            selectedEpisodeId = event.state.activeEpisodeId;
            const meta = event.state.episodeMetas.find(item => item.id === selectedEpisodeId);
            if (meta) { selectedChapterId = meta.chapterId; mode = 'episode'; }
            scenePage = 0; listedChapterId = null; listedEpisodeId = null;
          }
        }
      }
      if (event.reason === 'screen' && document.getElementById('screen-plot')?.hidden) {
        imageOpen = false; loadedImages.clear(); revokeImages();
      }
      if (!document.getElementById('screen-plot')?.hidden) void render();
    });
    root.NovelPlot.openScene = openScene;
  }

  const api = { createScene, scopeKey, reorderScenes, moveBetweenScopes, setLineRange, clearLineRange, detachImage, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelPlot = api;
})(globalThis);

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => globalThis.NovelPlot?.mount());
