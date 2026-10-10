const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`${label} marker not found`);
  return source.replace(before, after);
}

// index.html
{
  const path = 'index.html';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    '        <button id="import-button" type="button">作品ZIPを開く</button>\n        <button id="import-chapter-button" type="button">章ZIPを開く</button>',
    '        <button id="import-button" type="button">作品ZIPを開く</button>\n        <button id="import-series-button" type="button">シリーズZIPを開く</button>\n        <button id="import-chapter-button" type="button">章ZIPを開く</button>',
    'index topbar import buttons'
  );
  source = replaceOnce(
    source,
    '      <input id="import-file" type="file" accept=".json,application/json,.zip,application/zip" hidden>\n      <input id="import-chapter-file" type="file" accept=".zip,application/zip" hidden>',
    '      <input id="import-file" type="file" accept=".json,application/json,.zip,application/zip" hidden>\n      <input id="import-series-file" type="file" accept=".zip,application/zip" hidden>\n      <input id="import-chapter-file" type="file" accept=".zip,application/zip" hidden>',
    'index hidden inputs'
  );
  fs.writeFileSync(path, source);
}

// series.js
{
  const path = 'series.js';
  let source = fs.readFileSync(path, 'utf8');
  const exportMarker = '  async function exportSeries() {';
  const importBlock = `  async function importSeries(file) {
    if (!file) return false;
    return withSeriesOperation(async () => {
      await assertFullWorkMode();
      await waitForEditorIdle();
      const store = await seriesDb();
      const archive = await loadSeriesArchiveModule();
      const restoreValue = await archive.importSeriesArchive(file);
      const inspection = await root.NovelStorage.inspectSeriesRestore(store, restoreValue);
      if (inspection.mode === 'replace') {
        const title = restoreValue.series.title || 'このシリーズ';
        const confirmed = root.confirm(\`「\${title}」をシリーズZIPの内容で置き換えます。\\n端末内のこのシリーズにある全作品はバックアップ内容で置き換わります。\\nこの操作は元に戻せません。\`);
        if (!confirmed) return false;
      }
      await root.NovelStorage.restoreSeries(store, restoreValue, inspection);
      toast(\`「\${restoreValue.series.title || 'シリーズ'}」を復元しました。\`);
      location.reload();
      return true;
    });
  }

`;
  if (!source.includes(exportMarker)) throw new Error('series export marker not found');
  source = source.replace(exportMarker, importBlock + exportMarker);

  source = replaceOnce(
    source,
    "    const importButton = $('import-button');\n    const resetButton = $('reset');",
    "    const importButton = $('import-button');\n    const seriesImportButton = $('import-series-button');\n    const resetButton = $('reset');",
    'series topbar variables'
  );
  source = replaceOnce(
    source,
    "    if (importButton) {\n      importButton.textContent = chapterMode ? 'マスター作品ZIPを開く' : '作品ZIPを開く';\n      importButton.disabled = false;\n    }\n    if (resetButton) {",
    "    if (importButton) {\n      importButton.textContent = chapterMode ? 'マスター作品ZIPを開く' : '作品ZIPを開く';\n      importButton.disabled = false;\n    }\n    if (seriesImportButton) seriesImportButton.disabled = chapterMode;\n    if (resetButton) {",
    'series import availability'
  );

  const bottomMarker = "  $('tab-plot')?.addEventListener('click', renderIfPlotActive);";
  const listeners = `  $('import-series-button')?.addEventListener('click', () => {
    if (chapterMode || seriesOperation) return;
    $('import-series-file')?.click();
  });
  $('import-series-file')?.addEventListener('change', () => {
    const input = $('import-series-file');
    const file = input?.files?.[0];
    if (input) input.value = '';
    if (!file) return;
    void importSeries(file).catch(error => toast(\`シリーズZIPを取り込めませんでした：\${error?.message || error}\`));
  });
`;
  if (!source.includes(bottomMarker)) throw new Error('series bottom marker not found');
  source = source.replace(bottomMarker, listeners + bottomMarker);
  fs.writeFileSync(path, source);
}

// chapter-workspace-controller.js
{
  const path = 'chapter-workspace-controller.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "      const reset = $('reset'); if (reset) reset.disabled = chapterMode;",
    "      const seriesImportButton = $('import-series-button'); if (seriesImportButton) seriesImportButton.disabled = chapterMode;\n      const reset = $('reset'); if (reset) reset.disabled = chapterMode;",
    'chapter series import guard'
  );
  fs.writeFileSync(path, source);
}
