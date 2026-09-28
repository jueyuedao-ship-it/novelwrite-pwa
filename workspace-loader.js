'use strict';
(() => {
  const screens = [
    { name: 'plot', module: './plot.js', globalName: 'NovelPlot' },
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
      const loading = import(screen.module).then(() => {
        const extension = globalThis[screen.globalName];
        if (!extension || typeof extension.mount !== 'function') {
          throw new Error(`${screen.name}画面を初期化できません。`);
        }
        extension.mount();
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
