(function (root) {
  'use strict';

  const uid = prefix => root.NovelCore?.uid ? root.NovelCore.uid(prefix) : `${prefix}-${root.crypto.randomUUID()}`;

  function createCharacter(workId) {
    return {
      id: uid('character'), workId, name: '', role: '', description: '', appearance: '', personality: '',
      goal: '', background: '', relationshipNotes: '', customFields: [], imageIds: []
    };
  }

  function addCustomField(character, label = '', value = '') {
    const field = { id: uid('field'), label, value };
    return { ...character, customFields: [...character.customFields, field] };
  }

  function removeCustomField(character, fieldId) {
    return { ...character, customFields: character.customFields.filter(field => field.id !== fieldId) };
  }

  function detachImage(character, imageId) {
    return { ...character, imageIds: character.imageIds.filter(id => id !== imageId) };
  }

  async function renameCharacter(state, characterId, name, loadEpisode) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('人物名を入力してください。');
    const character = state.characters.find(item => item.id === characterId);
    if (!character) throw new Error('改名する人物が見つかりません。');
    const characters = state.characters.map(item => item.id === characterId ? { ...item, name } : item);
    const episodesById = { ...state.episodesById };
    const beforeEpisodes = [];
    const changedEpisodes = [];
    for (let offset = 0; offset < state.episodeMetas.length; offset += 8) {
      const batch = await Promise.all(state.episodeMetas.slice(offset, offset + 8).map(async meta => {
        const cached = episodesById[meta.id];
        const episode = Array.isArray(cached?.lines) ? cached : await loadEpisode(meta.id);
        if (!episode || !Array.isArray(episode.lines)) throw new Error(`「${meta.title}」の本文を読み込めません。`);
        return episode;
      }));
      for (const episode of batch) {
        const lines = episode.lines.map(line => line.characterId === characterId && line.speaker !== name ? { ...line, speaker: name } : line);
        if (lines.some((line, index) => line !== episode.lines[index])) {
          const updated = { ...episode, lines };
          beforeEpisodes.push(episode);
          episodesById[episode.id] = updated;
          changedEpisodes.push(updated);
        }
      }
    }
    return {
      nextState: { ...state, characters, episodesById },
      beforeEpisodes,
      patch: {
        workId: state.work.id,
        characters: { upsert: characters.filter(item => item.id === characterId), deleteIds: [] },
        episodes: { upsert: changedEpisodes, deleteIds: [] }
      }
    };
  }

  function mount() {
    const host = document.getElementById('characters-extension');
    const workspace = root.NovelWorkspace;
    if (!host || !workspace) return;
    const editorState = root.NovelEditorState;
    const pageSize = 20;
    const loadedImages = new Map();
    const imageUrls = new Map();
    let page = 0, selectedId = null, imagesOpen = false, renderGeneration = 0;

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
    const getState = () => workspace.getState();
    const revokeImages = () => { for (const url of imageUrls.values()) URL.revokeObjectURL(url); imageUrls.clear(); };

    function commitPatch(patch, historyKey = null) {
      const state = getState();
      return workspace.commit(editorState.applyPatch(state, patch), patch, historyKey);
    }

    function addField(parent, labelText, value, update, options = {}) {
      const label = node('label', 'character-workspace-field'); label.append(node('span', '', labelText));
      const control = node(options.multiline ? 'textarea' : 'input');
      control.setAttribute('aria-label', labelText); control.value = value ?? '';
      control.addEventListener(options.commitOnChange ? 'change' : 'input', () => update(control.value));
      label.append(control); parent.append(label); return control;
    }

    function pagination(total) {
      const controls = node('div', 'character-pagination');
      const start = total ? page * pageSize + 1 : 0, end = Math.min(total, (page + 1) * pageSize);
      controls.append(makeButton('前の人物', () => { page = Math.max(0, page - 1); void render(); }, 'quiet'));
      controls.append(node('span', '', `${start}–${end} / ${total}`));
      controls.append(makeButton('次の人物', () => { page = Math.min(Math.ceil(total / pageSize) - 1, page + 1); void render(); }, 'quiet'));
      controls.firstElementChild.disabled = page <= 0;
      controls.lastElementChild.disabled = page >= Math.ceil(total / pageSize) - 1;
      return controls;
    }

    async function loadImages(character) {
      const records = [];
      for (const id of character.imageIds) {
        let image = loadedImages.get(id) || getState().imagesById[id];
        if (!image?.blob) image = await workspace.loadImage(id);
        if (image) { loadedImages.set(id, image); records.push(image); }
      }
      return records;
    }

    async function readImage(file) {
      if (file.size > root.NovelCore.MAX_IMAGE_BYTES) throw new Error(`「${file.name}」は10MBを超えています。`);
      const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
      const mimeType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
        ? file.type : extensions[file.name.split('.').at(-1).toLowerCase()];
      if (!mimeType) throw new Error('PNG・JPEG・WebP・GIFの画像を選んでください。');
      const blob = new Blob([await file.arrayBuffer()], { type: mimeType });
      await root.NovelPackage.validateImageBlob(mimeType, blob);
      return { id: root.NovelCore.uid('image'), name: file.name, mimeType, blob };
    }

    async function render() {
      if (document.getElementById('screen-characters')?.hidden) return;
      const generation = ++renderGeneration, state = getState();
      const characters = state.characters.slice().sort((left, right) => left.name.localeCompare(right.name, 'ja') || left.id.localeCompare(right.id));
      if (!selectedId || !characters.some(character => character.id === selectedId)) selectedId = characters[0]?.id || null;
      if (page * pageSize >= characters.length) page = Math.max(0, Math.ceil(characters.length / pageSize) - 1);
      if (!selectedId && characters.length) selectedId = characters[page * pageSize]?.id || characters[0].id;
      const character = characters.find(item => item.id === selectedId);
      if (generation !== renderGeneration) return;
      host.className = 'characters-extension-panel'; host.replaceChildren();
      const editor = node('div', 'characters-editor'); editor.id = 'characters-editor';
      const listPanel = node('section', 'character-directory'); listPanel.append(node('h2', '', '人物一覧'));
      listPanel.append(makeButton('＋ 人物', () => {
        const latest = getState(), record = createCharacter(latest.work.id), updated = [...latest.characters, record];
        commitPatch({ workId: latest.work.id, characters: { upsert: [record], deleteIds: [] } });
        selectedId = record.id; page = Math.floor((updated.length - 1) / pageSize); imagesOpen = false; void render();
      }, 'accent'));
      const cards = node('div', 'character-directory-list');
      characters.slice(page * pageSize, (page + 1) * pageSize).forEach(item => {
        const card = node('article', `character-card${item.id === selectedId ? ' selected' : ''}`);
        card.append(makeButton(`人物：${item.name || '名前未設定'}`, () => { selectedId = item.id; imagesOpen = false; revokeImages(); void render(); }, 'character-select'));
        cards.append(card);
      });
      listPanel.append(cards, pagination(characters.length)); editor.append(listPanel);

      const details = node('section', 'character-workspace-details');
      if (character) {
        const title = node('div', 'character-workspace-heading');
        title.append(node('h2', '', character.name || '人物設定'));
        details.append(title);
        addField(details, '人物名', character.name, async name => {
          if (name === character.name) return;
          try {
            const snapshot = getState();
            const renamed = await renameCharacter(snapshot, character.id, name, id => workspace.loadEpisode(id));
            const currentBeforeHydration = getState();
            const uncachedBeforeEpisodes = renamed.beforeEpisodes.filter(episode => !Array.isArray(currentBeforeHydration.episodesById[episode.id]?.lines));
            workspace.hydrate({ workId: snapshot.work.id, episodes: { upsert: uncachedBeforeEpisodes, deleteIds: [] } });
            const latest = getState();
            const updates = renamed.patch.episodes.upsert.map(record => {
              const current = latest.episodesById[record.id];
              if (!Array.isArray(current?.lines)) return record;
              return { ...current, lines: current.lines.map(line => line.characterId === character.id ? { ...line, speaker: name } : line) };
            });
            const patch = {
              ...renamed.patch,
              characters: { upsert: [{ ...latest.characters.find(item => item.id === character.id), name }], deleteIds: [] },
              episodes: { upsert: updates, deleteIds: [] }
            };
            workspace.commit(editorState.applyPatch(latest, patch), patch, `character:${character.id}:name`);
            await render();
          } catch (error) { workspace.toast(`人物名を変更できませんでした：${error.message}`); await render(); }
        }, { commitOnChange: true });
        const commitField = key => value => {
          const latest = getState(), current = latest.characters.find(item => item.id === character.id);
          if (!current || current[key] === value) return;
          const updated = { ...current, [key]: value };
          commitPatch({ workId: latest.work.id, characters: { upsert: [updated], deleteIds: [] } }, `character:${character.id}:${key}`);
        };
        addField(details, '人物の役割', character.role, commitField('role'));
        addField(details, '人物の外見', character.appearance, commitField('appearance'), { multiline: true });
        addField(details, '人物の性格', character.personality, commitField('personality'), { multiline: true });
        addField(details, '人物の目的', character.goal, commitField('goal'), { multiline: true });
        addField(details, '人物の背景', character.background, commitField('background'), { multiline: true });
        addField(details, '人物の関係メモ', character.relationshipNotes, commitField('relationshipNotes'), { multiline: true });
        addField(details, '人物の補足説明', character.description, commitField('description'), { multiline: true });

        const custom = node('section', 'character-custom-fields'); custom.append(node('h3', '', '自由項目'));
        custom.append(makeButton('自由項目を追加', () => {
          const latest = getState(), current = latest.characters.find(item => item.id === character.id);
          const updated = addCustomField(current);
          commitPatch({ workId: latest.work.id, characters: { upsert: [updated], deleteIds: [] } }); void render();
        }, 'quiet'));
        character.customFields.forEach(field => {
          const row = node('div', 'character-custom-row');
          const name = addField(row, '自由項目名', field.label, value => updateCustom(field.id, { label: value }));
          const value = addField(row, '自由項目の内容', field.value, text => updateCustom(field.id, { value: text }), { multiline: true });
          row.append(makeButton('項目を削除', () => {
            const latest = getState(), current = latest.characters.find(item => item.id === character.id), updated = removeCustomField(current, field.id);
            commitPatch({ workId: latest.work.id, characters: { upsert: [updated], deleteIds: [] } }); void render();
          }, 'quiet danger'));
          custom.append(row);
        });
        function updateCustom(fieldId, values) {
          const latest = getState(), current = latest.characters.find(item => item.id === character.id);
          const updated = { ...current, customFields: current.customFields.map(field => field.id === fieldId ? { ...field, ...values } : field) };
          commitPatch({ workId: latest.work.id, characters: { upsert: [updated], deleteIds: [] } }, `character:${character.id}:custom:${fieldId}`);
        }
        details.append(custom);

        const imagePanel = node('section', 'character-image-panel'); imagePanel.append(node('h3', '', '参考画像'));
        const fileInput = node('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
        fileInput.setAttribute('aria-label', 'キャラクターの参考画像ファイル'); imagePanel.append(fileInput);
        fileInput.addEventListener('change', async () => {
          if (!fileInput.files.length) return;
          const finishImageLoad = workspace.beginImageLoad();
          try {
            const records = [];
            for (const file of fileInput.files) records.push(await readImage(file));
            const latest = getState(), current = latest.characters.find(item => item.id === character.id);
            if (!current) throw new Error('人物が見つかりません。');
            const images = records.map((image, index) => ({
              id: image.id, workId: latest.work.id, ownerType: 'character', ownerId: current.id,
              order: current.imageIds.length + index, name: image.name, mimeType: image.mimeType, referenceNumber: null, blob: image.blob
            }));
            const updated = { ...current, imageIds: [...current.imageIds, ...images.map(image => image.id)] };
            images.forEach(image => loadedImages.set(image.id, image));
            commitPatch({ workId: latest.work.id, characters: { upsert: [updated], deleteIds: [] }, images: { upsert: images, deleteIds: [] } });
            await render();
          } catch (error) { workspace.toast(`参考画像を追加できませんでした：${error.message}`); }
          finally { finishImageLoad(); }
        });
        const imageTools = node('div', 'character-image-tools');
        imageTools.append(makeButton('参考画像を表示', async () => {
          imagesOpen = !imagesOpen; revokeImages();
          if (imagesOpen) {
            try {
              const images = await loadImages(character);
              if (!imagesOpen || document.getElementById('screen-characters')?.hidden) { loadedImages.clear(); return; }
              images.forEach(image => imageUrls.set(image.id, URL.createObjectURL(image.blob)));
            } catch (error) { workspace.toast(`参考画像を読み込めませんでした：${error.message}`); }
          } else loadedImages.clear();
          await render();
        }, 'quiet'));
        if (character.imageIds.length) imageTools.append(node('span', '', `${character.imageIds.length}枚`));
        imagePanel.append(imageTools);
        if (imagesOpen) {
          const gallery = node('div', 'character-image-gallery');
          for (const imageId of character.imageIds) {
            const image = loadedImages.get(imageId) || getState().imagesById[imageId];
            if (!image?.blob) { gallery.append(node('p', '', '画像を読み込み中…')); continue; }
            const figure = node('figure', 'character-image-tile');
            if (!imageUrls.has(image.id)) imageUrls.set(image.id, URL.createObjectURL(image.blob));
            const img = node('img', 'character-image'); img.src = imageUrls.get(image.id); img.alt = image.name;
            figure.append(img, node('figcaption', '', image.name));
            figure.append(makeButton('画像を削除', () => { void removeImage(character, image.id); }, 'quiet danger'));
            gallery.append(figure);
          }
          imagePanel.append(gallery);
        }
        details.append(imagePanel);
      } else {
        details.append(node('p', 'character-empty-detail', '人物を追加して、設定や参考画像を記録できます。'));
      }
      editor.append(details); host.append(editor);
    }

    async function removeImage(character, imageId) {
      const latest = getState(), current = latest.characters.find(item => item.id === character.id), workId = latest.work.id;
      if (!current) return;
      let ownerImages;
      try {
        ownerImages = await Promise.all(current.imageIds.map(async id => {
          const image = loadedImages.get(id) || getState().imagesById[id];
          return image?.blob ? image : workspace.loadImage(id);
        }));
        if (ownerImages.some(image => !image?.blob)) throw new Error('画像本体が保存先に見つかりません。');
      } catch (error) { workspace.toast(`人物画像を削除できません：${error.message}`); return; }
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
    }

    async function openCharacter(characterId) {
      const characters = getState().characters.slice().sort((left, right) => left.name.localeCompare(right.name, 'ja') || left.id.localeCompare(right.id));
      const index = characters.findIndex(character => character.id === characterId);
      if (index < 0) { workspace.toast('開く人物設定が見つかりません。'); return false; }
      selectedId = characterId; page = Math.floor(index / pageSize); imagesOpen = false; revokeImages();
      await render();
      return true;
    }

    workspace.subscribe(event => {
      if (event.reason === 'package') {
        selectedId = null; page = 0; imagesOpen = false; loadedImages.clear(); revokeImages();
      } else if (event.reason === 'history') {
        if (!event.state.characters.some(character => character.id === selectedId)) selectedId = null;
        imagesOpen = false; loadedImages.clear(); revokeImages();
      }
      if (event.reason === 'screen' && document.getElementById('screen-characters')?.hidden) {
        imagesOpen = false; loadedImages.clear(); revokeImages();
      }
      if (!document.getElementById('screen-characters')?.hidden) void render();
    });
    root.NovelCharacters.openCharacter = openCharacter;
  }

  const api = { createCharacter, addCustomField, removeCustomField, detachImage, renameCharacter, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelCharacters = api;
})(globalThis);

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => globalThis.NovelCharacters?.mount());
