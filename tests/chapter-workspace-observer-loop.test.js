const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const controllerCode = fs.readFileSync(path.join(__dirname, '..', 'chapter-workspace-controller.js'), 'utf8');

function makeElement(text = '') {
  let currentText = text;
  return {
    disabled: false,
    hidden: false,
    dataset: {},
    attributes: new Map(),
    addEventListener() {},
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    get textContent() { return currentText; },
    set textContent(value) {
      currentText = String(value);
      notifyChildListMutation();
    }
  };
}

let activeObserver = null;
function notifyChildListMutation() {
  const observer = activeObserver;
  if (!observer?.observing || observer.queued) return;
  observer.queued = true;
  setTimeout(() => {
    observer.queued = false;
    if (!observer.observing) return;
    observer.deliveries++;
    if (observer.deliveries > 12) {
      observer.disconnect();
      return;
    }
    observer.callback([]);
  }, 0);
}

async function startController(workspaceMeta) {
  activeObserver = null;
  const main = makeElement();
  main.dataset.ready = 'true';
  const workOption = makeElement('作品全体');
  const strip = makeElement();
  const importButton = makeElement('シリーズを切り替える');
  const tabPlot = makeElement();
  const tabCharacters = makeElement();
  const textNode = { textContent: 'ZIPで保存 ' };
  const exportButton = makeElement();
  exportButton.firstChild = textNode;
  const textScope = makeElement();
  textScope.querySelector = selector => selector === 'option[value="work"]' ? workOption : null;

  const elements = new Map([
    ['main', main],
    ['workspace-mode-strip', strip],
    ['import-button', importButton],
    ['txt-scope', textScope],
    ['export-archive', exportButton],
    ['tab-plot', tabPlot],
    ['tab-characters', tabCharacters]
  ]);
  const document = {
    body: {},
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.deliveries = 0;
      this.observing = false;
      this.queued = false;
      activeObserver = this;
    }
    observe(_target, options) {
      assert.equal(options.subtree, true);
      assert.equal(options.childList, true);
      this.observing = true;
    }
    disconnect() { this.observing = false; }
  }

  const baseWorkspace = {
    commit() {},
    getState() { return {}; },
    beginImageLoad() { return () => {}; },
    subscribe() {},
    toast() {}
  };
  const context = vm.createContext({
    document,
    MutationObserver: FakeMutationObserver,
    NovelWorkspace: baseWorkspace,
    NovelWorkspaceMode: { assertPatchAllowed() {} },
    NovelStorage: {
      async openStore() { return {}; },
      async loadWorkspaceMeta() { return workspaceMeta; }
    },
    sessionStorage: { getItem() { return null; }, removeItem() {}, setItem() {} },
    structuredClone,
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(controllerCode, context, { filename: 'chapter-workspace-controller.js' });
  assert.equal(tabPlot.disabled, true, 'controller starts by waiting for workspace readiness');
  await new Promise(resolve => {
    const deadline = Date.now() + 1000;
    const check = () => {
      if (!tabPlot.disabled || Date.now() >= deadline) return resolve();
      setTimeout(check, 1);
    };
    check();
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  const deliveries = activeObserver.deliveries;
  activeObserver.disconnect();
  return { context, deliveries, workOption, strip, importButton };
}

test('full-work startup child-list observer settles after applying the UI', async () => {
  const fullWork = await startController(null);
  assert.equal(fullWork.context.NovelChapterWorkspace.getWorkspaceMeta(), null);
  assert.ok(fullWork.deliveries <= 1, `full-work observer fired ${fullWork.deliveries} times`);
  assert.equal(fullWork.workOption.textContent, '作品全体');
  assert.equal(fullWork.importButton.textContent, 'シリーズを切り替える');
});

test('chapter-workspace startup child-list observer settles after applying the UI', async () => {
  const chapterMode = await startController({
    mode: 'chapter-workspace',
    sourceWorkId: 'work-1',
    loadedChapterIds: ['chapter-1'],
    catalog: [{ id: 'chapter-1', title: '第一章' }]
  });
  assert.equal(chapterMode.context.NovelChapterWorkspace.getWorkspaceMeta().mode, 'chapter-workspace');
  assert.ok(chapterMode.deliveries <= 1, `chapter-workspace observer fired ${chapterMode.deliveries} times`);
  assert.equal(chapterMode.workOption.textContent, '読み込み済み章');
  assert.equal(chapterMode.strip.textContent, '章ワークスペース · 第一章のみを編集中 · 作品全体ではありません');
  assert.equal(chapterMode.importButton.textContent, 'マスター作品ZIPを開く');
});
