/* Chapter-workspace orchestration and UI adapter. Loaded after app.js, before lazy extensions. */
(function (root) {
  'use strict';

  const baseWorkspace = root.NovelWorkspace;
  const modeTools = root.NovelWorkspaceMode;
  if (!baseWorkspace || !modeTools || !root.NovelStorage) return;

  const $ = id => document.getElementById(id);
  let workspaceMeta = null;
  let controllerDb = null;
  let expectedImportChapterId = null;
  let archiveLoadPromise = null;
  let applyingUi = false;
  let catalogSignature = '';

  const clone = value => value == null ? null : structuredClone(value);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const filename = name => (name || '無題').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || '無題';

  function toast(message) { baseWorkspace.toast(message); }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function loadArchiveModules() {
    if (!archiveLoadPromise) {
      archiveLoadPromise = (async () => {
        for (const path of ['./archive-common.js', './chapter-bundle.js', './archive.js', './chapter-archive.js']) {
          await import(new URL(path, location.href).href);
        }
        if (!root.NovelArchiveCommon || !root.NovelChapterBundle || !root.NovelArchive || !root.NovelChapterArchive) {
          throw new Error('ZIP処理モジュールを読み込めませんでした。');
        }
        return { common: root.NovelArchiveCommon, full: root.NovelArchive, chapter: root.NovelChapterArchive };
      })().catch(error => { archiveLoadPromise = null; throw error; });
    }
    return archiveLoadPromise;
  }

  async function waitForAppReady() {
    const end = Date.now() + 15000;
    while ($('main')?.dataset.ready !== 'true') {
      if (Date.now() > end) throw new Error('作品データの起動が完了しませんでした。');
      await sleep(20);
    }
  }

  async function waitForSaved() {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const text = $('save-status')?.textContent || '';
      if (/保存できません|保存先を利用できません/.test(text)) throw new Error(text);
      const imageBusy = Boolean(document.querySelector('.image-add:disabled'));
      if (text.includes('保存済み') && !imageBusy) return;
      await sleep(40);
    }
    throw new Error('端末内への保存が完了していません。');
  }

  async function ensureControllerDb(refresh = false) {
    if (refresh && controllerDb) { try { controllerDb.close(); } catch {} controllerDb = null; }
    if (!controllerDb) controllerDb = await root.NovelStorage.openStore();
    return controllerDb;
  }

  async function refreshWorkspaceMeta() {
    const wasChapter = workspaceMeta?.mode === 'chapter-workspace';
    const db = await ensureControllerDb(true);
    const nextMeta = await root.NovelStorage.loadWorkspaceMeta(db);
    workspaceMeta = nextMeta;
    if (wasChapter && !nextMeta) { location.reload(); return null; }
    catalogSignature = '';
    applyModeUi();
    return workspaceMeta;
  }

  async function exportChapter(chapterId) {
    if (typeof chapterId !== 'string' || !chapterId) throw new Error('保存する章を選択してください。');
    try {
      await waitForSaved();
      const db = await ensureControllerDb();
      const packageValue = await root.NovelStorage.loadWork(db);
      if (!packageValue) throw new Error('保存された作品がありません。');
      const chapterRecord = packageValue.work.chapters.find(item => item.id === chapterId);
      if (!chapterRecord) throw new Error('保存する章のデータが端末内にありません。');
      const revision = await root.NovelStorage.loadWorkRevision(db);
      const modules = await loadArchiveModules();
      const baseline = workspaceMeta?.baselines?.[chapterId];
      const options = { baseRevision: revision };
      if (baseline) { options.baseChapterHash = baseline.baseChapterHash; options.exportedAt = baseline.exportedAt; }
      const blob = await modules.chapter.exportChapterArchive(packageValue, chapterId, options);
      download(blob, `${filename(packageValue.work.title)}_${filename(chapterRecord.title)}.zip`);
      toast('章ZIPのダウンロードを開始しました。');
      return blob;
    } catch (error) {
      toast(`章ZIPを書き出せませんでした：${error?.message || error}`);
      throw error;
    }
  }

  function confirmChapterReplace(title) {
    return root.confirm(`章ワークスペースとして「${title || 'この章'}」を開きます。\n現在の作品は端末内で置き換わります。必要なら先にZIPバックアップを保存してください。`);
  }

  async function importChapterFile(file, expectedChapterId = null) {
    if (!file) return false;
    try {
      await waitForSaved();
      await loadArchiveModules();
      const read = await root.NovelArchiveCommon.readArchive(file);
      if (read.manifest?.format !== 'fumizukue-chapter-archive') throw new Error('章ZIPではありません。「作品を開く」から作品ZIPを選択してください。');
      const imported = await root.NovelChapterArchive.importChapterArchiveRead(read);
      if (expectedChapterId && workspaceMeta?.sourceWorkId && imported.workspaceMeta.sourceWorkId !== workspaceMeta.sourceWorkId) throw new Error('この作品の章ZIPではありません。');
      if (expectedChapterId && imported.bundle.chapter.id !== expectedChapterId) throw new Error('選択した章とZIP内の章が一致しません。');
      if (!confirmChapterReplace(imported.bundle.chapter.title)) return false;
      const db = await ensureControllerDb(true);
      await root.NovelStorage.saveChapterWorkspace(db, imported.packageValue, imported.workspaceMeta);
      workspaceMeta = imported.workspaceMeta;
      root.sessionStorage?.setItem('fumizukue.chapter-workspace.opened', imported.bundle.chapter.title || '章');
      location.reload();
      return true;
    } catch (error) {
      toast(`章ZIPを取り込めませんでした：${error?.message || error}`);
      return false;
    }
  }

  function requestChapterImport(chapterId = null) {
    expectedImportChapterId = chapterId;
    const input = $('import-chapter-file');
    if (input) input.click();
  }

  function renderCatalog() {
    const host = $('chapter-catalog');
    if (!host) return;
    const nextSignature = workspaceMeta?.mode === 'chapter-workspace'
      ? JSON.stringify([workspaceMeta.sourceWorkId, workspaceMeta.loadedChapterIds, workspaceMeta.catalog])
      : 'full-work';
    if (catalogSignature === nextSignature) return;
    catalogSignature = nextSignature;
    host.replaceChildren();
    if (workspaceMeta?.mode !== 'chapter-workspace') { host.hidden = true; return; }
    host.hidden = false;
    const title = document.createElement('div'); title.className = 'chapter-catalog-title'; title.textContent = '作品内の章'; host.append(title);
    const loaded = new Set(workspaceMeta.loadedChapterIds);
    for (const item of workspaceMeta.catalog.slice().sort((a, b) => a.order - b.order)) {
      const row = document.createElement('div');
      const isLoaded = loaded.has(item.id);
      row.className = `chapter-catalog-row${isLoaded ? ' chapter-catalog-loaded' : ' chapter-catalog-unloaded'}`;
      row.dataset.chapterId = item.id;
      const info = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = item.title || '無題の章';
      const meta = document.createElement('small'); meta.textContent = `${item.episodeCount}話 · ${item.textLength.toLocaleString('ja-JP')}文字`;
      info.append(name, meta); row.append(info);
      const action = document.createElement('button'); action.type = 'button'; action.className = 'quiet';
      if (isLoaded) { action.textContent = '読み込み済み'; action.disabled = true; }
      else {
        action.textContent = '章ZIPを開く'; action.title = 'この章のデータは読み込まれていません';
        action.addEventListener('click', () => requestChapterImport(item.id));
      }
      row.append(action); host.append(row);
    }
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
          strip.textContent = `章ワークスペース · ${item?.title || '読み込み済み章'}のみを編集中 · 作品全体ではありません`;
        }
      }
      const workTitle = $('work-title'); if (workTitle) { workTitle.disabled = chapterMode; workTitle.setAttribute('aria-readonly', String(chapterMode)); }
      const reset = $('reset'); if (reset) reset.disabled = chapterMode;
      const sample = $('load-sample'); if (sample) sample.disabled = chapterMode;
      const exportButton = $('export-archive'); if (exportButton) exportButton.firstChild.textContent = chapterMode ? '章ZIPで保存 ' : 'ZIPで保存 ';
      const workOption = $('txt-scope')?.querySelector('option[value="work"]'); if (workOption) workOption.textContent = chapterMode ? '読み込み済み章' : '作品全体';
      renderCatalog(); injectChapterExportButtons(); protectPlotSharedData(); protectCharacters();
    } finally { applyingUi = false; }
  }

  const wrappedWorkspace = {
    ...baseWorkspace,
    commit(nextState, patch = null, historyKey = null) {
      modeTools.assertPatchAllowed(workspaceMeta, patch, baseWorkspace.getState());
      return baseWorkspace.commit(nextState, patch, historyKey);
    },
    getWorkspaceMeta: () => clone(workspaceMeta),
    exportChapter
  };
  root.NovelWorkspace = Object.freeze(wrappedWorkspace);

  $('import-chapter-button')?.addEventListener('click', () => requestChapterImport(null));
  $('import-chapter-file')?.addEventListener('change', () => {
    const input = $('import-chapter-file'), file = input.files?.[0], expected = expectedImportChapterId;
    expectedImportChapterId = null; input.value = ''; void importChapterFile(file, expected);
  });
  $('export-archive')?.addEventListener('click', event => {
    if (workspaceMeta?.mode !== 'chapter-workspace') return;
    event.preventDefault(); event.stopImmediatePropagation(); void exportChapter(workspaceMeta.loadedChapterIds[0]);
  }, true);
  document.addEventListener('keydown', event => {
    if (workspaceMeta?.mode !== 'chapter-workspace' || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault(); event.stopImmediatePropagation(); void exportChapter(workspaceMeta.loadedChapterIds[0]);
  }, true);

  const observer = new MutationObserver(() => applyModeUi());
  observer.observe(document.body, { subtree: true, childList: true });
  baseWorkspace.subscribe(event => { if (event.reason === 'package') void refreshWorkspaceMeta(); else applyModeUi(); });

  for (const id of ['tab-plot', 'tab-characters']) { const button = $(id); if (button) button.disabled = true; }
  void (async () => {
    try {
      await waitForAppReady();
      const db = await ensureControllerDb();
      workspaceMeta = await root.NovelStorage.loadWorkspaceMeta(db);
      const opened = root.sessionStorage?.getItem('fumizukue.chapter-workspace.opened');
      if (opened) { root.sessionStorage.removeItem('fumizukue.chapter-workspace.opened'); toast(`章ワークスペース「${opened}」を開きました。`); }
      applyModeUi();
    } catch (error) {
      console.error('章ワークスペース情報を読み込めませんでした。', error);
      toast(`章ワークスペース情報を読み込めませんでした：${error?.message || error}`);
    } finally {
      for (const id of ['tab-plot', 'tab-characters']) { const button = $(id); if (button) button.disabled = false; }
    }
  })();

  root.NovelChapterWorkspace = Object.freeze({ getWorkspaceMeta: () => clone(workspaceMeta), exportChapter, importChapterFile, refreshWorkspaceMeta });
})(globalThis);
