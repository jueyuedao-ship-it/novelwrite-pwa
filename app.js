(() => {
  'use strict';
  const C = NovelCore;
  const M = NovelModel;
  const E = NovelEditorState;
  const $ = id => document.getElementById(id);
  const RECOVERY_KEY = 'fumizukue.recovery.v1';
  const MAX_LEGACY_JSON_BYTES = 384 * 1024 * 1024;

  function indexOf(work) {
    return { work: { schemaVersion: work.schemaVersion, id: work.id, title: work.title, summary: work.summary }, chapters: work.chapters, episodes: work.episodes.map(({ id, workId, chapterId, title, order }) => ({ id, workId, chapterId, title, order })), characters: work.characters };
  }
  function orderedEpisodeMetas(state) {
    const chapterRanks = new Map(state.chapters.slice().sort((left, right) => left.order - right.order).map((chapter, index) => [chapter.id, index]));
    return state.episodeMetas.slice().sort((left, right) =>
      (chapterRanks.get(left.chapterId) ?? Number.MAX_SAFE_INTEGER) - (chapterRanks.get(right.chapterId) ?? Number.MAX_SAFE_INTEGER)
      || left.order - right.order || left.id.localeCompare(right.id));
  }
  function stateFromFull(value, episodeId = value.work.episodes[0].id) {
    const episode = value.work.episodes.find(item => item.id === episodeId) || value.work.episodes[0];
    const scenes = value.work.scenes.filter(scene => scene.episodeId === episode.id);
    return E.createState(indexOf(value.work), episode, scenes, []);
  }
  const blankPackage = { work: M.createWork(), images: [] };
  const history = new C.History(stateFromFull(blankPackage));
  let db = null, dbError = '', bootError = '';
  let selectedEpisodeId = history.present.activeEpisodeId;
  let activeScreen = 'manuscript', activeScene = null;
  let range = [history.present.episodesById[selectedEpisodeId].lines[0].id, history.present.episodesById[selectedEpisodeId].lines[0].id];
  let composingElement = null, busy = false, pendingImageLoads = 0;
  let episodeLoadGeneration = 0;
  let saveRevision = 1, savedRevision = 0, saveTimer = null, saveInFlight = false, savePromise = null, activeChanges = null, replacingPackage = false, saveError = '';
  let pendingChanges = null, toastTimer = null, backupTimestamp = '';
  let lastRendered = null, lastRenderedEpisodeId = null;
  const rowNodes = new Map(), sceneNodes = new Map(), imageUrls = new Map();
  const inputStates = new WeakMap(), imageInputs = new WeakMap();
  const workspaceSubscribers = new Set();

  const currentState = () => history.present;
  const episodeSceneKey = episodeId => E.episodeSceneKey(episodeId);
  const scenesForEpisode = (state, episodeId) => state.scenesByEpisodeId[episodeSceneKey(episodeId)] || [];
  function publishWorkspace(reason) {
    const event = { reason, state: currentState() };
    workspaceSubscribers.forEach(listener => {
      try { listener(event); } catch (error) { console.error('画面の更新に失敗しました。', error); }
    });
  }
  const currentWork = () => E.currentWork(currentState());
  const currentEpisode = () => currentState().episodesById[selectedEpisodeId] || currentState().episodesById[currentState().activeEpisodeId];
  const currentEpisodeView = () => E.episodeView({ ...currentState(), activeEpisodeId: selectedEpisodeId });
  const currentScenes = () => scenesForEpisode(currentState(), selectedEpisodeId);
  const textOf = node => node.value;
  const setValue = (node, value) => { if (node.value !== value) node.value = value; };
  const mapById = items => Object.fromEntries(items.map(item => [item.id, item]));

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className, handler, label) {
    const node = element('button', className, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', handler);
    return node;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
  }
  function choose(title, message, options) {
    return new Promise(resolve => {
      const dialog = $('dialog');
      $('dialog-title').textContent = title;
      $('dialog-message').textContent = message;
      $('dialog-options').replaceChildren();
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        dialog.removeEventListener('cancel', cancel);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const cancel = event => { event.preventDefault(); finish(null); };
      dialog.addEventListener('cancel', cancel);
      options.forEach(option => $('dialog-options').append(button(option.label, option.className || '', () => finish(option.value))));
      dialog.showModal();
    });
  }
  function filename(name) {
    return (name || '無題').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || '無題';
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function downloadText(text, name) { download(new Blob([text], { type: 'text/plain;charset=utf-8' }), name); }

  function paintSaveStatus() {
    const status = $('save-status');
    status.className = '';
    if (dbError) { status.textContent = `保存先を利用できません：${dbError}`; status.classList.add('save-error'); }
    else if (saveError) { status.textContent = `保存できません：${saveError}`; status.classList.add('save-error'); }
    else if (saveInFlight) { status.textContent = '保存中…'; status.classList.add('save-pending'); }
    else if (saveTimer) { status.textContent = '保存待ち…'; status.classList.add('save-pending'); }
    else if (savedRevision >= saveRevision) { status.textContent = backupTimestamp ? `保存済み · ${backupTimestamp}` : '保存済み'; status.classList.add('save-success'); }
    else { status.textContent = '未保存の変更あり'; status.classList.add('save-pending'); }
  }
  function beginImageLoad() {
    pendingImageLoads++;
    paintSaveStatus();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingImageLoads--;
      if (pendingChanges && !saveError) scheduleSave(0);
      paintSaveStatus();
    };
  }
  function scheduleSave(delay = 350) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (replacingPackage) { paintSaveStatus(); return; }
    saveTimer = setTimeout(() => { saveTimer = null; void startPersistChanges(); }, delay);
    paintSaveStatus();
  }
  async function persistChanges() {
    if (!db || saveInFlight || replacingPackage || !pendingChanges || composingElement || pendingImageLoads) return;
    const revision = saveRevision, patch = pendingChanges;
    pendingChanges = null;
    activeChanges = patch;
    saveInFlight = true; saveError = ''; paintSaveStatus();
    try {
      await NovelStorage.saveChanges(db, patch);
      savedRevision = Math.max(savedRevision, revision);
      if (revision === saveRevision) { backupTimestamp = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }); saveError = ''; }
    } catch (error) {
      pendingChanges = E.mergeChanges(patch, pendingChanges);
      if (revision === saveRevision) saveError = error?.message || '作品データを書き込めませんでした。';
    } finally {
      saveInFlight = false;
      activeChanges = null;
      paintSaveStatus();
      if (pendingChanges && !saveError && !replacingPackage) scheduleSave(0);
    }
  }
  function startPersistChanges() {
    if (savePromise) return savePromise;
    const operation = persistChanges();
    const tracked = operation.finally(() => { if (savePromise === tracked) savePromise = null; });
    savePromise = tracked;
    return tracked;
  }
  function patchHasChanges(patch) {
    return Boolean(patch?.work || ['chapters', 'episodes', 'scenes', 'characters', 'images'].some(name =>
      patch?.[name]?.upsert?.length || patch?.[name]?.deleteIds?.length));
  }
  function changed(nextState, key = null, explicitPatch = null) {
    if (replacingPackage) return false;
    const patch = E.mergeChanges(E.diffChanges(currentState(), nextState), explicitPatch);
    if (!patchHasChanges(patch)) return false;
    episodeLoadGeneration++;
    pendingChanges = E.mergeChanges(pendingChanges, patch);
    history.push(nextState, key);
    saveRevision++;
    saveError = '';
    render();
    scheduleSave();
    return true;
  }
  function commitWorkspace(nextState, patch = null, historyKey = null) {
    if (!nextState || !nextState.work || !nextState.episodesById || !nextState.scenesByEpisodeId) {
      throw new Error('commitにはNovelEditorStateの部分状態を渡してください。');
    }
    return changed(E.applyPatch(nextState, patch), historyKey, patch);
  }
  function loadedState(state, episode, scenes, images) {
    return E.activateEpisode(state, episode, scenes, images);
  }
  function sceneUpdate(id, values, key = null) {
    const state = currentState(), scenes = currentScenes();
    const next = { ...state, scenesByEpisodeId: { ...state.scenesByEpisodeId, [episodeSceneKey(selectedEpisodeId)]: scenes.map(scene => scene.id === id ? { ...scene, ...values } : scene) } };
    changed(next, key);
  }
  function switchScreen(name) {
    if (!['manuscript', 'plot', 'characters'].includes(name)) return;
    if (name !== 'manuscript') releaseSceneImages(selectedEpisodeId);
    history.boundary(); activeScreen = name;
    for (const [key, tabId, panelId] of [['manuscript', 'tab-manuscript', 'screen-manuscript'], ['plot', 'tab-plot', 'screen-plot'], ['characters', 'tab-characters', 'screen-characters']]) {
      const selected = key === name;
      $(tabId).setAttribute('aria-selected', String(selected));
      $(tabId).classList.toggle('active', selected);
      $(panelId).hidden = !selected;
    }
    $('sidebar').hidden = name !== 'manuscript';
    if (name === 'manuscript') render(true);
    publishWorkspace('screen');
  }
  function updateSpeakers() {
    const names = [...new Set(['地の文', 'システム', ...currentState().characters.map(character => character.name).filter(Boolean), ...Object.values(currentState().episodesById).flatMap(episode => episode.lines.map(line => line.speaker)).filter(Boolean)])];
    $('speakers').replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
  }
  function selectionIndexes() {
    const episode = currentEpisodeView();
    const a = episode.lines.findIndex(line => line.id === range[0]), b = episode.lines.findIndex(line => line.id === range[1]);
    if (a < 0 || b < 0) return [0, 0];
    return [Math.min(a, b), Math.max(a, b)];
  }
  function updateHighlights() {
    const episode = currentEpisodeView(), [start, end] = selectionIndexes();
    const active = episode.scenes.find(scene => scene.id === activeScene);
    const activeStart = active ? episode.lines.findIndex(line => line.id === active.startLineId) : -1;
    const activeEnd = active ? episode.lines.findIndex(line => line.id === active.endLineId) : -1;
    episode.lines.forEach((line, index) => {
      const row = rowNodes.get(line.id); if (!row) return;
      row.classList.toggle('selected', index >= start && index <= end);
      row.classList.toggle('in-scene', activeStart >= 0 && index >= activeStart && index <= activeEnd);
      row.querySelector('input[type=checkbox]').checked = index >= start && index <= end;
    });
    const indexes = new Map(episode.lines.map((line, index) => [line.id, index]));
    episode.scenes.forEach(scene => {
      const card = sceneNodes.get(scene.id); if (!card) return;
      card.classList.toggle('active', scene.id === activeScene);
      card.classList.toggle('related', scene.startLineId !== null && indexes.get(scene.startLineId) <= end && indexes.get(scene.endLineId) >= start);
    });
    $('selection-label').textContent = start === end ? `${start + 1}行目を選択中` : `${start + 1}–${end + 1}行目を選択中（${end - start + 1}行）`;
  }
  function selectRange(startId, endId) {
    const lines = currentEpisodeView().lines;
    const a = lines.findIndex(line => line.id === startId), b = lines.findIndex(line => line.id === endId);
    const low = Math.max(0, Math.min(a, b)), high = Math.max(0, Math.max(a, b));
    range = [lines[low].id, lines[high].id]; activeScene = null; updateHighlights();
  }
  function focusCaret(position, source = 'detail') {
    if (source === 'preview') {
      const input = $('preview'); input.focus({ preventScroll: true }); input.setSelectionRange(position, position); return;
    }
    const episode = currentEpisodeView(), location = C.locate(episode, position), line = episode.lines[location.index];
    const input = rowNodes.get(line.id)?.querySelector('.line-text');
    if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(location.column, location.column); input.scrollIntoView({ block: 'nearest' }); }
  }
  async function applyText(start, end, insert, source, key, caretOverride) {
    if (busy) return false;
    let episode = currentEpisodeView(), result = C.replaceText(episode, start, end, insert);
    if (result.conflict) {
      busy = true; render(true);
      const options = result.conflict.filter(Boolean).map(name => ({ label: name, value: name }));
      options.push({ label: '未設定', value: '' }, { label: '結合を取り消す', value: null });
      const choice = await choose('結合後の人物名', '異なる人物名の行が1行になります。残す人物名を選んでください。シーン説明は保持されます。', options);
      busy = false;
      if (choice === null) { render(true); focusCaret(start, source); return false; }
      episode = currentEpisodeView(); result = C.replaceText(episode, start, end, insert, choice); key = null;
    }
    const structural = result.chapter.lines.length !== episode.lines.length || result.chapter.lines.some((line, index) => line.id !== episode.lines[index]?.id);
    changed(E.replaceEpisodeView(currentState(), result.chapter), structural ? null : key);
    if (structural || source === 'preview') focusCaret(caretOverride ?? result.caret, source);
    return true;
  }
  function bindTextEditor(input, lineId = null) {
    input.addEventListener('beforeinput', event => {
      if (busy) { event.preventDefault(); return; }
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        if (event.cancelable) { event.preventDefault(); travel(event.inputType === 'historyUndo' ? 'undo' : 'redo'); }
        return;
      }
      if (!composingElement) inputStates.set(input, { oldText: input.value, start: input.selectionStart, end: input.selectionEnd, inputType: event.inputType });
    });
    input.addEventListener('compositionstart', () => {
      composingElement = input;
      inputStates.set(input, { oldText: input.value, start: input.selectionStart, end: input.selectionEnd, inputType: 'insertCompositionText' });
      history.boundary();
    });
    const finish = () => {
      const episode = currentEpisodeView(), index = lineId ? episode.lines.findIndex(line => line.id === lineId) : -1;
      if (lineId && index < 0) return;
      const expected = lineId ? episode.lines[index].text : C.fullText(episode), after = C.normalize(input.value), state = inputStates.get(input);
      inputStates.delete(input);
      const diff = C.difference(expected, after, state?.oldText === expected ? state : undefined);
      if (!diff) return;
      const base = lineId ? C.offsets(episode)[index] : 0, caret = base + input.selectionStart;
      void applyText(base + diff.start, base + diff.end, diff.insert, lineId ? 'detail' : 'preview', `text:${episode.id}:${lineId || 'preview'}`, caret);
    };
    input.addEventListener('input', event => { if (!event.isComposing && composingElement !== input) finish(); });
    input.addEventListener('compositionend', () => { composingElement = null; finish(); history.boundary(); });
    input.addEventListener('blur', () => history.boundary());
    if (lineId) {
      input.addEventListener('focus', () => { const [a, b] = selectionIndexes(); if (a === b) selectRange(lineId, lineId); });
      input.addEventListener('keydown', event => {
        if (event.isComposing || composingElement || busy || event.ctrlKey || event.metaKey || event.altKey) return;
        const episode = currentEpisodeView(), index = episode.lines.findIndex(line => line.id === lineId);
        if (index < 0 || input.selectionStart !== input.selectionEnd) return;
        const base = C.offsets(episode)[index];
        if (event.key === 'Backspace' && input.selectionStart === 0 && index > 0) { event.preventDefault(); void applyText(base - 1, base, '', 'detail', null); }
        else if (event.key === 'Delete' && input.selectionEnd === input.value.length && index < episode.lines.length - 1) {
          event.preventDefault(); const end = base + input.value.length; void applyText(end, end + 1, '', 'detail', null);
        }
      });
    }
  }
  function characterIdForName(name) {
    const matches = currentState().characters.filter(character => character.name.trim() === name.trim());
    return matches.length === 1 ? matches[0].id : null;
  }
  function updateSpeaker(lineId, value, key) {
    const episode = currentEpisodeView();
    changed(E.replaceEpisodeView(currentState(), { ...episode, lines: episode.lines.map(line => line.id === lineId ? { ...line, speaker: value, characterId: characterIdForName(value) } : line) }), key);
  }
  function createRow(line) {
    const row = element('div', 'editor-row'); row.dataset.lineId = line.id;
    const speakerCell = element('div', 'speaker-cell'), marker = element('label', 'row-marker'), number = element('span', 'row-number');
    const check = document.createElement('input'); check.type = 'checkbox'; check.addEventListener('click', event => selectRange(event.shiftKey ? range[0] : line.id, line.id));
    marker.append(number, check);
    const speaker = element('input', 'speaker-input'); speaker.setAttribute('list', 'speakers'); speaker.placeholder = '人物名';
    let speakerComposing = false;
    const update = () => {
      const old = currentEpisodeView().lines.find(item => item.id === line.id);
      if (old && old.speaker !== speaker.value) updateSpeaker(line.id, speaker.value, `speaker:${line.id}`);
    };
    const finish = () => {
      if (speakerComposing) return;
      updateSpeakers(); history.boundary();
    };
    speaker.addEventListener('compositionstart', () => { speakerComposing = true; composingElement = speaker; });
    speaker.addEventListener('compositionend', () => { speakerComposing = false; composingElement = null; update(); });
    speaker.addEventListener('input', () => { if (!speakerComposing) update(); });
    speaker.addEventListener('blur', finish);
    speaker.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && !speakerComposing && event.keyCode !== 229) { event.preventDefault(); finish(); } });
    const characterReference = button('人物設定 ↗', 'speaker-character-reference', () => {
      const current = currentEpisodeView().lines.find(item => item.id === line.id);
      if (current?.characterId) showCharacterReference(current.characterId);
    }, `人物設定を開く：${line.speaker || '人物'}`);
    characterReference.hidden = !line.characterId;
    speakerCell.append(marker, speaker, characterReference);
    const body = element('div', 'body-cell'), text = element('textarea', 'line-text');
    text.rows = 1; text.spellcheck = false; text.placeholder = '本文を入力…'; bindTextEditor(text, line.id);
    const actions = element('div', 'row-actions');
    actions.append(button('開始行に指定', '', () => selectRange(line.id, range[1])));
    actions.append(button('終了行に指定', '', () => selectRange(range[0], line.id)));
    actions.append(button('シーンへ ↗', '', () => {
      const episode = currentEpisodeView(), index = episode.lines.findIndex(item => item.id === line.id);
      const scene = episode.scenes.find(item => item.startLineId !== null && episode.lines.findIndex(value => value.id === item.startLineId) <= index && episode.lines.findIndex(value => value.id === item.endLineId) >= index);
      if (!scene) return toast('この行に紐づくシーン説明はありません。');
      showScenes(true); activeScene = scene.id; updateHighlights(); sceneNodes.get(scene.id)?.scrollIntoView({ block: 'nearest' });
    }));
    body.append(text, actions); row.append(speakerCell, body); return row;
  }
  function renderRows(episode, force) {
    const alive = new Set(episode.lines.map(line => line.id));
    for (const [id, row] of rowNodes) if (!alive.has(id)) { row.remove(); rowNodes.delete(id); }
    const oldLines = new Map((lastRenderedEpisodeId === episode.id ? lastRendered?.lines || [] : []).map(line => [line.id, line]));
    const sizing = [];
    episode.lines.forEach((line, index) => {
      let row = rowNodes.get(line.id), fresh = !row;
      if (fresh) { row = createRow(line); rowNodes.set(line.id, row); }
      if ($('lines').children[index] !== row) $('lines').insertBefore(row, $('lines').children[index] || null);
      const number = String(index + 1).padStart(2, '0');
      if (row.querySelector('.row-number').textContent !== number) {
        row.querySelector('.row-number').textContent = number;
        row.querySelector('input[type=checkbox]').setAttribute('aria-label', `${index + 1}行目を選択`);
      }
      const speaker = row.querySelector('.speaker-input'), text = row.querySelector('.line-text');
      speaker.setAttribute('aria-label', `${index + 1}行目の人物名`); text.setAttribute('aria-label', `${index + 1}行目の本文`);
      const characterReference = row.querySelector('.speaker-character-reference');
      characterReference.hidden = !line.characterId;
      characterReference.setAttribute('aria-label', `人物設定を開く：${line.speaker || '人物'}`);
      if (force || fresh || oldLines.get(line.id) !== line) {
        if (composingElement !== speaker) setValue(speaker, line.speaker);
        if (composingElement !== text) setValue(text, line.text);
        sizing.push(text);
      }
    });
    sizing.forEach(input => { input.style.height = 'auto'; });
    if (!CSS.supports('field-sizing', 'content')) {
      const heights = sizing.map(input => Math.min(500, Math.max(58, input.scrollHeight + 2)));
      sizing.forEach((input, index) => { input.style.height = `${heights[index]}px`; });
    }
  }
  function currentImageRecords(scene) {
    return scene.imageIds.map(id => currentState().imagesById[id]);
  }
  function getImageUrl(id) {
    if (imageUrls.has(id)) return imageUrls.get(id);
    const image = currentState().imagesById[id];
    if (!image?.blob) return '';
    const url = URL.createObjectURL(image.blob); imageUrls.set(id, url); return url;
  }
  function syncImageUrls() {
    const activeIds = new Set(Object.keys(currentState().imagesById));
    for (const [id, url] of imageUrls) if (!activeIds.has(id)) { URL.revokeObjectURL(url); imageUrls.delete(id); }
  }
  function openImage(image) {
    $('image-dialog-title').textContent = image.referenceNumber ? `画像${image.referenceNumber} — ${image.name}` : image.name;
    $('image-preview').alt = image.name; $('image-preview').src = getImageUrl(image.id); $('image-dialog').showModal();
  }
  function setScene(sceneId, updater, key = null) {
    const state = currentState(), scenes = currentScenes().map(scene => scene.id === sceneId ? updater(scene) : scene);
    changed({ ...state, scenesByEpisodeId: { ...state.scenesByEpisodeId, [episodeSceneKey(selectedEpisodeId)]: scenes } }, key);
  }
  function removeSceneImage(sceneId, imageId) {
    const state = currentState(), scene = currentScenes().find(item => item.id === sceneId);
    if (!scene) return;
    const updatedScene = { ...scene, imageIds: scene.imageIds.filter(id => id !== imageId) };
    const reindexedImages = [];
    const imagesById = { ...state.imagesById }; delete imagesById[imageId];
    for (const [order, id] of updatedScene.imageIds.entries()) {
      const image = imagesById[id];
      if (!image) { toast('シーン画像を読み込めないため削除できません。'); return; }
      if (image.order !== order) {
        imagesById[id] = { ...image, order };
        reindexedImages.push(imagesById[id]);
      }
    }
    const scenes = currentScenes().map(item => item.id === sceneId ? updatedScene : item);
    changed({ ...state, scenesByEpisodeId: { ...state.scenesByEpisodeId, [episodeSceneKey(selectedEpisodeId)]: scenes }, imagesById }, null, {
      workId: state.work.id,
      scenes: { upsert: [updatedScene], deleteIds: [] },
      images: { upsert: reindexedImages, deleteIds: [imageId] }
    });
    syncImageUrls();
  }
  function setImageGalleryMessage(view, message) {
    view.message = message;
    view.signature = '';
    view.gallery.replaceChildren(element('p', 'image-gallery-message', message));
    view.gallery.hidden = false;
    view.section.classList.remove('closed');
  }
  async function loadSceneImages(sceneId, episodeId, view) {
    const state = currentState(), scene = scenesForEpisode(state, episodeId).find(item => item.id === sceneId);
    if (!scene) { setImageGalleryMessage(view, 'シーン情報を読み込めません。'); return false; }
    const missingIds = scene.imageIds.filter(id => !state.imagesById[id]?.blob);
    if (!missingIds.length) return true;
    const workId = state.work.id;
    pendingImageLoads++; view.reading = true; refreshImageAdd(view.section); paintSaveStatus();
    try {
      const loaded = await Promise.all(missingIds.map(id => NovelStorage.loadImage(db, id)));
      const missing = missingIds.filter((_, index) => !loaded[index]);
      if (missing.length) {
        setImageGalleryMessage(view, `${missing.length}枚の画像本体が保存先に見つかりません。ZIPバックアップから復元してください。`);
        toast('シーンの画像データが欠損しています。');
        return false;
      }
      if (currentWork().id !== workId || !scenesForEpisode(currentState(), episodeId).some(item => item.id === sceneId)) return false;
      const imagesById = { ...currentState().imagesById };
      loaded.forEach(image => { imagesById[image.id] = image; });
      history.present = { ...currentState(), imagesById };
      view.message = '';
      return true;
    } catch (error) {
      const message = /画像情報または画像Blob/.test(error?.message || '')
        ? `画像本体が欠損しています。ZIPバックアップから復元してください。`
        : `画像本体を読み込めません：${error?.message || error}`;
      setImageGalleryMessage(view, message);
      toast('シーンの画像データを読み込めませんでした。');
      return false;
    } finally {
      pendingImageLoads--; view.reading = false; refreshImageAdd(view.section); paintSaveStatus();
    }
  }
  async function toggleSceneImages(sceneId, episodeId, section) {
    const view = imageInputs.get(section);
    if (!view) return;
    if (view.open) {
      view.open = false; view.message = ''; view.signature = '';
      for (const image of currentImageRecords(scenesForEpisode(currentState(), episodeId).find(scene => scene.id === sceneId) || { imageIds: [] })) {
        if (!image) continue;
        const url = imageUrls.get(image.id);
        if (url) { URL.revokeObjectURL(url); imageUrls.delete(image.id); }
      }
      renderImages(section, scenesForEpisode(currentState(), episodeId).find(scene => scene.id === sceneId));
      return;
    }
    view.open = true; view.message = ''; view.signature = '';
    const ready = await loadSceneImages(sceneId, episodeId, view);
    if (ready) renderImages(section, scenesForEpisode(currentState(), episodeId).find(scene => scene.id === sceneId));
  }
  function releaseSceneImages(episodeId) {
    const state = currentState();
    const scenes = scenesForEpisode(state, episodeId);
    for (const scene of scenes) {
      const section = sceneNodes.get(scene.id)?.querySelector('.image-section');
      const view = section && imageInputs.get(section);
      if (view) { view.open = false; view.message = ''; view.signature = ''; }
      scene.imageIds.forEach(id => {
        const url = imageUrls.get(id);
        if (url) { URL.revokeObjectURL(url); imageUrls.delete(id); }
      });
    }
  }
  async function validateImageFile(file) {
    if (file.size > C.MAX_IMAGE_BYTES) throw new Error(`「${file.name}」は10MBを超えています。`);
    const ext = file.name.split('.').at(-1).toLowerCase();
    const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    const mimeType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) ? file.type : extensions[ext];
    if (!mimeType) throw new Error('PNG・JPEG・WebP・GIFの画像を選んでください。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blob = new Blob([bytes], { type: mimeType });
    try { await NovelPackage.validateImageBlob(mimeType, blob); }
    catch { throw new Error(`「${file.name}」の画像形式と内容が一致しません。`); }
    const preview = URL.createObjectURL(blob), image = new Image(); image.src = preview;
    try { await image.decode(); if (!image.naturalWidth || !image.naturalHeight) throw new Error('empty'); }
    catch { throw new Error(`「${file.name}」を表示できません。破損していない画像を選んでください。`); }
    finally { URL.revokeObjectURL(preview); image.removeAttribute('src'); }
    return { id: C.uid('image'), name: file.name, mimeType, blob };
  }
  async function addSceneImages(sceneId, episodeId, files) {
    const state = currentState(), scene = scenesForEpisode(state, episodeId).find(item => item.id === sceneId);
    if (!scene) throw new Error('画像の追加先がありません。');
    const records = [];
    for (const file of files) records.push(await validateImageFile(file));
    const latest = currentState(), latestScene = scenesForEpisode(latest, episodeId).find(item => item.id === sceneId);
    if (!latestScene) throw new Error('画像の追加先がありません。');
    let number = latestScene.nextImageNumber;
    const metadata = records.map((record, index) => ({
      id: record.id, workId: latest.work.id, ownerType: 'scene', ownerId: sceneId,
      order: latestScene.imageIds.length + index, name: record.name, mimeType: record.mimeType, referenceNumber: number++
    }));
    const scenes = scenesForEpisode(latest, episodeId).map(item => item.id === sceneId ? {
      ...item, imageIds: [...item.imageIds, ...metadata.map(image => image.id)], nextImageNumber: number
    } : item);
    const imagesById = { ...latest.imagesById };
    metadata.forEach((image, index) => { imagesById[image.id] = { ...image, blob: records[index].blob }; });
    changed({ ...latest, scenesByEpisodeId: { ...latest.scenesByEpisodeId, [episodeSceneKey(episodeId)]: scenes }, imagesById });
  }
  function refreshImageAdd(section) {
    const view = imageInputs.get(section); if (!view) return;
    const scene = scenesForEpisode(currentState(), view.episodeId).find(item => item.id === view.sceneId);
    view.add.disabled = view.reading || !scene;
    view.add.textContent = view.reading ? '画像を読み込み中…' : `＋ 画像${scene?.nextImageNumber || 1}を追加`;
    view.toggle.disabled = view.reading || !scene;
    view.toggle.textContent = view.open ? '画像を閉じる' : `画像を表示（${scene?.imageIds.length || 0}）`;
    view.toggle.setAttribute('aria-label', view.open ? '参考画像を閉じる' : '参考画像を表示');
    section.classList.toggle('closed', !view.open);
  }
  function renderImages(section, scene) {
    const view = imageInputs.get(section); if (!view) return;
    refreshImageAdd(section);
    if (!view.open) { view.gallery.hidden = true; return; }
    view.gallery.hidden = false;
    if (view.message) return;
    if (!scene) {
      setImageGalleryMessage(view, 'シーン情報を読み込めません。');
      return;
    }
    const images = currentImageRecords(scene);
    const missing = images.filter(image => !image).length;
    if (missing && !view.reading) {
      setImageGalleryMessage(view, `${missing}枚の画像本体が欠損しています。ZIPバックアップから復元してください。`);
      return;
    }
    const signature = scene.imageIds.map((id, index) => `${id}:${images[index]?.referenceNumber ?? 'pending'}`).join('|');
    if (view.signature === signature) return;
    view.signature = signature;
    view.gallery.replaceChildren(...images.map(image => {
      if (!image) return element('p', 'image-gallery-message', '画像本体を読み込み中…');
      const figure = element('figure', 'image-tile');
      const reference = `画像${image.referenceNumber}`;
      const heading = element('div', 'image-reference-heading');
      heading.append(element('strong', 'image-reference-number', reference));
      heading.append(button('説明に挿入', 'image-reference-insert', () => {
        if (busy || composingElement) return;
        const input = sceneNodes.get(scene.id)?.querySelector('.scene-description'); if (!input) return;
        const start = input.selectionStart, end = input.selectionEnd;
        const text = input.value.slice(0, start) + reference + input.value.slice(end);
        history.boundary(); setScene(scene.id, current => ({ ...current, summary: text })); history.boundary();
        input.focus({ preventScroll: true }); input.setSelectionRange(start + reference.length, start + reference.length);
      }, `${reference}を説明に挿入`));
      const thumb = button('', 'image-thumb', () => openImage(image), `画像を拡大：${reference}：${image.name}`);
      const picture = document.createElement('img'); picture.src = getImageUrl(image.id); picture.alt = image.name; picture.loading = 'lazy'; picture.decoding = 'async'; thumb.append(picture);
      const caption = element('figcaption'); caption.append(element('span', 'image-name', image.name));
      caption.append(button('削除', 'image-remove', () => removeSceneImage(scene.id, image.id), `画像を削除：${image.name}`));
      figure.append(heading, thumb, caption); return figure;
    }));
  }
  function makeImageSection(scene) {
    const section = element('div', 'image-section'), header = element('div', 'image-section-header');
    const add = button('', 'image-add', () => { if (!busy) input.click(); });
    const toggle = button('画像を表示（0）', 'image-toggle', () => void toggleSceneImages(scene.id, scene.episodeId, section), '参考画像を表示');
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.accept = '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif'; input.hidden = true;
    input.setAttribute('aria-label', 'シーンの画像ファイル');
    const gallery = element('div', 'image-gallery');
    const help = element('p', 'image-help', 'PNG・JPEG・WebP・GIF / 1枚10MBまで。画像はZIPバックアップに含まれます。');
    const guide = element('p', 'image-reference-guide', '「画像2が画像1に攻撃している」のように説明できます。番号はこのシーン内で固定され、削除しても詰め直しません。');
    header.append(element('span', '', '参考画像'), toggle, add); section.append(header, gallery, help, guide, input);
    imageInputs.set(section, { section, sceneId: scene.id, episodeId: scene.episodeId, add, toggle, gallery, input, signature: '', open: false, message: '' });
    input.addEventListener('change', async () => {
      const files = [...input.files]; input.value = ''; if (!files.length || busy) return;
      const episodeId = selectedEpisodeId, workId = currentWork().id;
      pendingImageLoads++; const view = imageInputs.get(section); view.reading = true; refreshImageAdd(section); paintSaveStatus();
      try {
        if (files.length + scene.nextImageNumber > Number.MAX_SAFE_INTEGER) throw new Error('画像番号の上限に達しました。');
        if (workId !== currentWork().id) throw new Error('作品が切り替わりました。');
        view.open = true; view.message = ''; view.signature = '';
        await addSceneImages(scene.id, episodeId, files);
        toast(`${files.length}枚の参考画像を追加しました。`);
      } catch (error) { toast(`画像を追加できませんでした：${error.message}`); }
      finally { pendingImageLoads--; view.reading = false; refreshImageAdd(section); if (pendingChanges && !saveError) scheduleSave(0); }
    });
    refreshImageAdd(section); return section;
  }
  function showReferencePanel(title, fields) {
    const dialog = $('reference-panel'), body = $('reference-panel-body'), list = element('dl', 'reference-panel-fields');
    $('reference-panel-title').textContent = title || '参照設定';
    for (const [label, value] of fields) {
      const row = element('div', 'reference-panel-field');
      row.append(element('dt', '', label), element('dd', '', value || '未設定'));
      list.append(row);
    }
    body.replaceChildren(list);
    if (!dialog.open) dialog.showModal();
  }
  function showCharacterReference(characterId) {
    const character = currentState().characters.find(item => item.id === characterId);
    if (!character) { toast('人物設定が見つかりません。'); return; }
    const custom = character.customFields.map(field => `${field.label}：${field.value || '未設定'}`).join('\n');
    showReferencePanel(character.name || '名前未設定', [
      ['人物の役割', character.role], ['人物の外見', character.appearance], ['人物の性格', character.personality],
      ['人物の目的', character.goal], ['人物の背景', character.background], ['人物の関係メモ', character.relationshipNotes],
      ['人物の自由項目', custom], ['参考画像', `${character.imageIds.length}枚`]
    ]);
  }
  function showSceneReference(scene) {
    const state = currentState();
    const people = scene.characterIds.map(id => state.characters.find(character => character.id === id)?.name || '名前未設定').join('、');
    let range = '本文範囲なし';
    if (scene.episodeId === selectedEpisodeId) {
      const lines = currentEpisodeView().lines;
      const start = lines.findIndex(line => line.id === scene.startLineId), end = lines.findIndex(line => line.id === scene.endLineId);
      if (start >= 0 && end >= start) range = start === end ? `${start + 1}行目` : `${start + 1}–${end + 1}行目`;
    }
    const chapter = state.chapters.find(item => item.id === scene.chapterId)?.title;
    const episode = state.episodeMetas.find(item => item.id === scene.episodeId)?.title;
    showReferencePanel(scene.summary || 'シーン設定', [
      ['シーンの要約', scene.summary], ['シーンの目的', scene.purpose], ['登場人物', people], ['視点', scene.viewpoint],
      ['場所', scene.location], ['時間', scene.time], ['メモ', scene.notes], ['本文範囲', range],
      ['章・話', [chapter, episode].filter(Boolean).join(' / ')], ['参考画像', `${scene.imageIds.length}枚`]
    ]);
  }
  function makeScene(scene) {
    const card = element('article', 'scene-card'); card.dataset.sceneId = scene.id;
    const header = element('div', 'scene-card-header'), heading = element('strong', 'scene-card-title', 'シーン');
    header.append(heading,
      button('プロット設定 ↗', 'scene-plot-reference quiet', () => {
        const current = currentScenes().find(item => item.id === scene.id);
        if (current) showSceneReference(current);
      }, 'プロット設定を開く'),
      button('削除', 'scene-delete quiet danger', () => void deleteScene(scene.id), 'シーン説明を削除'));
    const rangeLabel = element('p', 'scene-range'), description = element('textarea', 'scene-description');
    description.setAttribute('aria-label', 'シーン詳細説明'); description.placeholder = '情景、構図、雰囲気など…';
    description.addEventListener('input', () => setScene(scene.id, current => ({ ...current, summary: description.value }), `scene:${scene.id}`));
    description.addEventListener('blur', () => history.boundary());
    const rebind = button('選択中の行範囲に紐づける', 'scene-rebind', () => {
      const [start, end] = selectionIndexes(), episode = currentEpisodeView();
      setScene(scene.id, current => ({ ...current, startLineId: episode.lines[start].id, endLineId: episode.lines[end].id }));
    });
    const images = makeImageSection(scene); card.append(header, rangeLabel, description, rebind, images); return card;
  }
  async function deleteScene(sceneId) {
    if (busy) return;
    const yes = await choose('シーン説明を削除', 'このシーン説明と参考画像を削除します。「元に戻す」で復元できます。', [{ label: '取消', value: false }, { label: '削除', value: true, className: 'danger' }]);
    if (!yes) return;
    const initial = currentState(), episodeId = selectedEpisodeId, workId = initial.work.id;
    const initialScene = scenesForEpisode(initial, episodeId).find(item => item.id === sceneId); if (!initialScene) return;
    let imageRecords;
    try {
      imageRecords = await Promise.all(initialScene.imageIds.map(id => {
        const loaded = initial.imagesById[id];
        return loaded?.blob ? loaded : NovelStorage.loadImage(db, id);
      }));
      if (imageRecords.some(image => !image?.blob)) throw new Error('画像本体が保存先に見つかりません。');
    } catch (error) { toast(`シーンを削除できませんでした：${error.message}`); return; }
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
  }
  function renderScenes(episode, force) {
    const scenes = episode.scenes, alive = new Set(scenes.map(scene => scene.id));
    for (const [id, card] of sceneNodes) if (!alive.has(id)) { card.remove(); sceneNodes.delete(id); }
    scenes.forEach((scene, index) => {
      let card = sceneNodes.get(scene.id), fresh = !card;
      if (fresh) { card = makeScene(scene); sceneNodes.set(scene.id, card); }
      if ($('scenes').children[index] !== card) $('scenes').insertBefore(card, $('scenes').children[index] || null);
      card.querySelector('.scene-card-title').textContent = `シーン ${index + 1}`;
      const start = episode.lines.findIndex(line => line.id === scene.startLineId), end = episode.lines.findIndex(line => line.id === scene.endLineId);
      card.querySelector('.scene-range').textContent = start < 0 || end < 0 ? '紐づけ未設定' : `${start + 1}–${end + 1}行目`;
      const description = card.querySelector('.scene-description');
      if ((force || fresh || lastRendered?.scenes?.find(old => old.id === scene.id)?.summary !== scene.summary) && document.activeElement !== description) setValue(description, scene.summary);
      renderImages(card.querySelector('.image-section'), currentScenes().find(item => item.id === scene.id) || scene);
    });
    $('scene-count').textContent = String(scenes.length); $('scene-empty').hidden = scenes.length > 0;
  }
  function showScenes(show) {
    $('detail-columns').classList.toggle('show-scenes', show); $('toggle-scenes').setAttribute('aria-expanded', String(show)); $('toggle-scenes').textContent = show ? 'シーンを閉じる' : 'シーンを開く';
  }
  function render(force = false) {
    const state = currentState();
    selectedEpisodeId = state.episodesById[selectedEpisodeId] ? selectedEpisodeId : state.activeEpisodeId;
    const episode = currentEpisodeView(), work = currentWork();
    if (!episode.lines.some(line => line.id === range[0]) || !episode.lines.some(line => line.id === range[1])) range = [episode.lines[0].id, episode.lines[0].id];
    if (!episode.scenes.some(scene => scene.id === activeScene)) activeScene = null;
    if (composingElement !== $('work-title')) setValue($('work-title'), state.work.title);
    if (composingElement !== $('episode-title')) setValue($('episode-title'), episode.title);
    const episodeMetas = orderedEpisodeMetas(state);
    const navigation = $('episodes'), signature = episodeMetas.map(item => `${item.id}:${item.chapterId}:${item.order}:${item.title}`).join('|') + selectedEpisodeId;
    if (navigation.dataset.signature !== signature) {
      navigation.replaceChildren(...episodeMetas.map((item, index) => {
        const link = button('', `chapter-link${item.id === selectedEpisodeId ? ' active' : ''}`, () => void switchEpisode(item.id));
        link.append(element('span', 'chapter-order', String(index + 1).padStart(2, '0')), element('span', 'chapter-name', item.title || '無題の話'));
        link.setAttribute('aria-current', item.id === selectedEpisodeId ? 'page' : 'false');
        return link;
      }));
      navigation.dataset.signature = signature;
    }
    const position = episodeMetas.findIndex(item => item.id === selectedEpisodeId);
    $('episode-position').textContent = `EPISODE ${String(position + 1).padStart(2, '0')} / ${String(state.episodeMetas.length).padStart(2, '0')}`;
    if (composingElement !== $('preview')) setValue($('preview'), C.fullText(episode));
    renderRows(episode, force); renderScenes(episode, force); updateHighlights(); updateSpeakers(); syncImageUrls();
    $('undo').disabled = history.past.length === 0;
    $('redo').disabled = history.future.length === 0;
    const fullText = C.fullText(episode);
    $('word-count').textContent = `${[...fullText.replace(/\n/g, '')].length.toLocaleString()} 字 · ${episode.lines.length.toLocaleString()} 行`;
    $('footer-stats').textContent = `${state.episodeMetas.length} 話 / ${episode.scenes.length} シーンメモ`;
    lastRendered = episode; lastRenderedEpisodeId = episode.id;
    paintSaveStatus();
  }

  async function loadEpisodeForState(state, episodeId) {
    const cached = state.episodesById[episodeId];
    const cachedBody = Array.isArray(cached?.lines);
    const sceneKey = episodeSceneKey(episodeId);
    const cachedScenes = Object.prototype.hasOwnProperty.call(state.scenesByEpisodeId, sceneKey);
    const [episode, scenes] = await Promise.all([
      cachedBody ? cached : NovelStorage.loadEpisode(db, episodeId),
      cachedScenes ? state.scenesByEpisodeId[sceneKey] : NovelStorage.loadScenes(db, { episodeId })
    ]);
    if (!episode) throw new Error('話の本文が見つかりません。');
    return { episode, scenes, images: [] };
  }

  async function switchEpisode(id) {
    if (busy || composingElement || selectedEpisodeId === id) return;
    const generation = ++episodeLoadGeneration;
    const meta = currentState().episodeMetas.find(item => item.id === id);
    if (!meta) return;
    history.boundary();
    try {
      const current = currentState();
      const loaded = await loadEpisodeForState(current, id);
      if (generation !== episodeLoadGeneration) return;
      const next = loadedState(current, loaded.episode, loaded.scenes, loaded.images);
      releaseSceneImages(selectedEpisodeId);
      history.present = next;
      selectedEpisodeId = id;
      const first = loaded.episode.lines[0]; range = [first.id, first.id]; activeScene = null;
      render(true);
      publishWorkspace('episode');
    } catch (error) { toast(`話を開けませんでした：${error.message}`); }
  }

  function travel(direction) {
    if (busy || composingElement) return;
    const before = currentState(), target = history[direction]();
    if (before === target) return;
    episodeLoadGeneration++;
    const next = E.retainLoaded(before, target);
    history.present = next; history.boundary();
    selectedEpisodeId = next.activeEpisodeId;
    const episode = next.episodesById[selectedEpisodeId];
    if (episode) range = [episode.lines[0].id, episode.lines[0].id];
    activeScene = null;
    const patch = E.diffChanges(before, next);
    if (patch) { pendingChanges = E.mergeChanges(pendingChanges, patch); saveRevision++; saveError = ''; scheduleSave(); }
    render(true);
    publishWorkspace('history');
  }

  function bindName(input, update) {
    input.addEventListener('compositionstart', () => { composingElement = input; });
    input.addEventListener('compositionend', () => { composingElement = null; update(input.value); });
    input.addEventListener('input', event => { if (!event.isComposing && composingElement !== input) update(input.value); });
    input.addEventListener('blur', () => history.boundary());
  }

  bindName($('work-title'), value => {
    const state = currentState();
    if (value !== state.work.title) changed({ ...state, work: { ...state.work, title: value } }, 'work-title');
  });
  bindName($('episode-title'), value => {
    const state = currentState(), episode = currentEpisode();
    if (value === episode.title) return;
    const updated = { ...episode, title: value };
    const episodeMetas = state.episodeMetas.map(item => item.id === episode.id ? { ...item, title: value } : item);
    changed({ ...state, episodeMetas, episodesById: { ...state.episodesById, [episode.id]: updated } }, `episode-title:${episode.id}`);
  });
  bindTextEditor($('preview'));

  $('undo').addEventListener('click', () => travel('undo'));
  $('redo').addEventListener('click', () => travel('redo'));
  $('tab-manuscript').addEventListener('click', () => switchScreen('manuscript'));
  $('tab-plot').addEventListener('click', () => switchScreen('plot'));
  $('tab-characters').addEventListener('click', () => switchScreen('characters'));
  $('add-line').addEventListener('click', () => {
    const episode = currentEpisodeView(), [, end] = selectionIndexes(), position = C.offsets(episode)[end] + episode.lines[end].text.length;
    void applyText(position, position, '\n', 'detail', null);
  });
  $('delete-lines').addEventListener('click', async () => {
    if (busy) return;
    busy = true; const episode = currentEpisodeView(), [start, end] = selectionIndexes(), ids = episode.lines.slice(start, end + 1).map(line => line.id);
    const yes = await choose('選択した本文行を削除', `${start + 1}–${end + 1}行目を削除します。対象を失ったシーン説明は未設定のまま残ります。`, [{ label: '取消', value: false }, { label: '行を削除', value: true, className: 'danger' }]);
    busy = false; if (yes) changed(E.replaceEpisodeView(currentState(), C.removeLines(currentEpisodeView(), ids)));
  });
  $('add-scene').addEventListener('click', () => {
    if (busy) return;
    const state = currentState(), episode = currentEpisode(), view = currentEpisodeView(), [start, end] = selectionIndexes();
    const scene = {
      id: C.uid('scene'), workId: state.work.id, chapterId: episode.chapterId, episodeId: episode.id, order: currentScenes().length,
      startLineId: view.lines[start].id, endLineId: view.lines[end].id, summary: '', purpose: '', characterIds: [],
      viewpoint: '', location: '', time: '', notes: '', imageIds: [], nextImageNumber: 1
    };
    const scenesByEpisodeId = { ...state.scenesByEpisodeId, [episodeSceneKey(episode.id)]: [...currentScenes(), scene] };
    changed({ ...state, scenesByEpisodeId }); activeScene = scene.id; showScenes(true);
    const input = sceneNodes.get(scene.id)?.querySelector('.scene-description'); input?.focus({ preventScroll: true }); input?.scrollIntoView({ block: 'nearest' });
  });
  $('toggle-scenes').addEventListener('click', () => showScenes(!$('detail-columns').classList.contains('show-scenes')));
  $('column-width').addEventListener('input', () => document.documentElement.style.setProperty('--scene-width', `${$('column-width').value}%`));
  $('collapse-preview').addEventListener('click', () => {
    const hidden = !$('preview-body').hidden; $('preview-body').hidden = hidden;
    $('collapse-preview').textContent = hidden ? '開く ＋' : '折りたたむ −'; $('collapse-preview').setAttribute('aria-expanded', String(!hidden));
  });
  for (const direction of ['horizontal', 'vertical']) $(direction).addEventListener('click', () => {
    $('preview').classList.toggle('vertical', direction === 'vertical');
    for (const other of ['horizontal', 'vertical']) { $(other).classList.toggle('active', other === direction); $(other).setAttribute('aria-pressed', String(other === direction)); }
  });
  $('font-size').addEventListener('input', () => { $('preview').style.fontSize = `${$('font-size').value}px`; $('font-size-value').textContent = $('font-size').value; });
  $('close-image').addEventListener('click', () => $('image-dialog').close());
  $('image-dialog').addEventListener('close', () => $('image-preview').removeAttribute('src'));
  $('close-reference-panel').addEventListener('click', () => $('reference-panel').close());
  function samplePackage() {
    const work = M.createWork({ title: '雨あがりの栞' });
    const episode = work.episodes[0]; episode.title = '第1話　窓辺の約束';
    const line = (text, speaker) => ({ ...C.line(text, speaker), characterId: null });
    episode.lines = [line('雨がやんだのは、午後三時を少し過ぎた頃だった。', '地の文'), line('「この本、まだ覚えてる？」', '紬'), line('窓辺に立つ紬が、青い表紙をこちらに向ける。', '地の文'), line('「忘れるわけないだろ。最後のページ、まだ読んでないんだから」', '遥'), line('', ''), line('濡れた街路樹から、一滴の光が落ちた。', '地の文')];
    const makeScene = (order, start, end, summary) => ({
      id: C.uid('scene'), workId: work.id, chapterId: episode.chapterId, episodeId: episode.id, order,
      startLineId: episode.lines[start].id, endLineId: episode.lines[end].id, summary, purpose: '', characterIds: [],
      viewpoint: '', location: '', time: '', notes: '', imageIds: [], nextImageNumber: 1
    });
    work.scenes = [makeScene(0, 0, 3, '雨あがりの古い図書室。西向きの窓から柔らかな光。'), makeScene(1, 1, 2, '本の角は擦れている。表紙から細い白い栞がのぞく。')];
    return { work: M.validateWork(work), images: [] };
  }
  async function installPackage(value, message = '') {
    const replacementState = stateFromFull(value);
    episodeLoadGeneration++;
    replacingPackage = true;
    clearTimeout(saveTimer); saveTimer = null;
    const wasReady = $('main').dataset.ready === 'true';
    if (wasReady) $('app').setAttribute('aria-busy', 'true');
    let queuedOldChanges = null;
    paintSaveStatus();
    try {
      if (savePromise) await savePromise;
      queuedOldChanges = pendingChanges;
      pendingChanges = null;
      if (!db) db = await NovelStorage.openStore();
      await NovelStorage.saveWork(db, value);
      for (const url of imageUrls.values()) URL.revokeObjectURL(url);
      imageUrls.clear();
      rowNodes.forEach(node => node.remove()); rowNodes.clear(); $('lines').replaceChildren();
      sceneNodes.forEach(node => node.remove()); sceneNodes.clear(); $('scenes').replaceChildren();
      const state = replacementState;
      history.present = state; history.past = []; history.future = []; history.boundary();
      selectedEpisodeId = state.activeEpisodeId;
      range = [state.episodesById[selectedEpisodeId].lines[0].id, state.episodesById[selectedEpisodeId].lines[0].id];
      activeScene = null; lastRendered = null; lastRenderedEpisodeId = null; pendingChanges = null;
      saveRevision++; savedRevision = saveRevision; saveError = ''; dbError = '';
      backupTimestamp = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      render(true);
      publishWorkspace('package');
      if (message) toast(message);
    } catch (error) {
      pendingChanges = E.mergeChanges(queuedOldChanges, pendingChanges);
      saveError = error?.message || '作品を置き換えられませんでした。';
      throw error;
    } finally {
      replacingPackage = false;
      if (wasReady) $('app').setAttribute('aria-busy', 'false');
      if (pendingChanges && !saveError) scheduleSave(0);
      paintSaveStatus();
    }
  }
  async function confirmReplace() {
    if (pendingImageLoads || composingElement) { toast('入力または画像読み込みの完了後に操作してください。'); return false; }
    return choose('作品を切り替える', '現在の作品を置き換えます。必要なら先にZIPバックアップを保存してください。', [
      { label: '取消', value: false }, { label: '作品を置き換える', value: true, className: 'danger' }
    ]);
  }
  async function loadArchiveModule() {
    const path = location.protocol === 'file:' ? './src/archive.js' : './archive.js';
    await import(new URL(path, location.href).href);
    if (!window.NovelArchive) throw new Error('ZIP処理モジュールを読み込めませんでした。');
    return window.NovelArchive;
  }
  async function flushPendingSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (pendingChanges && !saveInFlight && !composingElement && !pendingImageLoads && !saveError) void startPersistChanges();
    const start = Date.now();
    while ((saveInFlight || pendingChanges || saveRevision > savedRevision) && Date.now() - start < 15000) {
      if (saveError) throw new Error(saveError);
      if (pendingChanges && !saveInFlight && !savePromise && !composingElement && !pendingImageLoads) void startPersistChanges();
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    if (saveRevision > savedRevision) throw new Error(saveError || '保存が完了していません。');
  }
  function applyPatchToPackage(packageValue, patch) {
    if (!patch) return packageValue;
    const work = { ...packageValue.work };
    if (patch.work) Object.assign(work, patch.work);
    const records = (source, section) => {
      const values = new Map(source.map(record => [record.id, record]));
      for (const id of section?.deleteIds || []) values.delete(id);
      for (const record of section?.upsert || []) values.set(record.id, record);
      return [...values.values()];
    };
    work.chapters = records(work.chapters, patch.chapters);
    work.episodes = records(work.episodes, patch.episodes);
    work.scenes = records(work.scenes, patch.scenes);
    work.characters = records(work.characters, patch.characters);
    const metadata = new Map(work.images.map(image => [image.id, image]));
    const payloads = new Map(packageValue.images.map(image => [image.id, image]));
    for (const id of patch.images?.deleteIds || []) { metadata.delete(id); payloads.delete(id); }
    for (const image of patch.images?.upsert || []) {
      const { blob, ...record } = image;
      metadata.set(image.id, record);
      if (!blob) throw new Error(`画像 ${image.name || image.id} の現在データをZIPへ含められません。`);
      payloads.set(image.id, { id: image.id, mimeType: image.mimeType, blob });
    }
    work.images = [...metadata.values()];
    return { work, images: [...payloads.values()] };
  }
  async function exportArchive() {
    if (!db) { toast('IndexedDBへ接続できないためZIPを作成できません。'); return; }
    if (busy || replacingPackage) { toast('作品の切り替えが終わってからZIPを保存してください。'); return; }
    if (pendingImageLoads || composingElement) { toast('入力・画像の読み込みが終わってからZIPを保存してください。'); return; }
    let saveWarning = '';
    try {
      try { await flushPendingSave(); }
      catch (error) { saveWarning = error?.message || '端末内への保存に失敗しました。'; }
      const savedPackage = await NovelStorage.loadWork(db);
      if (!savedPackage) throw new Error('保存された作品がありません。');
      const unsaved = E.mergeChanges(pendingChanges, activeChanges);
      const fullPackage = applyPatchToPackage(savedPackage, unsaved);
      const archive = await loadArchiveModule();
      const blob = await archive.exportArchive(fullPackage);
      download(blob, `${filename(fullPackage.work.title)}.zip`);
      toast(saveWarning
        ? `端末内保存に失敗しました。現在の編集を含むZIPのダウンロードを開始したので、保存先のファイルを確認してください。${saveWarning}`
        : 'ZIPのダウンロードを開始しました。保存先のファイルを確認してください。');
    } catch (error) { toast(`ZIPを書き出せませんでした：${error.message}`); }
  }
  async function importFile(file) {
    if (!file || busy) return;
    busy = true;
    try {
      let value;
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const zipFile = /\.zip$/i.test(file.name) || file.type === 'application/zip' || (header[0] === 0x50 && header[1] === 0x4b && [0x03, 0x05, 0x07].includes(header[2]));
      if (zipFile) {
        const archive = await loadArchiveModule(); value = await archive.importArchive(file);
      } else {
        if (file.size > MAX_LEGACY_JSON_BYTES) throw new Error('JSONファイルのサイズが384MBを超えています。');
        value = NovelMigration.migrateLegacy(await file.text());
        value = await NovelPackage.validatePackage(value);
      }
      if (await confirmReplace()) await installPackage(value, '作品を読み込み、端末内へ保存しました。');
    } catch (error) { toast(`取り込めませんでした：${error?.message || error}`); }
    finally { busy = false; }
  }
  async function addEpisode() {
    if (busy) return;
    const state = currentState(), episode = currentEpisode(), chapter = state.chapters.find(item => item.id === episode.chapterId) || state.chapters[0];
    const chapterEpisodes = state.episodeMetas.filter(item => item.chapterId === chapter.id);
    const order = Math.max(-1, ...chapterEpisodes.map(item => item.order)) + 1;
    const created = { id: C.uid('episode'), workId: state.work.id, chapterId: chapter.id, title: `第${state.episodeMetas.length + 1}話`, order, lines: [{ ...C.line(), characterId: null }] };
    const episodeMetas = [...state.episodeMetas, { id: created.id, workId: created.workId, chapterId: created.chapterId, title: created.title, order }];
    const next = E.activateEpisode({ ...state, episodeMetas }, created, [], []);
    const first = created.lines[0]; selectedEpisodeId = created.id; range = [first.id, first.id];
    changed(next); $('episode-title').focus(); $('episode-title').select();
  }
  function exportTxt() {
    const state = currentState(), current = currentEpisodeView();
    if ($('txt-scope').value !== 'work') {
      downloadText(C.fullText(current), `${filename(`${state.work.title}_${current.title}`)}.txt`); toast('本文だけをTXTに書き出しました。'); return;
    }
    void (async () => {
      try {
        const episodes = [];
        for (const meta of orderedEpisodeMetas(state)) {
          const episode = state.episodesById[meta.id] || await NovelStorage.loadEpisode(db, meta.id);
          if (!episode) throw new Error(`${meta.title} の本文を読み込めません。`);
          episodes.push(C.fullText(episode));
        }
        downloadText(episodes.join('\n\n'), `${filename(state.work.title)}.txt`); toast('作品全体の本文をTXTに書き出しました。');
      } catch (error) { toast(`TXTを書き出せませんでした：${error.message}`); }
    })();
  }

  $('add-episode').addEventListener('click', () => void addEpisode());
  $('export-txt').addEventListener('click', exportTxt);
  $('export-archive').addEventListener('click', () => void exportArchive());
  $('import-button').addEventListener('click', () => { if (!busy) $('import-file').click(); });
  $('import-file').addEventListener('change', () => { const file = $('import-file').files[0]; $('import-file').value = ''; void importFile(file); });
  $('reset').addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { if (await confirmReplace()) await installPackage({ work: M.createWork(), images: [] }, '新しい作品を作成しました。'); }
    catch (error) { toast(`新しい作品を保存できませんでした：${error.message}`); }
    finally { busy = false; }
  });
  $('load-sample').addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { if (await confirmReplace()) await installPackage(samplePackage(), 'サンプル作品を開きました。'); }
    catch (error) { toast(`サンプルを開けませんでした：${error.message}`); }
    finally { busy = false; }
  });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.isComposing || composingElement || busy || $('dialog').open || $('image-dialog').open || $('reference-panel').open) return;
    const key = event.key.toLowerCase();
    if (key === 'z') { event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo'); }
    else if (key === 'y') { event.preventDefault(); travel('redo'); }
    else if (key === 's') { event.preventDefault(); void exportArchive(); }
  });
  window.addEventListener('beforeunload', event => {
    if (saveRevision > savedRevision || composingElement || pendingImageLoads) { event.preventDefault(); event.returnValue = ''; }
  });
  $('sidebar').id = 'sidebar';
  const requireStore = () => db ? db : Promise.reject(new Error('作品データベースの起動が完了していません。'));
  async function openExtensionReference(screen, method, target) {
    const config = screen === 'plot'
      ? { tab: 'tab-plot', global: 'NovelPlot', label: 'プロット' }
      : { tab: 'tab-characters', global: 'NovelCharacters', label: 'キャラクター' };
    $(config.tab).click();
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const action = window[config.global]?.[method];
      if (typeof action === 'function') { await action(target); return true; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    toast(`${config.label}の参照先を開けませんでした。`);
    return false;
  }
  window.NovelWorkspace = Object.freeze({
    // getState returns the partial immutable-by-convention state; create a new snapshot before editing.
    getState: () => currentState(),
    commit: (nextState, patch = null, historyKey = null) => commitWorkspace(nextState, patch, historyKey),
    hydrate: patch => {
      if (!patch || patch.workId !== currentState().work.id) throw new Error('読み込みデータの作品IDが一致しません。');
      history.present = E.applyPatch(currentState(), patch);
      return currentState();
    },
    selectScreen: screen => switchScreen(screen),
    selectEpisode: id => switchEpisode(id),
    loadEpisode: id => db ? NovelStorage.loadEpisode(db, id) : requireStore(),
    loadScenes: scope => db ? NovelStorage.loadScenes(db, scope) : requireStore(),
    loadImage: id => db ? NovelStorage.loadImage(db, id) : requireStore(),
    beginImageLoad,
    openPlotScene: scene => openExtensionReference('plot', 'openScene', scene),
    openCharacter: characterId => openExtensionReference('characters', 'openCharacter', characterId),
    subscribe: listener => {
      if (typeof listener !== 'function') throw new TypeError('更新通知には関数を指定してください。');
      workspaceSubscribers.add(listener);
      return () => workspaceSubscribers.delete(listener);
    },
    toast
  });
  async function restoreLegacyCopy() {
    let raw;
    try { raw = localStorage.getItem(RECOVERY_KEY); }
    catch { $('recovery-status').textContent = '旧復元コピーを確認できません'; return null; }
    if (!raw) return null;
    let value;
    try { value = await NovelPackage.validatePackage(NovelMigration.migrateLegacy(raw)); }
    catch { $('recovery-status').textContent = '旧復元コピーは読み込めません。旧コピーは保持されています'; return null; }
    let savedAt = '';
    try { savedAt = JSON.parse(raw).savedAt || ''; } catch { /* Legacy payload may be a JSON string. */ }
    const restore = await choose('前回の作業を復元', `このブラウザに旧版の復元コピーがあります。\n作品：${value.work.title}\n${savedAt ? new Date(savedAt).toLocaleString('ja-JP') : ''}\n復元後は新形式として端末内へ保存します。旧コピーは残します。`, [
      { label: '新規から始める', value: false }, { label: '復元する', value: true, className: 'primary' }
    ]);
    return restore ? value : null;
  }
  function beginFromLoadedIndex(index, loaded) {
    const state = E.createState(index, loaded.episode, loaded.scenes, loaded.images);
    history.present = state; history.past = []; history.future = []; history.boundary();
    selectedEpisodeId = loaded.episode.id;
    range = [loaded.episode.lines[0].id, loaded.episode.lines[0].id];
    activeScene = null; pendingChanges = null; saveRevision++; savedRevision = saveRevision; saveError = ''; backupTimestamp = '';
  }
  async function loadSelected(index, episodeId) {
    const episode = await NovelStorage.loadEpisode(db, episodeId);
    if (!episode) throw new Error('選択する話が保存されていません。');
    const scenes = await NovelStorage.loadScenes(db, { episodeId });
    return { episode, scenes, images: [] };
  }
  async function boot() {
    try {
      db = await NovelStorage.openStore();
      const index = await NovelStorage.loadWorkIndex(db);
      if (index) {
        const episodeMeta = index.episodes.slice().sort((a, b) => a.order - b.order)[0];
        if (!episodeMeta) throw new Error('本文を含む話がありません。');
        const loaded = await loadSelected(index, episodeMeta.id);
        beginFromLoadedIndex(index, loaded);
      } else {
        const legacy = await restoreLegacyCopy();
        const full = legacy || { work: M.createWork(), images: [] };
        await NovelStorage.saveWork(db, full);
        beginFromLoadedIndex(indexOf(full.work), {
          episode: full.work.episodes[0],
          scenes: full.work.scenes.filter(scene => scene.episodeId === full.work.episodes[0].id),
          images: []
        });
        if (legacy) $('recovery-status').textContent = '旧版の復元コピーから移行しました';
      }
    } catch (error) {
      dbError = error?.message || 'IndexedDBを開けませんでした。';
      if (!db) {
        history.present = stateFromFull(blankPackage);
        selectedEpisodeId = history.present.activeEpisodeId;
      }
    }
    render(true);
    $('main').dataset.ready = 'true';
    $('app').setAttribute('aria-busy', 'false');
    paintSaveStatus();
    publishWorkspace('ready');
  }

  $('app').setAttribute('aria-busy', 'true');
  render(true);
  void boot();
})();
