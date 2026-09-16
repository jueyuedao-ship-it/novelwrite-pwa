(function () {
  'use strict';
  const C = NovelCore, $ = id => document.getElementById(id);
  const RECOVERY_KEY = 'fumizukue.recovery.v1';
  const initial = C.work();
  const history = new C.History({ work: initial, chapterId: initial.chapters[0].id });
  let writtenWork = initial, lastRendered = null, lastChapterId = null;
  let range = [initial.chapters[0].lines[0].id, initial.chapters[0].lines[0].id], originLabel = '新規作品';
  let activeScene = null, backupTimer, toastTimer, writeTime = '', storageEnabled = true, busy = false;
  let composingElement = null;
  let workSession = 0, pendingImageLoads = 0, storageWarningShown = false;
  const characterNodes = new Map(), imageViews = new WeakMap();
  const rowNodes = new Map(), sceneNodes = new Map(), inputState = new WeakMap();
  const currentWork = () => history.present.work;
  const currentChapter = () => currentWork().chapters.find(ch => ch.id === history.present.chapterId) || currentWork().chapters[0];
  const dirty = () => currentWork() !== writtenWork;
  const textOf = el => el.value;
  const setValue = (el, value) => { if (el.value !== value) el.value = value; };
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(text, className, handler, label) {
    const el = element('button', className, text); el.type = 'button';
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('click', handler); return el;
  }
  function toast(message) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
  }
  function choose(title, message, options) {
    return new Promise(resolve => {
      const dialog = $('dialog');
      $('dialog-title').textContent = title; $('dialog-message').textContent = message;
      $('dialog-options').replaceChildren();
      let settled = false;
      const finish = value => {
        if (settled) return; settled = true;
        dialog.removeEventListener('cancel', cancel); dialog.close(); resolve(value);
      };
      const cancel = event => { event.preventDefault(); finish(null); };
      dialog.addEventListener('cancel', cancel);
      options.forEach(o => $('dialog-options').append(button(o.label, o.className || '', () => finish(o.value))));
      dialog.showModal();
    });
  }
  function backup() {
    clearTimeout(backupTimer);
    if (!storageEnabled) return;
    backupTimer = setTimeout(() => {
      try {
        localStorage.setItem(RECOVERY_KEY, JSON.stringify({ work: currentWork(), chapterId: currentChapter().id, savedAt: new Date().toISOString() }));
        $('recovery-status').textContent = '復元用コピーあり'; storageWarningShown = false;
      } catch {
        // Images can exceed localStorage's quota. Retry after later edits/removals.
        $('recovery-status').textContent = '最新の復元用コピーを保存できません · JSONを書き出してください';
        if (!storageWarningShown) toast('画像などで保存容量を超えた可能性があります。画像を含む作品JSONを書き出してください。編集は続けられます。');
        storageWarningShown = true;
      }
    }, 1000);
  }
  function commit(nextWork, key = null) {
    if (nextWork === currentWork()) return;
    history.push({ work: nextWork, chapterId: history.present.chapterId }, key);
    render(); backup();
  }
  function changeChapter(ch, key = null) {
    const w = currentWork();
    commit({ ...w, chapters: w.chapters.map(old => old.id === ch.id ? ch : old) }, key);
  }
  function selectionIndexes() {
    const ch = currentChapter();
    const a = ch.lines.findIndex(l => l.id === range[0]), b = ch.lines.findIndex(l => l.id === range[1]);
    return a < 0 || b < 0 ? [0, 0] : [Math.min(a, b), Math.max(a, b)];
  }
  function selectRange(startId, endId) {
    const ch = currentChapter();
    const a = ch.lines.findIndex(l => l.id === startId), b = ch.lines.findIndex(l => l.id === endId);
    const low = Math.max(0, Math.min(a, b)), high = Math.max(0, Math.max(a, b));
    range = [ch.lines[low].id, ch.lines[high].id]; activeScene = null; updateHighlights();
  }
  function updateHighlights() {
    const ch = currentChapter(), [a, b] = selectionIndexes();
    const scene = ch.scenes.find(s => s.id === activeScene);
    const activeStart = scene ? ch.lines.findIndex(l => l.id === scene.startLineId) : -1;
    const activeEnd = scene ? ch.lines.findIndex(l => l.id === scene.endLineId) : -1;
    ch.lines.forEach((l, i) => {
      const node = rowNodes.get(l.id); if (!node) return;
      node.classList.toggle('selected', i >= a && i <= b);
      node.classList.toggle('in-scene', activeStart >= 0 && i >= activeStart && i <= activeEnd);
      node.querySelector('input[type=checkbox]').checked = i >= a && i <= b;
    });
    const indexes = new Map(ch.lines.map((l, i) => [l.id, i]));
    ch.scenes.forEach(s => {
      const node = sceneNodes.get(s.id); if (!node) return;
      node.classList.toggle('active', s.id === activeScene);
      node.classList.toggle('related', s.startLineId !== null && indexes.get(s.startLineId) <= b && indexes.get(s.endLineId) >= a);
    });
    $('selection-label').textContent = a === b ? `${a + 1}行目を選択中` : `${a + 1}–${b + 1}行目を選択中（${b - a + 1}行）`;
  }
  function focusCaret(position, source = 'detail') {
    if (source === 'preview') {
      const el = $('preview'); el.focus({ preventScroll: true }); el.setSelectionRange(position, position); return;
    }
    const location = C.locate(currentChapter(), position), l = currentChapter().lines[location.index];
    const el = rowNodes.get(l.id)?.querySelector('.line-text');
    if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(location.column, location.column); el.scrollIntoView({ block: 'nearest' }); }
  }
  async function applyText(start, end, insert, source, key, caretOverride) {
    if (busy) return false;
    const ch = currentChapter();
    let result = C.replaceText(ch, start, end, insert);
    if (result.conflict) {
      busy = true;
      // The native textarea edit is provisional until the speaker choice is resolved.
      render(true);
      const options = result.conflict.filter(Boolean).map(name => ({ label: name, value: name }));
      options.push({ label: '未設定', value: '' }, { label: '結合を取り消す', value: null });
      const choice = await choose('結合後の人物名', '異なる人物名の行が1行になります。残す人物名を選んでください。シーン説明は保持されます。', options);
      busy = false;
      if (choice === null) { render(true); focusCaret(start, source); return false; }
      // A reference image may finish loading while the modal is open.
      result = C.replaceText(currentChapter(), start, end, insert, choice);
      key = null;
    }
    const structural = result.chapter.lines.length !== ch.lines.length || result.chapter.lines.some((l, i) => l.id !== ch.lines[i]?.id);
    changeChapter(result.chapter, structural ? null : key);
    if (structural || source === 'preview') focusCaret(caretOverride ?? result.caret, source);
    return true;
  }
  function bindTextEditor(el, lineId = null) {
    el.addEventListener('beforeinput', event => {
      if (busy) { event.preventDefault(); return; }
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        if (event.cancelable) { event.preventDefault(); travel(event.inputType === 'historyUndo' ? 'undo' : 'redo'); }
        return;
      }
      if (!composingElement) inputState.set(el, { oldText: el.value, start: el.selectionStart, end: el.selectionEnd, inputType: event.inputType });
    });
    el.addEventListener('compositionstart', () => {
      composingElement = el;
      inputState.set(el, { oldText: el.value, start: el.selectionStart, end: el.selectionEnd, inputType: 'insertCompositionText' });
      history.boundary();
    });
    const finish = () => {
      const ch = currentChapter(), i = lineId ? ch.lines.findIndex(l => l.id === lineId) : -1;
      if (lineId && i < 0) return;
      const expected = lineId ? ch.lines[i].text : C.fullText(ch);
      const after = C.normalize(textOf(el)), state = inputState.get(el);
      inputState.delete(el);
      const diff = C.difference(expected, after, state?.oldText === expected ? state : undefined);
      if (!diff) return;
      const base = lineId ? C.offsets(ch)[i] : 0;
      const caret = base + el.selectionStart;
      void applyText(base + diff.start, base + diff.end, diff.insert, lineId ? 'detail' : 'preview', `text:${ch.id}:${lineId || 'preview'}`, caret);
    };
    el.addEventListener('input', event => { if (!event.isComposing && composingElement !== el) finish(); });
    el.addEventListener('compositionend', () => { composingElement = null; finish(); history.boundary(); });
    el.addEventListener('blur', () => history.boundary());
    if (lineId) {
      el.addEventListener('focus', () => { const [a, b] = selectionIndexes(); if (a === b) selectRange(lineId, lineId); });
      el.addEventListener('keydown', event => {
        if (event.isComposing || composingElement || busy || event.ctrlKey || event.metaKey || event.altKey) return;
        const ch = currentChapter(), i = ch.lines.findIndex(l => l.id === lineId);
        if (i < 0 || el.selectionStart !== el.selectionEnd) return;
        const base = C.offsets(ch)[i];
        if (event.key === 'Backspace' && el.selectionStart === 0 && i > 0) {
          event.preventDefault(); void applyText(base - 1, base, '', 'detail', null);
        } else if (event.key === 'Delete' && el.selectionEnd === el.value.length && i < ch.lines.length - 1) {
          event.preventDefault(); const end = base + el.value.length; void applyText(end, end + 1, '', 'detail', null);
        }
      });
    }
  }
  function updateLine(id, values, key) {
    const ch = currentChapter();
    changeChapter({ ...ch, lines: ch.lines.map(l => l.id === id ? { ...l, ...values } : l) }, key);
  }
  function makeRow(l) {
    const row = element('div', 'editor-row'); row.dataset.lineId = l.id;
    const speakerCell = element('div', 'speaker-cell'), marker = element('label', 'row-marker');
    const number = element('span', 'row-number');
    const check = document.createElement('input'); check.type = 'checkbox';
    check.addEventListener('click', e => selectRange(e.shiftKey ? range[0] : l.id, l.id));
    marker.append(number, check);
    const speaker = element('input', 'speaker-input'); speaker.setAttribute('list', 'speakers'); speaker.placeholder = '人物名';
    let speakerComposing = false, speakerChanged = false;
    const setSpeaker = () => {
      const old = currentChapter().lines.find(x => x.id === l.id);
      if (old && old.speaker !== speaker.value) {
        speakerChanged = true;
        updateLine(l.id, { speaker: speaker.value }, `speaker:${l.id}`);
      }
    };
    const finishSpeaker = () => {
      if (speakerComposing) return;
      // Register only the finished name, never each prefix typed along the way.
      if (speakerChanged) {
        speakerChanged = false;
        const w = currentWork(), name = speaker.value.trim();
        if (name && name !== '地の文' && name !== 'システム' && !w.characters.some(c => c.name.trim() === name)) {
          commit({ ...w, characters: [...w.characters, { ...C.character(), name }] }, `speaker:${l.id}`);
        }
      }
      updateSpeakers(); history.boundary();
    };
    speaker.addEventListener('compositionstart', () => { speakerComposing = true; composingElement = speaker; });
    speaker.addEventListener('compositionend', () => { speakerComposing = false; composingElement = null; setSpeaker(); });
    speaker.addEventListener('input', () => { if (!speakerComposing) setSpeaker(); });
    speaker.addEventListener('blur', finishSpeaker);
    speaker.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && !speakerComposing && event.keyCode !== 229) {
        event.preventDefault(); finishSpeaker();
      }
    });
    speakerCell.append(marker, speaker);
    const body = element('div', 'body-cell'), text = element('textarea', 'line-text');
    text.rows = 1; text.spellcheck = false; text.placeholder = '本文を入力…';
    bindTextEditor(text, l.id);
    const actions = element('div', 'row-actions');
    actions.append(button('開始行に指定', '', () => selectRange(l.id, range[1])));
    actions.append(button('終了行に指定', '', () => selectRange(range[0], l.id)));
    actions.append(button('シーンへ ↗', '', () => {
      const ch = currentChapter(), index = ch.lines.findIndex(x => x.id === l.id);
      const scene = ch.scenes.find(s => s.startLineId !== null && ch.lines.findIndex(x => x.id === s.startLineId) <= index && ch.lines.findIndex(x => x.id === s.endLineId) >= index);
      if (!scene) return toast('この行に紐づくシーン説明はありません。');
      showScenes(true); activeScene = scene.id; updateHighlights(); sceneNodes.get(scene.id)?.scrollIntoView({ block: 'nearest' });
    }));
    body.append(text, actions); row.append(speakerCell, body); return row;
  }
  function renderRows(ch, force) {
    const alive = new Set(ch.lines.map(l => l.id));
    for (const [id, node] of rowNodes) if (!alive.has(id)) { node.remove(); rowNodes.delete(id); }
    const oldLines = new Map((lastChapterId === ch.id ? lastRendered?.lines || [] : []).map(l => [l.id, l]));
    const sizing = [];
    ch.lines.forEach((l, i) => {
      let node = rowNodes.get(l.id), fresh = !node;
      if (fresh) { node = makeRow(l); rowNodes.set(l.id, node); }
      if ($('lines').children[i] !== node) $('lines').insertBefore(node, $('lines').children[i] || null);
      const number = String(i + 1).padStart(2, '0');
      if (node.querySelector('.row-number').textContent !== number) {
        node.querySelector('.row-number').textContent = number;
        node.querySelector('input[type=checkbox]').setAttribute('aria-label', `${i + 1}行目を選択`);
      }
      const speaker = node.querySelector('.speaker-input'), text = node.querySelector('.line-text');
      speaker.setAttribute('aria-label', `${i + 1}行目の人物名`); text.setAttribute('aria-label', `${i + 1}行目の本文`);
      if (force || fresh || oldLines.get(l.id) !== l) {
        if (composingElement !== speaker) setValue(speaker, l.speaker);
        if (composingElement !== text) setValue(text, l.text);
        sizing.push(text);
      }
    });
    // Batch layout reads after DOM writes; 2,000 rows must not cause 2,000 layouts.
    sizing.forEach(el => { el.style.height = 'auto'; });
    if (!CSS.supports('field-sizing', 'content')) {
      const heights = sizing.map(el => Math.min(500, Math.max(58, el.scrollHeight + 2)));
      sizing.forEach((el, i) => { el.style.height = `${heights[i]}px`; });
    }
  }
  function updateScene(id, values, key = null) {
    const ch = currentChapter(); changeChapter({ ...ch, scenes: ch.scenes.map(s => s.id === id ? { ...s, ...values } : s) }, key);
  }
  function imageOwner(owner) {
    const w = currentWork();
    return owner.kind === 'character' ? w.characters.find(c => c.id === owner.id)
      : w.chapters.find(c => c.id === owner.chapterId)?.scenes.find(s => s.id === owner.id);
  }
  function setOwnerImages(owner, images, nextImageNumber) {
    const w = currentWork();
    if (!imageOwner(owner)) return;
    if (owner.kind === 'character') {
      commit({ ...w, characters: w.characters.map(c => c.id === owner.id ? { ...c, images } : c) });
    } else {
      commit({ ...w, chapters: w.chapters.map(ch => ch.id === owner.chapterId ? { ...ch, scenes: ch.scenes.map(s => s.id === owner.id ? { ...s, images, nextImageNumber: nextImageNumber ?? s.nextImageNumber } : s) } : ch) });
    }
  }
  function openImage(img) {
    $('image-dialog-title').textContent = img.referenceNumber ? `画像${img.referenceNumber} — ${img.name}` : img.name;
    $('image-preview').alt = img.name; $('image-preview').src = img.dataUrl;
    $('image-dialog').showModal();
  }
  function refreshImageAdd(section) {
    const view = imageViews.get(section), owner = imageOwner(view.owner);
    view.add.disabled = view.reading;
    view.add.textContent = view.reading ? '画像を読み込み中…' : view.owner.kind === 'scene' && owner ? `＋ 画像${owner.nextImageNumber}を追加` : '＋ 画像を追加';
  }
  function makeImageSection(owner) {
    const section = element('div', 'image-section');
    const header = element('div', 'image-section-header');
    const label = element('span', '', '参考画像');
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.accept = '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif'; input.hidden = true;
    input.setAttribute('aria-label', owner.kind === 'character' ? 'キャラクターの画像ファイル' : 'シーンの画像ファイル');
    const add = button('＋ 画像を追加', 'image-add', () => { if (!busy) input.click(); });
    const gallery = element('div', 'image-gallery');
    const help = element('p', 'image-help', 'PNG・JPEG・WebP・GIF / 1枚10MBまで。画像もJSONに保存されます。');
    header.append(label, add); section.append(header, gallery, help, input);
    imageViews.set(section, { images: null, gallery, owner, add, reading: false });
    if (owner.kind === 'scene') section.append(element('p', 'image-reference-guide', '「画像2が画像1に攻撃している」のように説明できます。番号はこのシーン内で固定され、削除しても詰め直しません。複数選択時は選んだファイルの並び順に番号が付きます。'));
    refreshImageAdd(section);
    input.addEventListener('change', async () => {
      const files = [...input.files]; input.value = ''; if (!files.length || busy) return;
      const session = workSession, workId = currentWork().id;
      pendingImageLoads++; imageViews.get(section).reading = true; refreshImageAdd(section);
      try {
        const images = [];
        for (const file of files) images.push(await NovelImages.readFile(file));
        const target = imageOwner(owner);
        if (session !== workSession || workId !== currentWork().id || !target) {
          toast('添付先が変更されたため、画像の追加を取り消しました。'); return;
        }
        if (owner.kind === 'scene') {
          const next = C.appendSceneImages(target, images);
          setOwnerImages(owner, next.images, next.nextImageNumber);
        } else setOwnerImages(owner, [...target.images, ...images]);
        toast(`${images.length}枚の参考画像を追加しました。JSON書き出しで保存できます。`);
      } catch (error) { toast(`画像を追加できませんでした：${error.message}`); }
      finally { pendingImageLoads--; imageViews.get(section).reading = false; refreshImageAdd(section); }
    });
    return section;
  }
  function renderImages(section, images) {
    const view = imageViews.get(section); refreshImageAdd(section); if (view.images === images) return;
    view.images = images;
    view.gallery.replaceChildren(...images.map(img => {
      const figure = element('figure', 'image-tile');
      if (view.owner.kind === 'scene') {
        const ref = `画像${img.referenceNumber}`, heading = element('div', 'image-reference-heading');
        heading.append(element('strong', 'image-reference-number', ref));
        heading.append(button('説明に挿入', 'image-reference-insert', () => {
          if (busy || composingElement) return;
          const textarea = section.closest('.scene-card').querySelector('.scene-description');
          const start = textarea.selectionStart, end = textarea.selectionEnd;
          const description = textarea.value.slice(0, start) + ref + textarea.value.slice(end);
          history.boundary(); updateScene(view.owner.id, { description }); history.boundary();
          textarea.focus({ preventScroll: true }); textarea.setSelectionRange(start + ref.length, start + ref.length);
        }, `${ref}を説明に挿入`));
        figure.append(heading);
      }
      const title = img.referenceNumber ? `画像${img.referenceNumber}：${img.name}` : img.name;
      const thumb = button('', 'image-thumb', () => openImage(img), `画像を拡大：${title}`);
      const picture = document.createElement('img'); picture.src = img.dataUrl; picture.alt = img.name;
      picture.loading = 'lazy'; picture.decoding = 'async'; thumb.append(picture);
      const caption = element('figcaption'); caption.append(element('span', 'image-name', img.name));
      caption.append(button('削除', 'image-remove', () => {
        if (busy) return; const target = imageOwner(view.owner);
        if (target) setOwnerImages(view.owner, target.images.filter(i => i.id !== img.id));
      }, `画像を削除：${img.name}`));
      figure.append(thumb, caption); return figure;
    }));
  }
  function updateCharacter(id, values, key) {
    const w = currentWork();
    commit({ ...w, characters: w.characters.map(c => c.id === id ? { ...c, ...values } : c) }, key);
    if ('name' in values) updateSpeakers();
  }
  function makeCharacter(c) {
    const card = element('article', 'character-card'); card.dataset.characterId = c.id;
    const header = element('div', 'character-card-header');
    header.append(element('h3', 'character-heading', '新しいキャラクター'));
    header.append(button('削除', 'quiet danger', async () => {
      if (busy) return; busy = true;
      const current = currentWork().characters.find(x => x.id === c.id);
      const yes = await choose('キャラクターを削除', `「${current.name || '名前未設定'}」の設定と参考画像を削除します。入力済みの本文・人物名は残ります。`, [{ label: '取消', value: null }, { label: '削除', value: true, className: 'danger' }]);
      busy = false;
      if (yes) { const w = currentWork(); commit({ ...w, characters: w.characters.filter(x => x.id !== c.id) }); updateSpeakers(); }
    }, 'キャラクターを削除'));
    const nameLabel = element('label', 'character-field', '名前');
    const name = document.createElement('input'); name.placeholder = '例：春香'; name.setAttribute('aria-label', 'キャラクター名'); name.className = 'character-name';
    nameLabel.append(name);
    const descriptionLabel = element('label', 'character-field', '人物像・イメージ・説明');
    const description = element('textarea', 'character-description'); description.placeholder = '外見、性格、話し方、背景、ほかの人物との関係など…'; description.setAttribute('aria-label', 'キャラクターの説明'); description.rows = 4;
    descriptionLabel.append(description);
    for (const [el, field] of [[name, 'name'], [description, 'description']]) {
      const finish = () => { const current = currentWork().characters.find(x => x.id === c.id); if (current && current[field] !== el.value) updateCharacter(c.id, { [field]: el.value }, `character:${c.id}:${field}`); };
      el.addEventListener('compositionstart', () => { composingElement = el; history.boundary(); });
      el.addEventListener('compositionend', () => { composingElement = null; finish(); history.boundary(); });
      el.addEventListener('input', e => { if (!e.isComposing && composingElement !== el) finish(); });
      el.addEventListener('blur', () => history.boundary());
    }
    card.append(header, nameLabel, descriptionLabel, makeImageSection({ kind: 'character', id: c.id }));
    return card;
  }
  function renderCharacters() {
    const characters = currentWork().characters, alive = new Set(characters.map(c => c.id));
    for (const [id, node] of characterNodes) if (!alive.has(id)) { node.remove(); characterNodes.delete(id); }
    characters.forEach((c, i) => {
      let node = characterNodes.get(c.id);
      if (!node) { node = makeCharacter(c); characterNodes.set(c.id, node); }
      if ($('characters').children[i] !== node) $('characters').insertBefore(node, $('characters').children[i] || null);
      node.querySelector('.character-heading').textContent = c.name || `キャラクター ${String(i + 1).padStart(2, '0')}`;
      const name = node.querySelector('.character-name'), description = node.querySelector('.character-description');
      if (composingElement !== name) setValue(name, c.name);
      if (composingElement !== description) setValue(description, c.description);
      renderImages(node.querySelector('.image-section'), c.images);
    });
    $('characters-empty').hidden = characters.length > 0; $('character-count').textContent = characters.length;
  }
  function makeScene(s) {
    const card = element('div', 'scene-card'); card.dataset.sceneId = s.id;
    const header = element('div', 'scene-card-header');
    header.append(button('', 'scene-range', () => {
      const scene = currentChapter().scenes.find(x => x.id === s.id);
      activeScene = s.id;
      if (scene.startLineId) range = [scene.startLineId, scene.endLineId];
      updateHighlights();
      if (scene.startLineId) rowNodes.get(scene.startLineId)?.scrollIntoView({ block: 'nearest' });
    }));
    header.append(button('×', 'scene-delete', async () => {
      if (busy) return; busy = true;
      const accepted = await choose('シーン説明を削除', 'この説明を削除します。本文はそのまま残ります。', [{ label: '取消', value: null }, { label: '削除', value: true, className: 'danger' }]);
      busy = false;
      if (accepted) { const ch = currentChapter(); changeChapter({ ...ch, scenes: ch.scenes.filter(x => x.id !== s.id) }); }
    }, 'シーン説明を削除'));
    const description = element('textarea', 'scene-description'); description.placeholder = '場所、時間、人物の表情や動き、光の様子など…'; description.setAttribute('aria-label', 'シーン詳細説明');
    let composing = false;
    const finish = () => { const old = currentChapter().scenes.find(x => x.id === s.id); if (old && old.description !== description.value) updateScene(s.id, { description: description.value }, `scene:${s.id}`); };
    description.addEventListener('compositionstart', () => { composing = true; composingElement = description; });
    description.addEventListener('compositionend', () => { composing = false; composingElement = null; finish(); });
    description.addEventListener('input', () => { if (!composing) finish(); });
    description.addEventListener('focus', () => { activeScene = s.id; updateHighlights(); });
    card.append(header, description, button('選択中の行範囲に紐づける', 'scene-rebind', () => {
      const [a, b] = selectionIndexes(), ch = currentChapter();
      updateScene(s.id, { startLineId: ch.lines[a].id, endLineId: ch.lines[b].id }); activeScene = s.id; updateHighlights();
      toast('シーン説明の対象範囲を変更しました。');
    }));
    card.append(makeImageSection({ kind: 'scene', chapterId: currentChapter().id, id: s.id }));
    return card;
  }
  function renderScenes(ch, force) {
    const alive = new Set(ch.scenes.map(s => s.id));
    for (const [id, node] of sceneNodes) if (!alive.has(id)) { node.remove(); sceneNodes.delete(id); }
    const indexes = new Map(ch.lines.map((l, i) => [l.id, i]));
    ch.scenes.forEach((s, i) => {
      let node = sceneNodes.get(s.id);
      if (!node) { node = makeScene(s); sceneNodes.set(s.id, node); }
      if ($('scenes').children[i] !== node) $('scenes').insertBefore(node, $('scenes').children[i] || null);
      node.querySelector('.scene-range').textContent = s.startLineId === null ? '紐づけ未設定 · 範囲を再指定' : `${indexes.get(s.startLineId) + 1}–${indexes.get(s.endLineId) + 1}行目`;
      const textarea = node.querySelector('textarea');
      if (composingElement !== textarea) setValue(textarea, s.description);
      node.classList.toggle('unbound', s.startLineId === null);
      renderImages(node.querySelector('.image-section'), s.images);
    });
    $('scene-count').textContent = ch.scenes.length;
    $('scene-empty').hidden = ch.scenes.length > 0;
  }
  function updateSpeakers() {
    const names = [...new Set(['地の文', 'システム', ...currentWork().characters.map(c => c.name).filter(Boolean), ...currentWork().chapters.flatMap(ch => ch.lines.map(l => l.speaker)).filter(Boolean)])];
    $('speakers').replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
  }
  function render(force = false) {
    const w = currentWork(), ch = currentChapter();
    if (!ch.lines.some(l => l.id === range[0]) || !ch.lines.some(l => l.id === range[1])) range = [ch.lines[0].id, ch.lines[0].id];
    if (!ch.scenes.some(s => s.id === activeScene)) activeScene = null;
    if (composingElement !== $('work-title')) setValue($('work-title'), w.title);
    if (composingElement !== $('chapter-title')) setValue($('chapter-title'), ch.title);
    const nav = $('chapters');
    const navSignature = w.chapters.map(c => `${c.id}:${c.title}`).join('|') + ch.id;
    if (nav.dataset.signature !== navSignature) {
      nav.replaceChildren(...w.chapters.map((c, i) => {
        const el = button('', `chapter-link${c.id === ch.id ? ' active' : ''}`, () => switchChapter(c.id));
        el.append(element('span', 'chapter-order', String(i + 1).padStart(2, '0')), element('span', 'chapter-name', c.title || '無題の話'));
        el.setAttribute('aria-current', c.id === ch.id ? 'page' : 'false'); return el;
      })); nav.dataset.signature = navSignature;
    }
    const index = w.chapters.indexOf(ch);
    $('chapter-position').textContent = `CHAPTER ${String(index + 1).padStart(2, '0')} / ${String(w.chapters.length).padStart(2, '0')}`;
    $('chapter-up').disabled = index === 0; $('chapter-down').disabled = index === w.chapters.length - 1;
    $('delete-chapter').disabled = w.chapters.length === 1;
    if (composingElement !== $('preview')) setValue($('preview'), C.fullText(ch));
    renderRows(ch, force); renderScenes(ch, force); renderCharacters(); updateHighlights();
    $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length;
    $('save-status').textContent = dirty() ? '未書き出しの変更あり' : writeTime ? `${writeTime} 書き出し操作済み · 保存先をご確認ください` : originLabel;
    $('word-count').textContent = `${[...C.fullText(ch).replace(/\n/g, '')].length.toLocaleString()} 字 · ${ch.lines.length.toLocaleString()} 行`;
    $('footer-stats').textContent = `${w.chapters.length} 話 / ${ch.scenes.length} シーンメモ`;
    lastRendered = ch; lastChapterId = ch.id;
  }
  function switchChapter(id) {
    if (busy || composingElement) return;
    history.present = { ...history.present, chapterId: id }; history.boundary();
    const ch = currentChapter(); range = [ch.lines[0].id, ch.lines[0].id]; activeScene = null;
    render(true); updateSpeakers(); backup();
  }
  function travel(direction) {
    if (busy || composingElement) return;
    history[direction](); render(true); updateSpeakers(); backup();
  }
  function fileName(name) { return (name || '無題').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || '無題'; }
  function download(content, mime, name) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` }), url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function exportJSON() {
    if (pendingImageLoads) { toast('画像の読み込みが終わってからJSONを書き出してください。'); return false; }
    download(JSON.stringify(currentWork(), null, 2), 'application/json', `${fileName(currentWork().title)}.json`);
    writtenWork = currentWork(); writeTime = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    render(); toast('JSONを書き出しました。端末の保存先にファイルがあることを確認してください。');
  }
  async function allowReplace() {
    if (pendingImageLoads) { toast('画像の読み込みが終わってから作品を切り替えてください。'); return false; }
    if (!dirty()) return true;
    const choice = await choose('作業中の作品を切り替えます', 'まだJSONに書き出していない変更があります。作品を残す場合は、先にJSONを書き出してください。', [{ label: '取消', value: null }, { label: '破棄して進む', value: 'discard', className: 'danger' }, { label: 'JSONを書き出して進む', value: 'export', className: 'primary' }]);
    if (choice === 'export') {
      exportJSON();
      return await choose('JSONの保存先を確認', 'ダウンロードの完了はこの画面から確認できません。ファイルが保存されたことを確認してから進んでください。', [{ label: '今の作品に戻る', value: null }, { label: '保存を確認して進む', value: true, className: 'primary' }]);
    }
    return choice === 'discard';
  }
  function replaceWork(w, imported = false) {
    workSession++;
    clearTimeout(backupTimer);
    history.present = { work: w, chapterId: w.chapters[0].id }; history.past = []; history.future = []; history.boundary();
    writtenWork = w; writeTime = ''; originLabel = imported ? 'JSON取り込み済み' : '新規作品';
    range = [w.chapters[0].lines[0].id, w.chapters[0].lines[0].id]; activeScene = null;
    render(true); updateSpeakers(); backup();
  }
  function showScenes(show) {
    $('detail-columns').classList.toggle('show-scenes', show);
    $('toggle-scenes').setAttribute('aria-expanded', String(show));
    $('toggle-scenes').textContent = show ? 'シーンを閉じる' : 'シーンを開く';
  }
  function bindName(id, update) {
    const el = $(id);
    el.addEventListener('compositionstart', () => { composingElement = el; });
    el.addEventListener('compositionend', () => { composingElement = null; update(el.value); });
    el.addEventListener('input', e => { if (!e.isComposing && composingElement !== el) update(el.value); });
    el.addEventListener('blur', () => history.boundary());
  }
  bindName('work-title', value => { if (value !== currentWork().title) commit({ ...currentWork(), title: value }, 'work-title'); });
  bindName('chapter-title', value => { if (value !== currentChapter().title) changeChapter({ ...currentChapter(), title: value }, `title:${currentChapter().id}`); });
  bindTextEditor($('preview'));
  $('undo').onclick = () => travel('undo'); $('redo').onclick = () => travel('redo');
  $('export-json').onclick = exportJSON;
  $('import-button').onclick = () => { if (!busy) $('import-file').click(); };
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; $('import-file').value = ''; if (!file || busy) return;
    busy = true;
    try {
      const imported = C.validateWork(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
      await NovelImages.validateWorkImages(imported);
      if (await allowReplace()) { replaceWork(imported, true); toast('作品JSONを取り込みました。'); }
    } catch (error) { toast(`取り込めませんでした：${error.message}`); }
    finally { busy = false; }
  });
  $('reset').onclick = async () => {
    if (busy) return; busy = true;
    if (await allowReplace()) {
      const ok = await choose('新しい作品を始める', '画面をクリアして、新しい作品を作成します。端末に保存したJSONファイルは削除しません。', [{ label: '取消', value: null }, { label: '新規作品を作成', value: true, className: 'primary' }]);
      if (ok) replaceWork(C.work());
    }
    busy = false;
  };
  $('add-chapter').onclick = () => {
    if (busy) return; const w = currentWork(), ch = C.chapter(`第${w.chapters.length + 1}話`);
    history.push({ work: { ...w, chapters: [...w.chapters, ch] }, chapterId: ch.id }); render(); backup(); $('chapter-title').focus(); $('chapter-title').select();
  };
  function moveChapter(delta) {
    const w = currentWork(), chapters = [...w.chapters], index = chapters.findIndex(c => c.id === currentChapter().id), other = index + delta;
    if (other < 0 || other >= chapters.length) return;
    [chapters[index], chapters[other]] = [chapters[other], chapters[index]]; commit({ ...w, chapters });
  }
  $('chapter-up').onclick = () => moveChapter(-1); $('chapter-down').onclick = () => moveChapter(1);
  $('delete-chapter').onclick = async () => {
    if (busy || currentWork().chapters.length < 2) return; busy = true;
    const ch = currentChapter();
    const ok = await choose('話を削除', `「${ch.title}」の本文とシーン説明を削除します。「元に戻す」で復元できます。`, [{ label: '取消', value: null }, { label: 'この話を削除', value: true, className: 'danger' }]);
    busy = false;
    if (ok) {
      const w = currentWork(), chapters = w.chapters.filter(c => c.id !== ch.id);
      history.push({ work: { ...w, chapters }, chapterId: chapters[0].id }); render(true); backup();
    }
  };
  $('add-line').onclick = () => {
    const ch = currentChapter(), [, b] = selectionIndexes(), pos = C.offsets(ch)[b] + ch.lines[b].text.length;
    void applyText(pos, pos, '\n', 'detail', null);
  };
  $('delete-lines').onclick = async () => {
    if (busy) return; busy = true;
    const ch = currentChapter(), [a, b] = selectionIndexes();
    const selectedIds = ch.lines.slice(a, b + 1).map(l => l.id);
    const ok = await choose('選択した本文行を削除', `${a + 1}–${b + 1}行目を削除します。対象を失ったシーン説明は「紐づけ未設定」として残ります。`, [{ label: '取消', value: null }, { label: '行を削除', value: true, className: 'danger' }]);
    busy = false;
    if (ok) changeChapter(C.removeLines(currentChapter(), selectedIds));
  };
  $('add-scene').onclick = () => {
    if (busy) return;
    const ch = currentChapter(), [a, b] = selectionIndexes();
    const scene = { id: C.uid('scene'), startLineId: ch.lines[a].id, endLineId: ch.lines[b].id, description: '', images: [], nextImageNumber: 1 };
    activeScene = scene.id; changeChapter({ ...ch, scenes: [...ch.scenes, scene] }); showScenes(true);
    const el = sceneNodes.get(scene.id).querySelector('textarea'); el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' });
  };
  $('toggle-scenes').onclick = () => showScenes(!$('detail-columns').classList.contains('show-scenes'));
  function showCharacters(show) {
    $('characters-body').hidden = !show;
    $('collapse-characters').textContent = show ? '折りたたむ −' : '開く ＋';
    $('collapse-characters').setAttribute('aria-expanded', String(show));
  }
  $('show-characters').onclick = () => { showCharacters(true); $('characters-panel').scrollIntoView({ block: 'start' }); };
  $('collapse-characters').onclick = () => showCharacters($('characters-body').hidden);
  $('add-character').onclick = () => {
    if (busy) return; const c = C.character(), w = currentWork();
    commit({ ...w, characters: [...w.characters, c] }); showCharacters(true);
    const input = characterNodes.get(c.id).querySelector('.character-name'); input.focus();
  };
  $('close-image').onclick = () => $('image-dialog').close();
  $('image-dialog').addEventListener('close', () => $('image-preview').removeAttribute('src'));
  $('export-txt').onclick = () => {
    const all = $('txt-scope').value === 'work';
    const text = all ? currentWork().chapters.map(C.fullText).join('\n\n') : C.fullText(currentChapter());
    const name = all ? currentWork().title : `${currentWork().title}_${currentChapter().title}`;
    download(text, 'text/plain', `${fileName(name)}.txt`); toast('本文だけをTXTに書き出しました。');
  };
  for (const direction of ['horizontal', 'vertical']) $(direction).onclick = () => {
    $('preview').classList.toggle('vertical', direction === 'vertical');
    for (const other of ['horizontal', 'vertical']) { $(other).classList.toggle('active', other === direction); $(other).setAttribute('aria-pressed', String(other === direction)); }
  };
  $('font-size').oninput = () => { $('preview').style.fontSize = `${$('font-size').value}px`; $('font-size-value').textContent = $('font-size').value; };
  $('column-width').oninput = () => document.documentElement.style.setProperty('--scene-width', `${$('column-width').value}%`);
  $('collapse-preview').onclick = () => {
    const hidden = !$('preview-body').hidden; $('preview-body').hidden = hidden;
    $('collapse-preview').textContent = hidden ? '開く ＋' : '折りたたむ −'; $('collapse-preview').setAttribute('aria-expanded', String(!hidden));
  };
  function sampleWork() {
    const w = C.work(); w.title = '雨あがりの栞'; const ch = w.chapters[0]; ch.title = '第1話　窓辺の約束';
    ch.lines = [C.line('雨がやんだのは、午後三時を少し過ぎた頃だった。', '地の文'), C.line('「この本、まだ覚えてる？」', '紬'), C.line('窓辺に立つ紬が、青い表紙をこちらに向ける。', '地の文'), C.line('「忘れるわけないだろ。最後のページ、まだ読んでないんだから」', '遥'), C.line('', ''), C.line('濡れた街路樹から、一滴の光が落ちた。', '地の文')];
    ch.scenes = [{ id: C.uid('scene'), startLineId: ch.lines[0].id, endLineId: ch.lines[3].id, description: '雨あがりの古い図書室。西向きの窓から柔らかな光。紬は青い本を両手で持ち、少し照れた表情。遥は机のそばで振り返っている。' }, { id: C.uid('scene'), startLineId: ch.lines[1].id, endLineId: ch.lines[2].id, description: '本の角は擦れている。表紙から細い白い栞がのぞく。紬の指先と本を近景で。' }];
    ch.scenes = ch.scenes.map(s => ({ ...s, images: [], nextImageNumber: 1 }));
    return w;
  }
  $('load-sample').onclick = async () => { if (busy) return; busy = true; if (await allowReplace()) { replaceWork(sampleWork()); toast('サンプル作品を開きました。自由に編集して試せます。'); } busy = false; };
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.isComposing || composingElement || busy || $('dialog').open || $('image-dialog').open) return;
    const key = event.key.toLowerCase();
    if (key === 'z') { event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo'); }
    else if (key === 'y') { event.preventDefault(); travel('redo'); }
    else if (key === 's') { event.preventDefault(); exportJSON(); }
  });
  window.addEventListener('beforeunload', event => { if (dirty() || composingElement || pendingImageLoads) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && storageEnabled && !composingElement && !busy) {
      try { localStorage.setItem(RECOVERY_KEY, JSON.stringify({ work: currentWork(), chapterId: currentChapter().id, savedAt: new Date().toISOString() })); } catch { /* The regular backup path reports storage failures. */ }
    }
  });
  render(); updateSpeakers();
  (async function restore() {
    let saved;
    try { const value = localStorage.getItem(RECOVERY_KEY); if (value) saved = JSON.parse(value); }
    catch { storageEnabled = false; $('recovery-status').textContent = '自動復元は利用できません'; return; }
    if (!saved) { $('recovery-status').textContent = 'JSONで作品を保存'; return; }
    let w; busy = true;
    try { w = C.validateWork(saved.work); await NovelImages.validateWorkImages(w); }
    catch { busy = false; $('recovery-status').textContent = '復元用コピーを読み込めません'; return; }
    const yes = await choose('前回の作業を復元', `このブラウザに復元用コピーがあります。\n作品：${w.title}\n${saved.savedAt ? new Date(saved.savedAt).toLocaleString('ja-JP') : ''}\nJSONへの書き出しとは別の補助コピーです。`, [{ label: '新規から始める', value: false }, { label: '復元する', value: true, className: 'primary' }]);
    if (yes !== false) {
      replaceWork(w); writtenWork = null;
      if (w.chapters.some(c => c.id === saved.chapterId)) history.present = { work: w, chapterId: saved.chapterId };
      render(true); $('recovery-status').textContent = '前回の作業を復元しました';
    } else backup();
    busy = false;
  })();
})();
