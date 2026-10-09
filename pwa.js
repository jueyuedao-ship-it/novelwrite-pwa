(() => {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshScheduled = false;

  function editorIsSaved() {
    const app = document.getElementById('app');
    const status = document.getElementById('save-status');
    if (app?.getAttribute('aria-busy') === 'true') return false;
    if (!status) return true;
    return status.textContent.includes('保存済み');
  }

  function reloadWhenSafe() {
    if (!hadController || refreshScheduled) return;
    refreshScheduled = true;
    const startedAt = Date.now();
    const check = () => {
      if (editorIsSaved()) {
        location.reload();
        return;
      }
      if (Date.now() - startedAt >= 15000) {
        refreshScheduled = false;
        window.NovelWorkspace?.toast?.('アプリの更新があります。保存状態を確認してからページを再読み込みしてください。');
        return;
      }
      setTimeout(check, 250);
    };
    check();
  }

  navigator.serviceWorker.addEventListener('controllerchange', reloadWhenSafe);

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(registration => registration.update())
      .catch(error => {
        console.warn('Service Worker の登録に失敗しました。', error);
      });
  });
})();
