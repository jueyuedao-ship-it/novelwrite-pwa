/* Series settings embedded in the plot screen. */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  let db = null;
  let activeSeries = null;
  let activeMeta = null;
  let saveTimer = null;

  function toast(message) {
    if (root.NovelWorkspace?.toast) root.NovelWorkspace.toast(message);
    else console.warn(message);
  }

  async function seriesDb() {
    if (!db) db = await root.NovelStorage.openStore();
    return db;
  }

  async function assertFullWorkMode() {
    if (typeof root.NovelStorage.loadWorkspaceMeta !== 'function') return;
    const chapterMeta = await root.NovelStorage.loadWorkspaceMeta(await seriesDb());
    if (chapterMeta?.mode === 'chapter-workspace') {
      throw new Error('章ワークスペース中はシリーズや作品を切り替えられません。先にマスター作品ZIPを開いて通常モードへ戻してください。');
    }
  }

  async function waitForEditorIdle() {
    const status = $('save-status');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const text = status?.textContent || '';
      if (/失敗|競合|保存でき/.test(text)) throw new Error(text || '現在の作品を保存できませんでした。');
      if (!/保存中|保存待ち|未保存|起動しています/.test(text) && $('app').getAttribute('aria-busy') !== 'true') return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('現在の作品の保存完了を確認できませんでした。');
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

  function setManagementAvailability(canManage, message = '') {
    $('series-title').disabled = !canManage;
    $('series-summary').disabled = !canManage;
    $('series-add-work').disabled = !canManage;
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
    try {
      await assertFullWorkMode();
    } catch (error) {
      canManage = false;
      modeMessage = error?.message || String(error);
    }

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
      }).then(value => { activeSeries = value; }).catch(error => toast(error.message));
    }, 350);
  }

  function renderIfPlotActive() {
    if ($('tab-plot')?.getAttribute('aria-selected') !== 'true') return;
    void render().catch(error => toast(error?.message || String(error)));
  }

  $('tab-plot').addEventListener('click', renderIfPlotActive);
  $('series-title').addEventListener('input', scheduleSeriesSave);
  $('series-summary').addEventListener('input', scheduleSeriesSave);
  $('series-add-work').addEventListener('click', () => void createWork().catch(error => toast(error.message)));
  root.NovelWorkspace?.subscribe(event => {
    if (event?.reason === 'screen') renderIfPlotActive();
  });
})(globalThis);
