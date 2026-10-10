/* Series settings embedded in the plot screen plus Series-level workspace actions. */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  let db = null;
  let activeSeries = null;
  let activeMeta = null;
  let saveTimer = null;
  let chapterMode = false;
  let workExportBypass = false;
  let seriesArchivePromise = null;
  let seriesOperation = false;

  function toast(message) {
    if (root.NovelWorkspace?.toast) root.NovelWorkspace.toast(message);
    else console.warn(message);
  }

  function filename(name) {
    return (name || '無題').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || '無題';
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function seriesDb() {
    if (!db) db = await root.NovelStorage.openStore();
    return db;
  }

  async function refreshChapterMode() {
    if (typeof root.NovelStorage.loadWorkspaceMeta !== 'function') {
      chapterMode = false;
      return chapterMode;
    }
    const chapterMeta = await root.NovelStorage.loadWorkspaceMeta(await seriesDb());
    chapterMode = chapterMeta?.mode === 'chapter-workspace';
    return chapterMode;
  }

  async function assertFullWorkMode() {
    if (await refreshChapterMode()) {
      throw new Error('章ワークスペース中はシリーズや作品を切り替えられません。先にマスター作品ZIPを開いて通常モードへ戻してください。');
    }
  }

  async function waitForEditorIdle() {
    const status = $('save-status');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const text = status?.textContent || '';
      if (/失敗|競合|保存でき/.test(text)) throw new Error(text || '現在の作品を保存できませんでした。');
      if (!/保存中|保存待ち|未保存|起動しています/.test(text) && $('app')?.getAttribute('aria-busy') !== 'true') return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('現在の作品の保存完了を確認できませんでした。');
  }

  async function withSeriesOperation(action) {
    if (seriesOperation) return;
    seriesOperation = true;
    try { return await action(); }
    finally { seriesOperation = false; }
  }

  async function selectWork(workId) {
    if (!activeSeries || activeMeta?.activeWorkId === workId) return;
    await assertFullWorkMode();
    await waitForEditorIdle();
    await root.NovelStorage.setActiveWorkspace(await seriesDb(), activeSeries.id, workId);
    location.reload();
  }

  async function createWork() {
    if (!activeSeries) return;
    await assertFullWorkMode();
    await waitForEditorIdle();
    const work = root.NovelModel.createWork();
    await root.NovelStorage.createWorkInSeries(await seriesDb(), activeSeries.id, { work, images: [] });
    location.reload();
  }

  async function deleteWork(work) {
    if (!activeSeries) return;
    await assertFullWorkMode();
    const works = await root.NovelStorage.listWorks(await seriesDb(), activeSeries.id);
    if (works.length <= 1) {
      toast('シリーズの最後の1作品は削除できません。');
      return;
    }
    if (!root.confirm(`「${work.title}」を端末内から削除します。\nこの操作は元に戻せません。`)) return;
    await waitForEditorIdle();
    const wasActive = activeMeta?.activeWorkId === work.id;
    await root.NovelStorage.deleteWork(await seriesDb(), work.id);
    if (wasActive) location.reload();
    else await render();
  }

  async function createSeries() {
    await withSeriesOperation(async () => {
      await assertFullWorkMode();
      await waitForEditorIdle();
      const work = root.NovelModel.createWork();
      await root.NovelStorage.createSeriesWithInitialWork(
        await seriesDb(),
        { title: '無題のシリーズ', summary: '' },
        { work, images: [] }
      );
      location.reload();
    });
  }

  async function loadSeriesArchiveModule() {
    if (!seriesArchivePromise) {
      seriesArchivePromise = import(new URL('./series-archive.js', location.href).href).then(() => {
        if (!root.NovelSeriesArchive) throw new Error('シリーズZIP処理モジュールを読み込めませんでした。');
        return root.NovelSeriesArchive;
      }).catch(error => {
        seriesArchivePromise = null;
        throw error;
      });
    }
    return seriesArchivePromise;
  }

  async function exportSeries() {
    await withSeriesOperation(async () => {
      await assertFullWorkMode();
      await waitForEditorIdle();
      const store = await seriesDb();
      const meta = await root.NovelStorage.getWorkspaceMeta(store);
      if (!meta) throw new Error('現在のシリーズがありません。');
      const series = await root.NovelStorage.getSeries(store, meta.activeSeriesId);
      if (!series) throw new Error('現在のシリーズが見つかりません。');
      const workRecords = await root.NovelStorage.listWorks(store, series.id);
      const works = [];
      for (const record of workRecords.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
        const value = await root.NovelStorage.loadWork(store, record.id);
        if (!value) throw new Error(`作品「${record.title || record.id}」を読み込めませんでした。`);
        works.push(value);
      }
      const archive = await loadSeriesArchiveModule();
      const blob = await archive.exportSeriesArchive({ series, activeWorkId: meta.activeWorkId, works });
      download(blob, `${filename(series.title)}.series.zip`);
      toast('シリーズZIPのダウンロードを開始しました。保存先のファイルを確認してください。');
    });
  }

  function invokeWorkExport() {
    if (chapterMode) return;
    const control = $('export-archive');
    if (!control) return;
    workExportBypass = true;
    control.click();
    queueMicrotask(() => { workExportBypass = false; });
  }

  function workCard(work, isActive, canDelete, canManage) {
    const card = document.createElement('article');
    card.className = `series-work-card${isActive ? ' active' : ''}`;
    const body = document.createElement('div');
    body.className = 'series-work-copy';
    const title = document.createElement('h4');
    title.textContent = work.title || '無題の作品';
    const summary = document.createElement('p');
    summary.textContent = work.summary || '概要はまだありません。';
    body.append(title, summary);

    const actions = document.createElement('div');
    actions.className = 'series-work-actions';
    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'series-active-badge';
      badge.textContent = '開いている作品';
      actions.append(badge);
    } else {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'primary';
      open.textContent = '開く';
      open.disabled = !canManage;
      open.addEventListener('click', () => void selectWork(work.id).catch(error => toast(error.message)));
      actions.append(open);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet danger';
    remove.textContent = '削除';
    remove.disabled = !canManage || !canDelete;
    remove.addEventListener('click', () => void deleteWork(work).catch(error => toast(error.message)));
    actions.append(remove);
    card.append(body, actions);
    return card;
  }

  function ensureWorkArchiveControls() {
    if ($('series-export-work') && $('series-import-work')) return;
    const heading = document.querySelector('#series-settings-panel .series-list-heading');
    if (!heading) return;

    const actions = document.createElement('div');
    actions.className = 'series-archive-actions';

    const exportButton = document.createElement('button');
    exportButton.id = 'series-export-work';
    exportButton.type = 'button';
    exportButton.className = 'quiet';
    exportButton.textContent = '現在の作品ZIPで保存';
    exportButton.addEventListener('click', invokeWorkExport);

    const importButton = document.createElement('button');
    importButton.id = 'series-import-work';
    importButton.type = 'button';
    importButton.className = 'quiet';
    importButton.textContent = '作品ZIP / 旧JSONを開く';
    importButton.addEventListener('click', () => $('import-button')?.click());

    actions.append(exportButton, importButton);
    heading.append(actions);
  }

  function setManagementAvailability(canManage, message = '') {
    $('series-title').disabled = !canManage;
    $('series-summary').disabled = !canManage;
    $('series-add-work').disabled = !canManage;
    if ($('series-export-work')) $('series-export-work').disabled = !canManage;
    if ($('series-import-work')) $('series-import-work').disabled = !canManage;
    const note = $('series-mode-note');
    note.hidden = canManage || !message;
    note.textContent = canManage ? '' : message;
  }

  async function render() {
    const store = await seriesDb();
    activeMeta = await root.NovelStorage.getWorkspaceMeta(store);
    if (!activeMeta) return;
    activeSeries = await root.NovelStorage.getSeries(store, activeMeta.activeSeriesId);
    if (!activeSeries) return;

    let canManage = true;
    let modeMessage = '';
    try { await assertFullWorkMode(); }
    catch (error) {
      canManage = false;
      modeMessage = error?.message || String(error);
    }

    ensureWorkArchiveControls();
    $('series-title').value = activeSeries.title || '';
    $('series-summary').value = activeSeries.summary || '';
    setManagementAvailability(canManage, modeMessage);

    const works = await root.NovelStorage.listWorks(store, activeSeries.id);
    const container = $('series-works');
    container.replaceChildren(...works.map(work => workCard(
      work,
      work.id === activeMeta.activeWorkId,
      works.length > 1,
      canManage
    )));
  }

  function scheduleSeriesSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!activeSeries || $('series-title').disabled) return;
      void root.NovelStorage.updateSeries(db, activeSeries.id, {
        title: $('series-title').value,
        summary: $('series-summary').value
      }).then(value => {
        activeSeries = value;
      }).catch(error => toast(error.message));
    }, 350);
  }

  function setTopbarLabels() {
    const importButton = $('import-button');
    const resetButton = $('reset');
    const exportButton = $('export-archive');

    if (importButton) {
      importButton.textContent = chapterMode ? 'マスター作品ZIPを開く' : '作品ZIPを開く';
      importButton.disabled = false;
    }
    if (resetButton) {
      resetButton.textContent = '新しいシリーズ';
      resetButton.disabled = chapterMode;
    }
    if (exportButton && !chapterMode && exportButton.textContent.trim() !== 'シリーズZIPで保存 ↗') {
      exportButton.textContent = 'シリーズZIPで保存 ↗';
    }
  }

  async function refreshTopbarMode() {
    try { await refreshChapterMode(); }
    catch { chapterMode = false; }
    setTopbarLabels();
    if ($('tab-plot')?.getAttribute('aria-selected') === 'true') {
      void render().catch(error => toast(error.message));
    }
  }

  function renderIfPlotActive() {
    if ($('tab-plot')?.getAttribute('aria-selected') !== 'true') return;
    void render().catch(error => toast(error?.message || String(error)));
  }

  function interceptTopbar() {
    $('export-archive')?.addEventListener('click', event => {
      if (workExportBypass) {
        workExportBypass = false;
        return;
      }
      if (chapterMode) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void exportSeries().catch(error => toast(`シリーズZIPを書き出せませんでした：${error.message}`));
    }, { capture: true });

    $('reset')?.addEventListener('click', event => {
      if (chapterMode) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void createSeries().catch(error => toast(error.message));
    }, { capture: true });

    document.addEventListener('keydown', event => {
      if (chapterMode || event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void exportSeries().catch(error => toast(`シリーズZIPを書き出せませんでした：${error.message}`));
    }, { capture: true });
  }

  ensureWorkArchiveControls();
  interceptTopbar();
  setTopbarLabels();
  $('tab-plot')?.addEventListener('click', renderIfPlotActive);
  $('series-title')?.addEventListener('input', scheduleSeriesSave);
  $('series-summary')?.addEventListener('input', scheduleSeriesSave);
  $('series-add-work')?.addEventListener('click', () => void createWork().catch(error => toast(error.message)));
  root.NovelWorkspace?.subscribe(event => {
    if (event?.reason === 'screen') renderIfPlotActive();
  });
  void refreshTopbarMode();
  setTimeout(() => void refreshTopbarMode(), 0);
})(globalThis);
