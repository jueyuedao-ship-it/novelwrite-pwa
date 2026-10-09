# Series Archive and Series Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Series the top-level switching and backup unit while preserving Work-level archive compatibility inside the Plot Series settings.

**Architecture:** Extend the existing Series-aware IndexedDB layer rather than changing the DB schema: persist `Series.lastActiveWorkId`, add Series activation and atomic Series+initial-Work creation, then wrap existing `fumizukue-work-archive` ZIPs inside a new `fumizukue-series-archive` v1 outer ZIP. Keep `app.js` responsible for archive orchestration, `series.js` responsible for Series/Work management UI, and retain the existing topbar element IDs that chapter-workspace code intercepts while changing their full-work labels/behavior.

**Tech Stack:** Vanilla JavaScript, IndexedDB v6 integration, PWA Service Worker, `archive-common.js`/`fflate`, Node.js 22 built-in test runner, `fake-indexeddb@6.2.5`.

**Spec:** `docs/superpowers/specs/2026-10-10-series-archive-switching-design.md`

## Global Constraints

- Keep `fumizukue-work-archive` v1 unchanged.
- Keep chapter ZIP format unchanged.
- Do not bump IndexedDB version; `lastActiveWorkId` is an optional Series property.
- Do not implement Series ZIP import, Series deletion, Series-to-Series Work movement, or Work ordering UI.
- Series ZIP format is exactly `fumizukue-series-archive` with `formatVersion: 1`.
- Series ZIP Work order is Work ID ascending.
- Topbar full-work labels become `シリーズを切り替える`, `シリーズZIPで保存`, `新しいシリーズ`.
- Work ZIP export/import remains available under Plot > Series settings as `現在の作品ZIPで保存` and `作品ZIP / 旧JSONを開く`.
- Chapter-workspace mode must block Series switching, new Series creation, Work switching/add/import, Series metadata editing, and Series ZIP export.
- Existing `export-archive` and `reset` element IDs remain stable so chapter-workspace interception continues to work.

## Review Focus

- A Series whose remembered Work was deleted or belongs to another Series must fall back to the target Series' Work ID-sorted first Work without activating the wrong Work. Covered in Task 1.
- A zero-Work Series must be rejected by `setActiveSeries()` without changing `workspaceMeta/current`. Covered in Task 1.
- Failure while creating the initial Work must leave no orphan Series and must not change the previously active workspace. Covered in Task 1.
- Series archive input with duplicate Work IDs or an `activeWorkId` outside the Work set must reject before producing an archive. Covered in Task 2.
- A nested Work export failure, missing image/blob, or outer budget overflow must abort Series export without triggering a partial download. Covered in Tasks 2 and 3.

---

### Task 1: Series activation memory and atomic Series creation

**Files:**
- Modify: `series-storage.js` — Series CRUD/workspace functions and save proxy metadata write.
- Modify: `tests/series-storage.test.js`
- Modify: `tests/series-id-isolation.test.js` only if atomic creation needs the existing cross-Work collision regression.

**Interfaces:**
- Consumes: existing `listSeries(db)`, `getSeries(db, seriesId)`, `listWorks(db, seriesId)`, Work-scoped save proxy, `NovelPackage.validatePackage()`.
- Produces: `setActiveSeries(db, seriesId) -> Promise<{id:'current', activeSeriesId:string, activeWorkId:string}>`, updated `setActiveWorkspace(db, seriesId, workId)` that also persists `Series.lastActiveWorkId`, and `createSeriesWithInitialWork(db, seriesValues, rawWorkPackage) -> Promise<{series, workspaceMeta}>`.

- [ ] **Step 1: Write failing Series switching tests in `tests/series-storage.test.js`**

Add tests named:

```js
test('setActiveWorkspace remembers the last active work on its series', async () => { /* assert Series.lastActiveWorkId */ });
test('setActiveSeries restores its remembered work and records the series being left', async () => { /* assert both Series records + workspace meta */ });
test('setActiveSeries falls back to the id-sorted first valid work when memory is stale', async () => { /* assert deterministic fallback */ });
test('setActiveSeries rejects a series with no works without changing the active workspace', async () => { /* assert.rejects + meta unchanged */ });
```

- [ ] **Step 2: Run targeted storage tests and verify RED**

Run:

```bash
node --test tests/series-storage.test.js
```

Expected: FAIL because `setActiveSeries` does not exist and `setActiveWorkspace` does not persist `lastActiveWorkId`.

- [ ] **Step 3: Implement Series memory APIs in `series-storage.js`**

Implement exact behavior:

```text
setActiveWorkspace(db, seriesId, workId)
  validates Work belongs to Series
  writes target Series.lastActiveWorkId = workId
  writes workspaceMeta/current in the same readwrite transaction
  returns workspace meta

setActiveSeries(db, seriesId)
  validates Series exists
  reads target Series Works
  rejects zero Works
  records current meta.activeWorkId into current Series when valid
  resolves target Work = valid targetSeries.lastActiveWorkId else ID-ascending first Work
  writes targetSeries.lastActiveWorkId and workspaceMeta/current atomically
  returns workspace meta
```

Do not change DB version or indexes.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```bash
node --test tests/series-storage.test.js
```

Expected: PASS.

- [ ] **Step 5: Write failing atomic creation tests**

Add:

```js
test('createSeriesWithInitialWork creates one series, one work, and activates both', async () => { /* exact counts/meta */ });
test('createSeriesWithInitialWork leaves no series or workspace change when initial work save fails', async () => { /* inject invalid/colliding package */ });
```

The success assertion must include `series.lastActiveWorkId === initialWork.id`.

- [ ] **Step 6: Run targeted tests and verify RED**

Run:

```bash
node --test tests/series-storage.test.js tests/series-id-isolation.test.js
```

Expected: FAIL because `createSeriesWithInitialWork` does not exist.

- [ ] **Step 7: Implement `createSeriesWithInitialWork(db, seriesValues, rawWorkPackage)`**

Use the existing Series-aware save proxy so Series record, validated Work stores, `Series.lastActiveWorkId`, and `workspaceMeta/current` are committed in the same underlying IndexedDB write transaction. Preserve the existing global child-ID collision guard; a failed validation/collision/write must abort the whole operation.

- [ ] **Step 8: Run storage and isolation tests GREEN**

```bash
node --test tests/series-storage.test.js tests/series-id-isolation.test.js
```

- [ ] **Step 9: Commit**

```bash
git add series-storage.js tests/series-storage.test.js tests/series-id-isolation.test.js
git commit -m "feat: add series switching persistence"
```

### Task 2: Series ZIP archive module

**Files:**
- Create: `series-archive.js`
- Create: `tests/series-archive.test.js`
- Modify: `.github/workflows/test.yml` — add `node --check series-archive.js`.

**Interfaces:**
- Consumes: `NovelArchive.exportArchive(rawPackage) -> Promise<Blob>`, `NovelArchiveCommon.encodeJson`, `sha256`, `assertUncompressedBudget`, `writeArchive`.
- Produces: `exportSeriesArchive({ series, activeWorkId, works }) -> Promise<Blob>` where `works` is an array of full `{work, images}` packages.

- [ ] **Step 1: Write the failing happy-path archive test**

Create `tests/series-archive.test.js` with two minimal Work packages whose IDs are intentionally supplied out of order. Assert after `common.readArchive(blob)`:

```js
assert.equal(read.manifest.format, 'fumizukue-series-archive');
assert.equal(read.manifest.formatVersion, 1);
assert.equal(read.manifest.series.id, series.id);
assert.equal(read.manifest.activeWorkId, workA.work.id);
assert.deepEqual(read.manifest.works.map(item => item.id), [workA.work.id, workB.work.id].sort());
assert.deepEqual(read.manifest.works.map(item => item.path), ['works/0001.zip', 'works/0002.zip']);
```

For each nested path, create a `Blob` from its bytes and verify `NovelArchive.importArchive()` restores the corresponding Work package and `common.sha256(bytes)` equals the manifest hash.

- [ ] **Step 2: Run the archive test and verify RED**

```bash
node --test tests/series-archive.test.js
```

Expected: FAIL because `../series-archive.js` does not exist.

- [ ] **Step 3: Implement `series-archive.js`**

Module constants:

```text
FORMAT = 'fumizukue-series-archive'
FORMAT_VERSION = 1
```

`exportSeriesArchive()` must:

1. require a valid Series id and non-empty `works` array;
2. reject duplicate Work IDs;
3. reject `activeWorkId` not present in `works`;
4. sort packages by `work.id` ascending;
5. call existing Work `exportArchive()` for each package;
6. convert each nested ZIP Blob to bytes, hash it, and add it as `works/NNNN.zip`;
7. build the exact manifest from the spec;
8. call `assertUncompressedBudget()` across manifest bytes + nested ZIP byte lengths;
9. return `writeArchive(entries)`.

In CommonJS tests use `require('./archive')` and `require('./archive-common')`. In the browser lazily import the same dependencies if their globals are not present; do not implement Series import.

- [ ] **Step 4: Run happy-path test GREEN**

```bash
node --test tests/series-archive.test.js
```

- [ ] **Step 5: Add validation/failure tests**

Add tests that assert rejection for:

```text
duplicate Work IDs
activeWorkId outside the Work set
empty Work set
nested Work export failure caused by missing referenced image/blob
outer uncompressed budget overflow (stub or controlled oversized payload; do not allocate hundreds of MiB)
```

For failure tests, assert no returned Blob is produced.

- [ ] **Step 6: Run archive + existing Work archive tests GREEN**

```bash
node --test tests/series-archive.test.js tests/archive-common.test.js tests/archive-compat.test.js
node --check series-archive.js
```

- [ ] **Step 7: Add CI syntax check and commit**

```bash
git add series-archive.js tests/series-archive.test.js .github/workflows/test.yml
git commit -m "feat: add series archive export"
```

### Task 3: Refactor Work archive actions and add Series export orchestration

**Files:**
- Modify: `app.js` — archive helpers, topbar full-work export behavior, exposed `NovelWorkspace` actions.
- Modify: `tests/series-ui-contract.test.js` for source-level action contracts if needed.
- Test: existing `tests/archive-compat.test.js`, `tests/chapter-workspace-app.test.js` remain authoritative regressions.

**Interfaces:**
- Consumes: Task 2 `NovelSeriesArchive.exportSeriesArchive()`, existing storage APIs and existing Work ZIP import/export functions.
- Produces on `window.NovelWorkspace`: `exportCurrentWorkArchive() -> Promise<Blob|undefined>` and `requestWorkArchiveImport() -> void`; topbar `export-archive` invokes Series export in full-work mode.

- [ ] **Step 1: Write failing app contract tests**

In `tests/series-ui-contract.test.js`, assert `app.js` exposes the two Work archive hooks through `NovelWorkspace`, lazily loads `series-archive.js`, and binds `export-archive` to the Series-export path in full-work mode. Also assert the old Work import file input remains in `index.html`.

- [ ] **Step 2: Run targeted tests and verify RED**

```bash
node --test tests/series-ui-contract.test.js tests/archive-compat.test.js tests/chapter-workspace-app.test.js
```

- [ ] **Step 3: Refactor the existing Work ZIP implementation in `app.js` without changing archive format**

Rename/internalize the existing full-Work export routine as `exportCurrentWorkArchive()` and expose it via `NovelWorkspace`. Expose `requestWorkArchiveImport()` as the only public action that clicks existing `#import-file`; keep the existing change handler and `NovelArchive.importArchive`/legacy JSON parsing unchanged.

Change the replacement confirmation copy from `作品を切り替える` to `作品を置き換える` so it is not confused with Series switching.

- [ ] **Step 4: Add `exportCurrentSeriesArchive()` in `app.js`**

Exact orchestration:

1. reject when DB unavailable, app/replacement/image/composition busy, or chapter-workspace metadata is active;
2. flush pending autosave and fail if save status contains a save/conflict error;
3. get `workspaceMeta/current`, active Series, and `listWorks(activeSeriesId)`;
4. sort Work refs by ID and `loadWork(db, workId)` for each; reject if any missing;
5. lazy-load `series-archive.js` and call `exportSeriesArchive({series, activeWorkId, works: packages})`;
6. only after the promise resolves call `download(blob, filename(series.title) + '.series.zip')`;
7. surface errors through the existing toast path and never download on failure.

Keep the element ID `export-archive`; its full-work click handler now calls Series export. Do not change chapter-workspace capture behavior here.

- [ ] **Step 5: Run targeted and archive regressions GREEN**

```bash
node --test tests/series-ui-contract.test.js tests/archive-compat.test.js tests/chapter-workspace-app.test.js tests/series-archive.test.js
node --check app.js
```

- [ ] **Step 6: Commit**

```bash
git add app.js tests/series-ui-contract.test.js
git commit -m "feat: export active series archive"
```

### Task 4: Series chooser, new Series, and Plot Work archive controls

**Files:**
- Modify: `index.html`
- Modify: `series.js`
- Modify: `series.css`
- Modify: `tests/series-plot-ui.test.js`
- Modify: `tests/series-ui-contract.test.js`

**Interfaces:**
- Consumes: Task 1 `setActiveSeries()` / `createSeriesWithInitialWork()`, Task 3 `NovelWorkspace.exportCurrentWorkArchive()` / `requestWorkArchiveImport()`.
- Produces: topbar Series controls, dedicated `#series-switch-dialog`, and Plot Work archive controls.

- [ ] **Step 1: Write failing static UI contract tests**

Assert in `index.html`:

```text
#import-button text = シリーズを切り替える
#export-archive full-work text = シリーズZIPで保存
#reset text = 新しいシリーズ
Plot Series panel contains #series-export-work and #series-import-work
#series-switch-dialog exists with a list host and close/new-Series controls
```

Also assert `series.js` references `listSeries`, `setActiveSeries`, and `createSeriesWithInitialWork`.

- [ ] **Step 2: Run UI tests and verify RED**

```bash
node --test tests/series-plot-ui.test.js tests/series-ui-contract.test.js
```

- [ ] **Step 3: Update `index.html` while preserving stable IDs**

Keep IDs `import-button`, `export-archive`, and `reset`; replace their visible full-work labels only. Add within `series-settings-panel`:

```text
button#series-export-work  現在の作品ZIPで保存
button#series-import-work  作品ZIP / 旧JSONを開く
```

Add a dedicated `dialog#series-switch-dialog` outside the screen panes with a Series list container, close button, and `＋ 新しいシリーズ` action. Do not add a Series top-level tab.

- [ ] **Step 4: Implement Series chooser and creation in `series.js`**

Add:

```text
openSeriesChooser()
  assertFullWorkMode + waitForEditorIdle
  listSeries
  listWorks for count
  render current Series badge or Open button

selectSeries(seriesId)
  assertFullWorkMode + waitForEditorIdle
  NovelStorage.setActiveSeries(db, seriesId)
  location.reload()

createSeries()
  assertFullWorkMode + waitForEditorIdle
  work = NovelModel.createWork()
  NovelStorage.createSeriesWithInitialWork(db, {title:'無題のシリーズ', summary:''}, {work, images:[]})
  location.reload()
```

Bind `#import-button` to chooser, `#reset` and dialog new-Series action to `createSeries()`. Existing Work `selectWork()` continues to call `setActiveWorkspace()` and therefore updates Series memory.

Bind `#series-export-work` to `NovelWorkspace.exportCurrentWorkArchive()` and `#series-import-work` to `NovelWorkspace.requestWorkArchiveImport()`.

- [ ] **Step 5: Extend management availability**

When `assertFullWorkMode()` fails, disable topbar `#import-button`, `#reset`, Plot `#series-add-work`, `#series-import-work`, Series metadata inputs, and Work open/delete controls. `#series-export-work` follows the existing Work/chapter export policy rather than becoming a Series operation.

- [ ] **Step 6: Add chooser/archive control styles in `series.css`**

Use existing Series card/button language; add mobile behavior at the existing 720px breakpoint. Do not introduce new global styling dependencies.

- [ ] **Step 7: Run UI/storage tests GREEN and syntax check**

```bash
node --test tests/series-plot-ui.test.js tests/series-ui-contract.test.js tests/series-storage.test.js
node --check series.js
```

- [ ] **Step 8: Commit**

```bash
git add index.html series.js series.css tests/series-plot-ui.test.js tests/series-ui-contract.test.js
git commit -m "feat: switch series from the topbar"
```

### Task 5: Chapter-workspace policy and PWA cache generation

**Files:**
- Modify: `chapter-workspace-controller.js`
- Modify: `sw.js`
- Modify: `tests/series-chapter-integration.test.js`
- Modify: `tests/pwa-chapter-workspace.test.js`
- Modify: `tests/pwa-update.test.js`

**Interfaces:**
- Consumes: stable topbar IDs from Task 4 and new `series-archive.js` runtime asset.
- Produces: chapter-mode interception/disable behavior consistent with the spec and cache generation `fumizukue-series-chapter-v5`.

- [ ] **Step 1: Write failing chapter/PWA contract tests**

Assert:

```text
chapter mode disables #import-button and #reset
chapter mode keeps #export-archive intercepted as chapter ZIP, not Series ZIP
full-work label restored by chapter controller is シリーズZIPで保存
Series ZIP path is blocked while chapter metadata mode === chapter-workspace
sw.js CACHE_NAME = fumizukue-series-chapter-v5
sw.js APP_SHELL contains ./series-archive.js
```

Update old v4 cache-generation assertions to v5.

- [ ] **Step 2: Run targeted tests RED**

```bash
node --test tests/series-chapter-integration.test.js tests/pwa-chapter-workspace.test.js tests/pwa-update.test.js
```

- [ ] **Step 3: Update `chapter-workspace-controller.js`**

In `applyModeUi()` disable `#import-button` as well as the existing `#reset` when chapter mode is active. Keep the capture listener on `#export-archive`; chapter mode still relabels it `章ZIPで保存` and exports the active chapter. When not in chapter mode, its label must be `シリーズZIPで保存`.

Do not let chapter mode trigger Series chooser/new-Series code; the UI is disabled and Series-side guards remain defense-in-depth.

- [ ] **Step 4: Bump Service Worker generation and precache Series archive module**

Set:

```js
const CACHE_NAME = 'fumizukue-series-chapter-v5';
```

Add `./series-archive.js` to `APP_SHELL`. Preserve `skipWaiting`, `clients.claim`, and current update/reload behavior.

- [ ] **Step 5: Run targeted tests and syntax checks GREEN**

```bash
node --test tests/series-chapter-integration.test.js tests/pwa-chapter-workspace.test.js tests/pwa-update.test.js
node --check chapter-workspace-controller.js
node --check series-archive.js
```

- [ ] **Step 6: Commit**

```bash
git add chapter-workspace-controller.js sw.js tests/series-chapter-integration.test.js tests/pwa-chapter-workspace.test.js tests/pwa-update.test.js
git commit -m "fix: align chapter mode with series controls"
```

### Task 6: Documentation, full regression, integration, and release gate

**Files:**
- Modify: `README.md` — user-facing backup/switch wording only.
- Modify only other runtime/test files if a newly observed regression requires a RED→GREEN fix.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: merge-ready feature branch with all compatibility promises verified.

- [ ] **Step 1: Update README user flows**

Document that normal/full-work mode uses Series switching and Series ZIP backup, while single Work ZIP import/export now lives under Plot > Series settings. Update chapter-workspace return instructions so they point to `作品ZIP / 旧JSONを開く` in Plot rather than the former topbar `作品を開く`. Do not claim Series ZIP import exists.

- [ ] **Step 2: Run the full automated suite**

```bash
npm test
```

Expected: all tests PASS, including pre-existing Work ZIP, chapter ZIP, v4/v5→v6 migration, revision conflict, Series isolation, and PWA update tests.

- [ ] **Step 3: Run complete syntax verification**

```bash
node --check series-storage.js
node --check series-schema.js
node --check workspace-storage.js
node --check series-archive.js
node --check series.js
node --check storage.js
node --check app.js
node --check chapter-workspace-controller.js
node --check workspace-loader.js
```

Expected: every command exits 0. Ensure `.github/workflows/test.yml` contains the new `series-archive.js` check.

- [ ] **Step 4: Inspect final diff against the approved spec**

Verify:

```text
no IndexedDB version bump
no change to fumizukue-work-archive format/version
no change to chapter archive format/version
no Series ZIP import path
no Series tab reintroduced
Series ZIP includes every active-Series Work exactly once
Work ZIP actions remain reachable in Plot
chapter workspace cannot switch/create Series or export Series ZIP
```

If any Critical/Important issue is found, add a failing test first, make the minimal fix, and repeat Steps 2–4.

- [ ] **Step 5: Integrate latest `main` before PR**

Refresh `main`; if it advanced, integrate it into the implementation branch and rerun Steps 2–4. Confirm branch is 0 commits behind `main` before opening the final PR.

- [ ] **Step 6: Commit documentation/integration changes**

```bash
git add README.md .github/workflows/test.yml
git commit -m "docs: update series backup workflow"
```

Skip an empty commit if no integration fix was needed.

- [ ] **Step 7: Open PR and verify release gates**

Open a PR to `main`; require successful PR CI. Before merge, review changed files for scope and archive compatibility. After authorized merge, verify the merge commit is the `main` head, `main` push CI is successful, and GitHub Pages deployment succeeds.

- [ ] **Step 8: Manual-browser limitation statement**

If no real browser session/device was used, completion notes must explicitly state that automated/static verification passed but browser UI interaction was not manually smoke-tested.
