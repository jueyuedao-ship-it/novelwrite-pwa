/* Chapter-workspace application controller. Loaded after app.js and before lazy editor extensions. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const baseWorkspace = root.NovelWorkspace;
  const modeTools = root.NovelWorkspaceMode;
  if (!baseWorkspace || !modeTools || !root.NovelStorage) return;

  let db = null, workspaceMeta = null, modulesPromise = null, operationImageLoads = 0, operationComposition = 0;
  let reloadGuard = false, observer = null, applyingUi = false;
  const busy = () => document.querySelector('[aria-busy="true"]') !== null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function toast(message) { baseWorkspace.toast(message); }

  async function openDb() {
    if (!db) db = await root.NovelStorage.openStore();
    return db;
  }

  async function refreshMeta() {
    workspaceMeta = await root.NovelStorage.loadWorkspaceMeta(await openDb());
    return workspaceMeta;
  }

  async function loadModules() {
    if (!modulesPromise) {
      modulesPromise = (async () => {
        if (!root.NovelArchiveCommon) await import(new URL('./archive-common.js', location.href).href);
        if (!root.NovelChapterBundle) await import(new URL('./chapter-bundle.js', location.href).href);
        if (!root.NovelChapterArchive) await import(new URL('./chapter-archive.js', location.href).href);
        if (!root.NovelArchive) await import(new URL('./archive.js', location.href).href);
        if (!root.NovelArchiveCommon || !root.NovelChapterBundle || !root.NovelChapterArchive || !root.NovelArchive) {
          throw new Error('章ZIP処理モジュールを読み込めませんでした。');
        }
        return { common: root.NovelArchiveCommon, bundle: root.NovelChapterBundle, archive: root.NovelChapterArchive, workArchive: root.NovelArchive };
      })().catch(error => { modulesPromise = null; throw error; });
    }
    return modulesPromise;
  }

  async function waitForSaved() {
    const deadline = Date.now() + 15000;
    const status = $('save-status');
    while (Date.now() < deadline) {
      const text = status?.textContent || '';
      if (/失敗|競合/.test(text)) throw new Error(text || '現在の変更を保存できませんでした。');
      if (!/保存中|未保存|起動しています/.test(text)) return;
      await sleep(80);
    }
    throw new Error('現在の変更の保存完了を確認できませんでした。');
  }

  async function assertFileOperationReady() {
    if (busy()) throw new Error('別の処理が完了してからやり直してください。');
    if (operationComposition > 0) throw new Error('入力変換を確定してからやり直してください。');
    if (operationImageLoads > 0) throw new Error('画像の読み込みが終わってからやり直してください。');
    await waitForSaved();
  }

  function filename(name) {
    return (name || '章').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || '章';
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function exportChapter(chapterId) {
    try {
      await assertFileOperationReady();
      const currentMeta = await refreshMeta();
      const currentState = baseWorkspace.getState();
      const targetId = chapterId || currentMeta?.loadedChapterIds?.[0] || currentState?.work?.chapters?.[0]?.id;
      if (!targetId) throw new Error('保存する章がありません。');
      const modules = await loadModules();
      const bundle = modules.bundle.buildChapterBundle(currentState.work, currentState.images, targetId);
      const blob = await modules.archive.exportChapterArchive(bundle);
      const title = currentState.work.chapters.find(item => item.id === targetId)?.title || '章';
      download(blob, `${filename(title)}.chapter.zip`);
      toast('章ZIPのダウンロードを開始しました。');
    } catch (error) { toast(`章ZIPを書き出せませんでした：${error.message}`); }
  }

  async function importChapter(file) {
    try {
      await assertFileOperationReady();
      const modules = await loadModules();
      const imported = await modules.archive.importChapterArchive(file);
      await root.NovelStorage.saveChapterWorkspace(await openDb(), imported.bundle, {
        loadedChapterIds: [imported.manifest.chapterId],
        catalog: imported.manifest.catalog,
        sourceManifest: imported.manifest,
        masterBaseline: imported.masterBaseline
      });
      location.reload();
    } catch (error) { toast(`章ZIPを開けませんでした：${error.message}`); }
  }

  function beginComposition() {
    operationComposition++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      operationComposition = Math.max(0, operationComposition - 1);
    };
  }

  function renderCatalog() {
    const host = $('chapter-catalog');
    if (!host) return;
    const chapterMode = workspaceMeta?.mode === 'chapter-workspace';
    host.hidden = !chapterMode;
    if (!chapterMode) { host.replaceChildren(); return; }
    const list = document.createElement('div'); list.className = 'chapter-catalog-list';
    const title = document.createElement('strong'); title.textContent = '章カタログ'; list.append(title);
    for (const item of workspaceMeta.catalog) {
      const row = document.createElement('div');
      const loaded = workspaceMeta.loadedChapterIds.includes(item.id);
      row.className = `chapter-catalog-row${loaded ? ' loaded' : ' unloaded'}`;
      const mark = document.createElement('span'); mark.textContent = loaded ? '編集中' : '未読込';
      const text = document.createElement('span'); text.textContent = item.title || '無題の章';
      row.append(mark, text); list.append(row);
    }
    host.replaceChildren(list);
  }

  function ensureReadonlyNote(host, className, text) {
    if (!host || host.querySelector(`.${className}`)) return;
    const note = document.createElement('p'); note.className = className; note.textContent = text; host.prepend(note);
  }

  function protectCharacters() {
    if (workspaceMeta?.mode !== 'chapter-workspace') return;
    const host = $('characters-extension');
    if (!host) return;
    ensureReadonlyNote(host, 'character-readonly-note', '章ワークスペースでは、キャラクター設定はマスター作品のスナップショットとして参照専用です。');
    host.querySelectorAll('input, textarea, select').forEach(control => { control.disabled = true; control.setAttribute('aria-readonly', 'true'); });
    host.querySelectorAll('button').forEach(button => {
      const text = button.textContent || '';
      const label = button.getAttribute('aria-label') || '';
      const allowed = button.classList.contains('character-select') || button.closest('.character-pagination') ||
        button.closest('.character-image-tools') || /画像を拡大/.test(label) || /^(前の人物|次の人物|参考画像を表示|参考画像を閉じる)/.test(text);
      if (!allowed) button.disabled = true;
    });
  }

  function protectPlotSharedData() {
    if (workspaceMeta?.mode !== 'chapter-workspace') return;
    const host = $('plot-extension');
    if (!host) return;
    const overview = host.querySelector('.plot-overview');
    if (overview) {
      ensureReadonlyNote(overview, 'chapter-overview-readonly-note', '作品概要・詳細設定は共有データです。詳細設定はマスター作品で編集してください。');
      overview.querySelectorAll('.plot-overview-text, textarea, input, select').forEach(control => { control.disabled = true; control.setAttribute('aria-readonly', 'true'); });
      overview.querySelectorAll('.plot-overview-detail-button').forEach(button => { button.disabled = true; button.hidden = true; });
    }
    const chapterPanel = [...host.querySelectorAll('.plot-list-panel')].find(panel => panel.querySelector('h2')?.textContent === '章');
    if (chapterPanel) {
      [...chapterPanel.querySelectorAll('button')].forEach(button => {
        if (button.textContent === '＋ 章' || button.textContent === '↑' || button.textContent === '↓') button.disabled = true;
      });
    }
  }

  function injectChapterExportButtons() {
    document.querySelectorAll('.plot-structure-row[data-chapter-id]').forEach(row => {
      if (row.querySelector('.chapter-zip-export')) return;
      const chapterId = row.dataset.chapterId;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'quiet plot-small-action chapter-zip-export'; button.textContent = '章ZIP保存';
      button.setAttribute('aria-label', 'この章をZIP保存');
      button.addEventListener('click', event => { event.stopPropagation(); void exportChapter(chapterId); });
      row.append(button);
    });
  }

  function applyModeUi() {
    if (applyingUi) return;
    applyingUi = true;
    try {
      const chapterMode = workspaceMeta?.mode === 'chapter-workspace';
      const strip = $('workspace-mode-strip');
      if (strip) {
        strip.hidden = !chapterMode;
        if (chapterMode) {
          const id = workspaceMeta.loadedChapterIds[0];
          const item = workspaceMeta.catalog.find(chapter => chapter.id === id);
          const text = `章ワークスペース · ${item?.title || '読み込み済み章'}のみを編集中 · 作品全体ではありません`;
          if (strip.textContent !== text) strip.textContent = text;
        }
      }
      const workTitle = $('work-title'); if (workTitle) { workTitle.disabled = chapterMode; workTitle.setAttribute('aria-readonly', String(chapterMode)); }
      const importButton = $('import-button');
      if (importButton) {
        importButton.disabled = false;
        const text = chapterMode ? 'マスター作品ZIPを開く' : '作品ZIPを開く';
        if (importButton.textContent !== text) importButton.textContent = text;
      }
      const seriesImportButton = $('import-series-button'); if (seriesImportButton) seriesImportButton.disabled = chapterMode;
      const reset = $('reset'); if (reset) reset.disabled = chapterMode;
      const sample = $('load-sample'); if (sample) sample.disabled = chapterMode;
      const exportButton = $('export-archive'); if (exportButton) exportButton.firstChild.textContent = chapterMode ? '章ZIPで保存 ' : 'シリーズZIPで保存 ';
      const workOption = $('txt-scope')?.querySelector('option[value="work"]');
      if (workOption) {
        const text = chapterMode ? '読み込み済み章' : '作品全体';
        if (workOption.textContent !== text) workOption.textContent = text;
      }
      renderCatalog();
      injectChapterExportButtons();
      protectPlotSharedData();
      protectCharacters();
    } finally { applyingUi = false; }
  }

  const wrappedWorkspace = {
    ...baseWorkspace,
    commit(nextState, patch = null, historyKey = null) {
      modeTools.assertPatchAllowed(workspaceMeta, patch, baseWorkspace.getState());
      return baseWorkspace.commit(nextState, patch, historyKey);
    },
    beginImageLoad() {
      operationImageLoads++;
      const finishBase = baseWorkspace.beginImageLoad();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        operationImageLoads = Math.max(0, operationImageLoads - 1);
        finishBase();
      };
    },
    getWorkspaceMeta: () => workspaceMeta,
    isChapterWorkspace: () => workspaceMeta?.mode === 'chapter-workspace',
    assertFileOperationReady,
    exportChapter,
    importChapter
  };
  root.NovelWorkspace = wrappedWorkspace;

  $('import-chapter-button')?.addEventListener('click', () => $('import-chapter-file')?.click());
  $('import-chapter-file')?.addEventListener('change', () => {
    const input = $('import-chapter-file'); const file = input?.files?.[0]; if (input) input.value = ''; if (file) void importChapter(file);
  });
  $('export-archive')?.addEventListener('click', event => {
    if (workspaceMeta?.mode !== 'chapter-workspace') return;
    event.preventDefault(); event.stopImmediatePropagation(); void exportChapter();
  }, { capture: true });
  document.addEventListener('keydown', event => {
    if (workspaceMeta?.mode !== 'chapter-workspace' || event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault(); event.stopImmediatePropagation(); void exportChapter();
  }, { capture: true });
  document.addEventListener('compositionstart', () => { operationComposition++; }, { capture: true });
  document.addEventListener('compositionend', () => { operationComposition = Math.max(0, operationComposition - 1); }, { capture: true });

  void (async () => {
    try {
      await refreshMeta();
      applyModeUi();
      observer = new MutationObserver(() => applyModeUi());
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (error) { console.error(error); }
  })();
})(globalThis);