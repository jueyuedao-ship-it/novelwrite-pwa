(function (root) {
  'use strict';

  const STORAGE_PREFIX = 'fumizukue.plot-overview.v1:';
  const STATUS_VALUES = new Set(['planned', 'installed', 'partial', 'resolved']);
  const IMPORTANCE_VALUES = new Set(['low', 'medium', 'high']);
  const TEXT_FIELDS = ['genre', 'tone', 'theme', 'publicSetting', 'secretSetting', 'finalGoal', 'climax', 'ending', 'aftertaste', 'productionNotes'];
  const STATUS_LABELS = { planned: '未設置', installed: '設置済み', partial: '一部回収', resolved: '回収済み' };
  const IMPORTANCE_LABELS = { low: '低', medium: '中', high: '高' };

  function createEmptyOverview() {
    return {
      genre: '', tone: '', theme: '', publicSetting: '', secretSetting: '',
      finalGoal: '', climax: '', ending: '', aftertaste: '', productionNotes: '', foreshadows: []
    };
  }

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function createForeshadow(source = {}) {
    return {
      id: text(source.id) || `foreshadow-${root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
      title: text(source.title),
      setup: text(source.setup),
      hints: text(source.hints),
      target: text(source.target),
      resolution: text(source.resolution),
      status: STATUS_VALUES.has(source.status) ? source.status : 'planned',
      importance: IMPORTANCE_VALUES.has(source.importance) ? source.importance : 'medium'
    };
  }

  function normalizeOverview(raw) {
    const value = createEmptyOverview();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return value;
    for (const field of TEXT_FIELDS) value[field] = text(raw[field]);
    if (Array.isArray(raw.foreshadows)) value.foreshadows = raw.foreshadows.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map(createForeshadow);
    return value;
  }

  function isForeshadowResolved(item) {
    return item?.status === 'resolved';
  }

  function storageKey(workId) {
    return `${STORAGE_PREFIX}${workId}`;
  }

  function loadOverview(storage, workId) {
    if (!storage || !workId) return createEmptyOverview();
    try {
      const raw = storage.getItem(storageKey(workId));
      return raw ? normalizeOverview(JSON.parse(raw)) : createEmptyOverview();
    } catch {
      return createEmptyOverview();
    }
  }

  function saveOverview(storage, workId, details) {
    if (!storage || !workId) return false;
    try {
      storage.setItem(storageKey(workId), JSON.stringify(normalizeOverview(details)));
      return true;
    } catch {
      return false;
    }
  }

  let mounted = false;
  let observer = null;
  let unsubscribe = null;
  let dialog = null;
  let dialogBody = null;
  let tabBar = null;
  let activeTab = 'basic';
  let hideResolved = false;

  const node = (tag, className = '', textContent) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (textContent !== undefined) element.textContent = textContent;
    return element;
  };

  function workspace() {
    return root.NovelWorkspace;
  }

  function currentWorkId() {
    return workspace()?.getState?.().work?.id || null;
  }

  function readDetails() {
    return loadOverview(root.localStorage, currentWorkId());
  }

  function writeDetails(details) {
    const workId = currentWorkId();
    if (!workId) return;
    if (!saveOverview(root.localStorage, workId, details)) workspace()?.toast?.('作品概要の詳細設定を端末内に保存できませんでした。');
    refreshOverviewBadges();
  }

  function patchDetails(updater) {
    const details = readDetails();
    const next = updater(details) || details;
    writeDetails(next);
    return next;
  }

  function injectStyles() {
    if (document.getElementById('plot-overview-details-style')) return;
    const style = node('style');
    style.id = 'plot-overview-details-style';
    style.textContent = `
.plot-overview-title-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.plot-overview-title-row h2{margin:0;cursor:pointer}.plot-overview-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:10px}.plot-overview-chip{display:inline-flex;align-items:center;min-height:27px;padding:4px 8px;border-radius:999px;background:#eaf2ee;color:#315f54;font-size:11px}.plot-overview-detail-button{margin-left:auto}.plot-overview-dialog{width:min(960px,calc(100vw - 28px));max-width:960px;max-height:90vh;padding:0;overflow:hidden}.plot-overview-dialog::backdrop{background:#203c3659;backdrop-filter:blur(2px)}.plot-overview-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 22px;border-bottom:1px solid var(--line);background:#f9faf5}.plot-overview-dialog-head h2{margin:3px 0 0;font-size:20px}.plot-overview-tabs{display:flex;gap:4px;padding:10px 14px;border-bottom:1px solid var(--line);overflow-x:auto;background:#fffef9}.plot-overview-tabs button{flex:0 0 auto;min-height:34px;font-size:11px}.plot-overview-tabs button.active{background:var(--accent);border-color:var(--accent);color:white}.plot-overview-dialog-body{padding:18px 22px 24px;max-height:calc(90vh - 126px);overflow:auto}.plot-overview-form{display:grid;gap:14px}.plot-overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.plot-overview-dialog .plot-field textarea{min-height:150px}.plot-overview-dialog .plot-overview-short textarea{min-height:90px}.plot-overview-help{color:var(--muted);font-size:12px;line-height:1.8}.plot-overview-spoiler{padding:11px 13px;border:1px solid #d9c8a5;border-radius:8px;background:#fff9ed;color:#725c33;font-size:12px;line-height:1.7}.plot-foreshadow-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.plot-foreshadow-filter{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}.plot-foreshadow-list{display:grid;gap:12px;margin-top:14px}.plot-foreshadow-card{padding:14px;border:1px solid var(--line);border-radius:9px;background:#fffef9}.plot-foreshadow-card-head{display:grid;grid-template-columns:minmax(0,1fr) 120px 120px auto;gap:8px;align-items:center}.plot-foreshadow-card-head input,.plot-foreshadow-card-head select{width:100%}.plot-foreshadow-card-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}.plot-foreshadow-card-fields textarea{min-height:80px}.plot-foreshadow-empty{padding:24px;border:1px dashed var(--line);border-radius:8px;text-align:center;color:var(--muted);font-size:12px}.plot-overview-save-note{font-size:11px;color:var(--muted);margin-top:12px}.plot-overview-summary-mirror{min-height:110px!important}
@media(max-width:700px){.plot-overview-detail-button{margin-left:0}.plot-overview-dialog{width:100vw;max-width:none;max-height:100vh;height:100vh;border-radius:0}.plot-overview-dialog-body{max-height:calc(100vh - 126px);padding:14px}.plot-overview-grid,.plot-foreshadow-card-fields{grid-template-columns:1fr}.plot-foreshadow-card-head{grid-template-columns:1fr 1fr}.plot-foreshadow-card-head>input{grid-column:1/-1}.plot-foreshadow-card-head>.danger{grid-column:1/-1}.plot-overview-dialog-head{padding:14px}.plot-overview-tabs{padding:8px}}
`;
    document.head.append(style);
  }

  function makeField(labelText, value, onInput, options = {}) {
    const label = node('label', `plot-field${options.short ? ' plot-overview-short' : ''}`);
    label.append(node('span', '', labelText));
    const control = node(options.tag || 'input');
    control.value = value ?? '';
    if (options.placeholder) control.placeholder = options.placeholder;
    if ((options.tag || 'input') === 'textarea') control.rows = options.rows || 5;
    control.addEventListener('input', () => onInput(control.value));
    label.append(control);
    return label;
  }

  function updateSummary(value) {
    const control = document.querySelector('.plot-overview-text');
    if (control) {
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const app = workspace();
    const state = app?.getState?.();
    if (!state) return;
    const work = { ...state.work, summary: value };
    app.commit({ ...state, work }, { workId: state.work.id, work }, 'plot:work:summary');
  }

  function renderBasic(details) {
    const form = node('div', 'plot-overview-form');
    form.append(node('p', 'plot-overview-help', '作品全体を一目で思い出せる情報をまとめます。ここで編集した作品概要は、プロット画面の概要欄と同じ内容です。'));
    const summary = makeField('作品概要', workspace()?.getState?.().work?.summary || '', updateSummary, { tag: 'textarea' });
    summary.querySelector?.('textarea')?.classList.add('plot-overview-summary-mirror');
    form.append(summary);
    const grid = node('div', 'plot-overview-grid');
    grid.append(
      makeField('ジャンル', details.genre, value => patchDetails(next => ({ ...next, genre: value })), { placeholder: '例：現代ファンタジー' }),
      makeField('雰囲気・トーン', details.tone, value => patchDetails(next => ({ ...next, tone: value })), { placeholder: '例：静か、重厚、コミカル' }),
      makeField('テーマ', details.theme, value => patchDetails(next => ({ ...next, theme: value })), { tag: 'textarea', short: true, placeholder: '作品で扱いたい問い・主題' })
    );
    form.append(grid, node('p', 'plot-overview-save-note', '詳細設定は入力と同時にこの端末へ自動保存されます。'));
    return form;
  }

  function renderTextSection(details, config) {
    const form = node('div', 'plot-overview-form');
    if (config.warning) form.append(node('div', 'plot-overview-spoiler', config.warning));
    form.append(node('p', 'plot-overview-help', config.help));
    form.append(makeField(config.label, details[config.key], value => patchDetails(next => ({ ...next, [config.key]: value })), { tag: 'textarea', placeholder: config.placeholder }));
    form.append(node('p', 'plot-overview-save-note', '入力内容は自動保存されます。'));
    return form;
  }

  function renderEnding(details) {
    const form = node('div', 'plot-overview-form');
    form.append(node('p', 'plot-overview-help', '物語がどこへ向かい、最後に何を残すかを整理します。'));
    const grid = node('div', 'plot-overview-grid');
    for (const [key, label, placeholder] of [
      ['finalGoal', '主人公の最終目標', '最後に達成・選択すること'],
      ['climax', 'クライマックス', '最大の対立・決断・転換点'],
      ['ending', '結末', '最終的に何がどうなるか'],
      ['aftertaste', '読後感', '読者に残したい感情や余韻']
    ]) grid.append(makeField(label, details[key], value => patchDetails(next => ({ ...next, [key]: value })), { tag: 'textarea', short: true, placeholder }));
    form.append(grid, node('p', 'plot-overview-save-note', '入力内容は自動保存されます。'));
    return form;
  }

  function updateForeshadow(id, field, value) {
    patchDetails(details => ({
      ...details,
      foreshadows: details.foreshadows.map(item => item.id === id ? { ...item, [field]: value } : item)
    }));
  }

  function renderForeshadows(details) {
    const wrap = node('div');
    const toolbar = node('div', 'plot-foreshadow-toolbar');
    const filter = node('label', 'plot-foreshadow-filter');
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = hideResolved;
    checkbox.addEventListener('change', () => { hideResolved = checkbox.checked; renderDialogBody(); });
    filter.append(checkbox, node('span', '', '未回収のみ表示'));
    const add = node('button', 'accent', '＋ 伏線'); add.type = 'button';
    add.addEventListener('click', () => {
      patchDetails(current => ({ ...current, foreshadows: [...current.foreshadows, createForeshadow()] }));
      renderDialogBody();
    });
    toolbar.append(filter, add); wrap.append(toolbar);

    const list = node('div', 'plot-foreshadow-list');
    const visible = hideResolved ? details.foreshadows.filter(item => !isForeshadowResolved(item)) : details.foreshadows;
    if (!visible.length) list.append(node('div', 'plot-foreshadow-empty', details.foreshadows.length ? '未回収の伏線はありません。' : 'まだ伏線は登録されていません。'));
    for (const item of visible) {
      const card = node('article', 'plot-foreshadow-card');
      const head = node('div', 'plot-foreshadow-card-head');
      const title = node('input'); title.value = item.title; title.placeholder = '伏線名'; title.setAttribute('aria-label', '伏線名');
      title.addEventListener('input', () => updateForeshadow(item.id, 'title', title.value));
      const importance = node('select'); importance.setAttribute('aria-label', '伏線の重要度');
      for (const value of ['low', 'medium', 'high']) { const option = node('option', '', `重要度：${IMPORTANCE_LABELS[value]}`); option.value = value; option.selected = item.importance === value; importance.append(option); }
      importance.addEventListener('change', () => updateForeshadow(item.id, 'importance', importance.value));
      const status = node('select'); status.setAttribute('aria-label', '伏線の状態');
      for (const value of ['planned', 'installed', 'partial', 'resolved']) { const option = node('option', '', STATUS_LABELS[value]); option.value = value; option.selected = item.status === value; status.append(option); }
      status.addEventListener('change', () => { updateForeshadow(item.id, 'status', status.value); refreshOverviewBadges(); if (hideResolved && status.value === 'resolved') renderDialogBody(); });
      const remove = node('button', 'quiet danger', '削除'); remove.type = 'button';
      remove.addEventListener('click', () => {
        patchDetails(current => ({ ...current, foreshadows: current.foreshadows.filter(candidate => candidate.id !== item.id) }));
        renderDialogBody();
      });
      head.append(title, importance, status, remove); card.append(head);
      const fields = node('div', 'plot-foreshadow-card-fields');
      for (const [field, label, placeholder] of [
        ['setup', '仕込み', 'どこで・どう見せるか'],
        ['hints', 'ヒント', '追加の示唆、章・シーンなど'],
        ['target', '回収予定', '回収する章・シーン・タイミング'],
        ['resolution', '回収内容', '最終的に何が明らかになるか']
      ]) fields.append(makeField(label, item[field], value => updateForeshadow(item.id, field, value), { tag: 'textarea', short: true, placeholder }));
      card.append(fields); list.append(card);
    }
    wrap.append(list, node('p', 'plot-overview-save-note', '各伏線は入力と同時に自動保存されます。'));
    return wrap;
  }

  function renderDialogBody() {
    if (!dialogBody || !tabBar) return;
    const details = readDetails();
    tabBar.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.tab === activeTab));
    if (activeTab === 'basic') dialogBody.replaceChildren(renderBasic(details));
    else if (activeTab === 'public') dialogBody.replaceChildren(renderTextSection(details, {
      key: 'publicSetting', label: '表設定', help: '読者が序盤から知ってよい世界観・時代・場所・社会・能力やルール・主人公の立場を書きます。', placeholder: '読者に見せてよい設定をまとめる'
    }));
    else if (activeTab === 'secret') dialogBody.replaceChildren(renderTextSection(details, {
      key: 'secretSetting', label: '裏設定・真相', help: '世界の本当の仕組み、過去の事件の真相、人物の秘密、本当の目的などを整理します。', warning: 'ネタバレ領域：読者にまだ明かさない真相や終盤の情報を記録する場所です。', placeholder: '裏設定・真相・隠された目的など'
    }));
    else if (activeTab === 'foreshadow') dialogBody.replaceChildren(renderForeshadows(details));
    else if (activeTab === 'ending') dialogBody.replaceChildren(renderEnding(details));
    else dialogBody.replaceChildren(renderTextSection(details, {
      key: 'productionNotes', label: '制作メモ', help: '他の項目に入らないアイデア、変更予定、調べ物などを自由に残します。', placeholder: '自由メモ'
    }));
  }

  function ensureDialog() {
    if (dialog?.isConnected) return dialog;
    dialog = node('dialog', 'plot-overview-dialog'); dialog.id = 'plot-overview-dialog';
    const head = node('div', 'plot-overview-dialog-head');
    const headingText = node('div'); headingText.append(node('div', 'eyebrow', 'STORY OVERVIEW'), node('h2', '', '作品概要の詳細設定'));
    const close = node('button', '', '閉じる'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
    head.append(headingText, close);
    tabBar = node('nav', 'plot-overview-tabs'); tabBar.setAttribute('aria-label', '作品概要の詳細項目');
    for (const [key, label] of [['basic', '概要'], ['public', '表設定'], ['secret', '裏設定'], ['foreshadow', '伏線'], ['ending', '結末・到達点'], ['notes', '制作メモ']]) {
      const button = node('button', '', label); button.type = 'button'; button.dataset.tab = key;
      button.addEventListener('click', () => { activeTab = key; renderDialogBody(); }); tabBar.append(button);
    }
    dialogBody = node('div', 'plot-overview-dialog-body');
    dialog.append(head, tabBar, dialogBody);
    dialog.addEventListener('close', refreshOverviewBadges);
    document.body.append(dialog);
    return dialog;
  }

  function openDialog(tab = 'basic') {
    activeTab = tab;
    ensureDialog();
    renderDialogBody();
    if (!dialog.open) dialog.showModal();
  }

  function refreshOverviewBadges() {
    const overview = document.querySelector('#plot-extension .plot-overview');
    if (!overview) return;
    const details = readDetails();
    const publicBadge = overview.querySelector('[data-overview-badge="public"]');
    const secretBadge = overview.querySelector('[data-overview-badge="secret"]');
    const foreshadowBadge = overview.querySelector('[data-overview-badge="foreshadow"]');
    if (publicBadge) publicBadge.textContent = details.publicSetting.trim() ? '表設定あり' : '表設定';
    if (secretBadge) secretBadge.textContent = details.secretSetting.trim() ? '裏設定あり' : '裏設定';
    if (foreshadowBadge) {
      const unresolved = details.foreshadows.filter(item => !isForeshadowResolved(item)).length;
      foreshadowBadge.textContent = `伏線 ${details.foreshadows.length}件${unresolved && unresolved !== details.foreshadows.length ? `（未回収${unresolved}）` : ''}`;
    }
  }

  function enhanceOverview() {
    const overview = document.querySelector('#plot-extension .plot-overview');
    if (!overview || overview.dataset.detailsEnhanced === 'true') return;
    overview.dataset.detailsEnhanced = 'true';
    const heading = overview.querySelector('h2');
    if (heading) {
      const row = node('div', 'plot-overview-title-row');
      heading.replaceWith(row); row.append(heading);
      heading.tabIndex = 0; heading.setAttribute('role', 'button'); heading.setAttribute('aria-controls', 'plot-overview-dialog');
      const open = () => openDialog('basic');
      heading.addEventListener('click', open);
      heading.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      const detailButton = node('button', 'quiet plot-overview-detail-button', '詳細を見る ＞'); detailButton.type = 'button'; detailButton.addEventListener('click', open);
      row.append(detailButton);
    }
    const meta = node('div', 'plot-overview-meta');
    for (const [key, tab] of [['public', 'public'], ['secret', 'secret'], ['foreshadow', 'foreshadow']]) {
      const badge = node('button', 'plot-overview-chip'); badge.type = 'button'; badge.dataset.overviewBadge = key;
      badge.addEventListener('click', () => openDialog(tab)); meta.append(badge);
    }
    overview.append(meta);
    refreshOverviewBadges();
  }

  function mount() {
    if (mounted || typeof document === 'undefined') return;
    const host = document.getElementById('plot-extension');
    if (!host || !workspace()) return;
    mounted = true;
    injectStyles(); ensureDialog(); enhanceOverview();
    observer = new MutationObserver(() => enhanceOverview());
    observer.observe(host, { childList: true, subtree: true });
    unsubscribe = workspace().subscribe(event => {
      if (event.reason === 'package' || event.reason === 'history' || event.reason === 'screen') queueMicrotask(() => { enhanceOverview(); refreshOverviewBadges(); });
    });
  }

  const api = { createEmptyOverview, normalizeOverview, isForeshadowResolved, storageKey, loadOverview, saveOverview, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NovelPlotOverview = api;
})(globalThis);
