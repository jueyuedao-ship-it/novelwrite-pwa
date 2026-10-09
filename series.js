/* Series screen and work switching. */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  const existingTabs = ['manuscript', 'plot', 'characters'];
  let db = null;
  let activeSeries = null;
  let activeMeta = null;
  let saveTimer = null;

  function toast(message) {
    if (root.NovelWorkspace?.toast) root.NovelWorkspace.toast(message);
    else console.warn(message);
  }

  function showSeriesScreen() {
    $('tab-series').classList.add('active');
    $('tab-series').setAttribute('aria-selected', 'true');
    $('screen-series').hidden = false;
    $('sidebar').hidden = true;
    document.querySelector('.integrated-workspace')?.classList.add('series-mode');
    for (const name of existingTabs) {
      $(`tab-${name}`).classList.remove('active');
      $(`tab-${name}`).setAttribute('aria-selected', 'false');
      $(`screen-${name}`).hidden = true;
    }
    void render();
  }

  function leaveSeriesScreen() {
    $('tab-series').classList.remove('active');
    $('tab-series').setAttribute('aria-selected', 'false');
    $('screen-series').hidden = true;
    $('sidebar').hidden = false;
    document.querySelector('.integrated-workspace')?.classList.remove('series-mode');
  }

  async function seriesDb() {
    if (!db) db = await root.NovelStorage.openStore();
    return db;
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
    await waitForEditorIdle();
    await root.NovelStorage.setActiveWorkspace(await seriesDb(), activeSeries.id, workId);
    location.reload();
  }

  async function createWork() {
    if (!activeSeries) return;
    await waitForEditorIdle();
    const work = root.NovelModel.createWork();
    await root.NovelStorage.createWorkInSeries(await seriesDb(), activeSeries.id, { work, images: [] });
    location.reload();
  }

  async function deleteWork(work) {
    if (!activeSeries) return;
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

  function workCard(work, isActive, canDelete) {
    const card = document.createElement('article');
    card.className = `series-work-card${isActive ? ' active' : ''}`;
    const body = document.createElement('div');
    body.className = 'series-work-copy';
    const title = document.createElement('h3');
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
      open.addEventListener('click', () => void selectWork(work.id).catch(error => toast(error.message)));
      actions.append(open);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet danger';
    remove.textContent = '削除';
    remove.disabled = !canDelete;
    remove.addEventListener('click', () => void deleteWork(work).catch(error => toast(error.message)));
    actions.append(remove);
    card.append(body, actions);
    return card;
  }

  async function render() {
    const store = await seriesDb();
    activeMeta = await root.NovelStorage.getWorkspaceMeta(store);
    if (!activeMeta) return;
    activeSeries = await root.NovelStorage.getSeries(store, activeMeta.activeSeriesId);
    if (!activeSeries) return;
    $('series-title').value = activeSeries.title || '';
    $('series-summary').value = activeSeries.summary || '';
    const works = await root.NovelStorage.listWorks(store, activeSeries.id);
    const container = $('series-works');
    container.replaceChildren(...works.map(work => workCard(work, work.id === activeMeta.activeWorkId, works.length > 1)));
  }

  function scheduleSeriesSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!activeSeries) return;
      void root.NovelStorage.updateSeries(db, activeSeries.id, {
        title: $('series-title').value,
        summary: $('series-summary').value
      }).then(value => { activeSeries = value; }).catch(error => toast(error.message));
    }, 350);
  }

  $('tab-series').addEventListener('click', showSeriesScreen);
  for (const name of existingTabs) $(`tab-${name}`).addEventListener('click', leaveSeriesScreen, true);
  $('series-title').addEventListener('input', scheduleSeriesSave);
  $('series-summary').addEventListener('input', scheduleSeriesSave);
  $('series-add-work').addEventListener('click', () => void createWork().catch(error => toast(error.message)));
})(globalThis);
