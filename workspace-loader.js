'use strict';
(() => {
  const screens = [
    { name: 'plot', module: './plot.js', globalName: 'NovelPlot', companionModule: './plot-overview.js', companionGlobalName: 'NovelPlotOverview' },
    { name: 'characters', module: './characters.js', globalName: 'NovelCharacters' }
  ];
  const pending = new Map();
  const loaded = new Set();

  for (const screen of screens) {
    const button = document.getElementById(`tab-${screen.name}`);
    if (!button) continue;

    button.addEventListener('click', event => {
      if (loaded.has(screen.name)) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      if (pending.has(screen.name)) return;
      const imports = [import(screen.module)];
      if (screen.companionModule) imports.push(import(screen.companionModule));
      const loading = Promise.all(imports).then(() => {
        const extension = globalThis[screen.globalName];
        if (!extension || typeof extension.mount !== 'function') {
          throw new Error(`${screen.name}画面を初期化できません。`);
        }
        extension.mount();
        if (screen.companionGlobalName) {
          const companion = globalThis[screen.companionGlobalName];
          if (!companion || typeof companion.mount !== 'function') throw new Error(`${screen.name}画面の詳細機能を初期化できません。`);
          companion.mount();
        }
        loaded.add(screen.name);
        globalThis.NovelWorkspace?.selectScreen(screen.name);
      }).catch(error => {
        console.error(`${screen.name}画面を読み込めませんでした。`, error);
        globalThis.NovelWorkspace?.toast(`${screen.name === 'plot' ? 'プロット' : 'キャラクター'}画面を読み込めませんでした。`);
      }).finally(() => pending.delete(screen.name));
      pending.set(screen.name, loading);
    }, { capture: true });
  }
})();
