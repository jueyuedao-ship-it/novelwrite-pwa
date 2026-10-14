const fs = require('node:fs');

function transform(file, label, fn) {
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`${label}: expected source was not changed`);
  fs.writeFileSync(file, after);
  console.log(`updated ${file}: ${label}`);
}

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`${label}: source fragment not found`);
  if (source.indexOf(search, index + search.length) >= 0) throw new Error(`${label}: source fragment is not unique`);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

transform('series.js', 'track series save promise', source => replaceOnce(
  source,
  '  let saveTimer = null;\n  let chapterMode = false;',
  '  let saveTimer = null;\n  let seriesSavePromise = null;\n  let chapterMode = false;',
  'series save state'
));

transform('series.js', 'flush series fields before export', source => {
  const oldBlock = `  function scheduleSeriesSave() {\n    clearTimeout(saveTimer);\n    saveTimer = setTimeout(() => {\n      if (!activeSeries || $('series-title').disabled) return;\n      void root.NovelStorage.updateSeries(db, activeSeries.id, {\n        title: $('series-title').value,\n        summary: $('series-summary').value\n      }).then(value => {\n        activeSeries = value;\n      }).catch(error => toast(error.message));\n    }, 350);\n  }`;
  const newBlock = `  function currentSeriesFields() {\n    return {\n      title: $('series-title').value,\n      summary: $('series-summary').value\n    };\n  }\n\n  function startSeriesSave() {\n    if (seriesSavePromise) return seriesSavePromise;\n    if (!activeSeries || $('series-title').disabled) return Promise.resolve(activeSeries);\n    const seriesId = activeSeries.id;\n    const fields = currentSeriesFields();\n    const operation = seriesDb()\n      .then(store => root.NovelStorage.updateSeries(store, seriesId, fields))\n      .then(value => {\n        if (activeSeries?.id === seriesId) activeSeries = value;\n        return value;\n      });\n    const tracked = operation.finally(() => {\n      if (seriesSavePromise === tracked) seriesSavePromise = null;\n    });\n    seriesSavePromise = tracked;\n    return tracked;\n  }\n\n  async function flushSeriesSave() {\n    const deadline = Date.now() + 15000;\n    while (Date.now() < deadline) {\n      clearTimeout(saveTimer);\n      saveTimer = null;\n      if (seriesSavePromise) await seriesSavePromise;\n      if (!activeSeries || $('series-title').disabled) return;\n      const fields = currentSeriesFields();\n      if (activeSeries.title === fields.title && activeSeries.summary === fields.summary) return;\n      await startSeriesSave();\n    }\n    throw new Error('シリーズ設定の保存完了を確認できませんでした。');\n  }\n\n  function scheduleSeriesSave() {\n    clearTimeout(saveTimer);\n    saveTimer = setTimeout(() => {\n      saveTimer = null;\n      void flushSeriesSave().catch(error => toast(error.message));\n    }, 350);\n  }`;
  return replaceOnce(source, oldBlock, newBlock, 'series save implementation');
});

transform('series.js', 'export after explicit flush barriers', source => replaceOnce(
  source,
  `  async function exportSeries() {\n    await withSeriesOperation(async () => {\n      await assertFullWorkMode();\n      await waitForEditorIdle();\n      const store = await seriesDb();`,
  `  async function exportSeries() {\n    await withSeriesOperation(async () => {\n      await assertFullWorkMode();\n      await flushSeriesSave();\n      if (typeof root.NovelWorkspace?.flushForArchive === 'function') {\n        await root.NovelWorkspace.flushForArchive();\n      } else {\n        await waitForEditorIdle();\n      }\n      const store = await seriesDb();`,
  'series export barrier'
));

transform('app.js', 'add operation state', source => replaceOnce(
  source,
  '  let composingElement = null, busy = false, pendingImageLoads = 0;',
  '  let composingElement = null, busy = false, pendingImageLoads = 0, pendingOperations = 0;',
  'workspace operation state'
));

transform('app.js', 'show asynchronous operations as pending', source => replaceOnce(
  source,
  `    else if (saveInFlight) { status.textContent = '保存中…'; status.classList.add('save-pending'); }\n    else if (saveTimer) { status.textContent = '保存待ち…'; status.classList.add('save-pending'); }`,
  `    else if (saveInFlight) { status.textContent = '保存中…'; status.classList.add('save-pending'); }\n    else if (pendingOperations || pendingImageLoads) { status.textContent = '処理中…'; status.classList.add('save-pending'); }\n    else if (saveTimer) { status.textContent = '保存待ち…'; status.classList.add('save-pending'); }`,
  'save status operation state'
));

transform('app.js', 'register generic asynchronous operations', source => replaceOnce(
  source,
  `  function beginImageLoad() {\n    pendingImageLoads++;\n    paintSaveStatus();\n    let released = false;\n    return () => {\n      if (released) return;\n      released = true;\n      pendingImageLoads--;\n      if (pendingChanges && !saveError) scheduleSave(0);\n      paintSaveStatus();\n    };\n  }`,
  `  function beginOperation() {\n    pendingOperations++;\n    paintSaveStatus();\n    let released = false;\n    return () => {\n      if (released) return;\n      released = true;\n      pendingOperations--;\n      if (pendingChanges && !saveError) scheduleSave(0);\n      paintSaveStatus();\n    };\n  }\n  function beginImageLoad() {\n    const finishOperation = beginOperation();\n    pendingImageLoads++;\n    paintSaveStatus();\n    let released = false;\n    return () => {\n      if (released) return;\n      released = true;\n      pendingImageLoads--;\n      finishOperation();\n    };\n  }`,
  'workspace operation API'
));

transform('app.js', 'state-based archive flush barrier', source => {
  const oldBlock = `  async function flushPendingSave() {\n    clearTimeout(saveTimer); saveTimer = null;\n    if (pendingChanges && !saveInFlight && !composingElement && !pendingImageLoads && !saveError) void startPersistChanges();\n    const start = Date.now();\n    while ((saveInFlight || pendingChanges || saveRevision > savedRevision) && Date.now() - start < 15000) {\n      if (saveError) throw new Error(saveError);\n      if (pendingChanges && !saveInFlight && !savePromise && !composingElement && !pendingImageLoads) void startPersistChanges();\n      await new Promise(resolve => setTimeout(resolve, 30));\n    }\n    if (saveRevision > savedRevision) throw new Error(saveError || '保存が完了していません。');\n  }`;
  const newBlock = `  async function flushForArchive() {\n    if (composingElement) throw new Error('文字入力の変換を確定してからZIPを保存してください。');\n    if (busy || replacingPackage) throw new Error('現在の操作が完了してからZIPを保存してください。');\n    const start = Date.now();\n    while (Date.now() - start < 15000) {\n      if (saveError) throw new Error(saveError);\n      if (composingElement) throw new Error('文字入力の変換を確定してからZIPを保存してください。');\n      if (busy || replacingPackage) throw new Error('現在の操作が完了してからZIPを保存してください。');\n      if (!pendingOperations && !pendingImageLoads) {\n        clearTimeout(saveTimer);\n        saveTimer = null;\n        if (pendingChanges && !saveInFlight && !savePromise) void startPersistChanges();\n        if (!saveInFlight && !savePromise && !pendingChanges && saveRevision <= savedRevision) return;\n      }\n      await new Promise(resolve => setTimeout(resolve, 30));\n    }\n    if (pendingOperations || pendingImageLoads) throw new Error('画像または編集中の処理が完了していません。');\n    throw new Error(saveError || '保存が完了していません。');\n  }\n  async function flushPendingSave() {\n    await flushForArchive();\n  }`;
  return replaceOnce(source, oldBlock, newBlock, 'archive flush implementation');
});

transform('app.js', 'include operations in unload guard', source => replaceOnce(
  source,
  '    if (saveRevision > savedRevision || composingElement || pendingImageLoads) { event.preventDefault(); event.returnValue = \'\'; }',
  '    if (saveRevision > savedRevision || composingElement || pendingImageLoads || pendingOperations) { event.preventDefault(); event.returnValue = \'\'; }',
  'beforeunload guard'
));

transform('app.js', 'expose operation and archive barrier APIs', source => replaceOnce(
  source,
  `    loadImage: id => db ? NovelStorage.loadImage(db, id) : requireStore(),\n    beginImageLoad,\n    openPlotScene:`,
  `    loadImage: id => db ? NovelStorage.loadImage(db, id) : requireStore(),\n    beginOperation,\n    beginImageLoad,\n    flushForArchive,\n    openPlotScene:`,
  'workspace exports'
));

transform('characters.js', 'track asynchronous character rename', source => {
  source = replaceOnce(
    source,
    `        addField(details, '人物名', character.name, async name => {\n          if (name === character.name) return;\n          try {`,
    `        addField(details, '人物名', character.name, async name => {\n          if (name === character.name) return;\n          const finishOperation = workspace.beginOperation();\n          try {`,
    'character rename operation start'
  );
  return replaceOnce(
    source,
    `          } catch (error) { workspace.toast(\`人物名を変更できませんでした：\${error.message}\`); await render(); }\n        }, { commitOnChange: true });`,
    `          } catch (error) { workspace.toast(\`人物名を変更できませんでした：\${error.message}\`); await render(); }\n          finally { finishOperation(); }\n        }, { commitOnChange: true });`,
    'character rename operation finish'
  );
});

transform('plot.js', 'track asynchronous episode reordering', source => {
  source = replaceOnce(
    source,
    `    async function moveEpisode(episodeId, delta) {\n      const state = getState(), episodes = sortedEpisodes(state, selectedChapterId), index = episodes.findIndex(item => item.id === episodeId);\n      const nextIndex = index + delta; if (index < 0 || nextIndex < 0 || nextIndex >= episodes.length) return;\n      const beforeRecords = await loadEpisodeBodies([episodes[index], episodes[nextIndex]], state);`,
    `    async function moveEpisode(episodeId, delta) {\n      const state = getState(), episodes = sortedEpisodes(state, selectedChapterId), index = episodes.findIndex(item => item.id === episodeId);\n      const nextIndex = index + delta; if (index < 0 || nextIndex < 0 || nextIndex >= episodes.length) return;\n      const finishOperation = workspace.beginOperation();\n      try {\n        const beforeRecords = await loadEpisodeBodies([episodes[index], episodes[nextIndex]], state);`,
    'episode reorder operation start'
  );
  return replaceOnce(
    source,
    `      workspace.commit(editorState.applyPatch(latest, patch), patch, \`plot:chapter:\${selectedChapterId}:episodes:order\`);\n      void render();\n    }`,
    `        workspace.commit(editorState.applyPatch(latest, patch), patch, \`plot:chapter:\${selectedChapterId}:episodes:order\`);\n        void render();\n      } finally {\n        finishOperation();\n      }\n    }`,
    'episode reorder operation finish'
  );
});
