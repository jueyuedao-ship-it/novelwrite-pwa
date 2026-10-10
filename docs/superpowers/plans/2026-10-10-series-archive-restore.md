# Series Archive Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe `.series.zip` import and atomic restore for `fumizukue-series-archive` v1, including all Works, original IDs, same-Series replacement, cross-Series collision rejection, and manifest `activeWorkId` restoration.

**Architecture:** Extend `series-archive.js` with a strict read/validation path that reuses the existing Work ZIP importer. Refactor `storage.js` so one validated Work can be written into an existing transaction, then use that primitive from `series-storage.js` to preflight collisions and restore an entire Series in one IndexedDB transaction. `series.js` owns the UI orchestration and explicit replacement confirmation; existing Work ZIP and chapter ZIP flows remain unchanged.

**Tech Stack:** Vanilla JavaScript, IndexedDB, `fake-indexeddb`, Node.js `node:test`, existing `archive-common.js` ZIP helpers and `archive.js` Work archive importer, GitHub Actions, GitHub Pages PWA.

**Spec:** `docs/superpowers/specs/2026-10-10-series-archive-restore-design.md`

## Global Constraints

- Series archive format remains exactly `fumizukue-series-archive` version `1`.
- Work archive format remains exactly `fumizukue-work-archive` version `1`.
- Chapter archive format remains unchanged.
- No IndexedDB version bump; keep the current schema/version.
- No automatic ID remapping, partial restore, or cross-Series merge behavior.
- All outer and nested archive validation must finish before IndexedDB mutation.
- Same-Series replacement is allowed only after explicit UI confirmation.
- IDs owned by another Series must reject the restore.
- Restore commit must be atomic across `series`, `workspaceMeta`, and all Work stores.
- Chapter-workspace mode must keep Series ZIP import/export/switching/new-Series disabled while preserving the master Work ZIP exit path.

## Review Focus

- **Tampered or structurally ambiguous Series ZIP:** checksum mismatch, extra entries, non-canonical paths, duplicate/unsorted Work IDs must fail before storage code runs. Task 1 adds these tests.
- **Same-Series replacement with changed Work membership:** replacing a Series that gained/lost Works locally must not silently delete concurrent edits; transaction-time membership comparison must abort stale inspection. Task 3 adds this test.
- **Cross-Series collision introduced after preflight:** another tab can claim an incoming ID between inspection and commit; the write transaction must re-check and abort. Task 3 adds this test.
- **Mid-restore request/quota failure:** no partially restored Series, Work, child record, registry row, or workspace metadata may remain. Task 3 adds an injected-abort rollback test.
- **Chapter mode / duplicate import interaction:** Series ZIP input must be unavailable in chapter-workspace mode and the busy guard must prevent overlapping imports while keeping the master Work ZIP exit usable. Task 4 adds these tests.

---

### Task 1: Add strict Series ZIP import validation

**Files:**
- Modify: `series-archive.js`
- Modify: `tests/series-archive.test.js`

**Interfaces:**
- Consumes: `NovelArchiveCommon.readArchive(file)`, `NovelArchiveCommon.sha256(bytes)`, existing `NovelArchive.importArchiveRead(readResult)`.
- Produces: `importSeriesArchive(file) -> Promise<SeriesRestoreValue>` and `importSeriesArchiveRead(readResult) -> Promise<SeriesRestoreValue>`.
- `SeriesRestoreValue` shape: `{ series: { id, title, summary }, activeWorkId, works }`, where `works` is the fully validated Work-package array sorted by Work ID ascending.

- [ ] **Step 1: Write failing happy-path import test**

Add `series archive imports a valid multi-work export into validated work packages` to `tests/series-archive.test.js`. Export a two-Work Series with the existing exporter, import it through `importSeriesArchive(blob)`, and assert Series metadata, Work ID order, Work titles, and `activeWorkId` round-trip exactly.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/series-archive.test.js`

Expected: FAIL because `importSeriesArchive` / `importSeriesArchiveRead` do not exist.

- [ ] **Step 3: Implement the minimal import API**

In `series-archive.js`, add:

```js
async function importSeriesArchive(file)
async function importSeriesArchiveRead(readResult)
```

`importSeriesArchive()` reads the outer ZIP with `common.readArchive()` and delegates to `importSeriesArchiveRead()`.

`importSeriesArchiveRead()` must validate `format`, `formatVersion`, Series metadata, non-empty Work list, Work ID ascending order, exact canonical `works/0001.zip` paths, unique IDs/paths, lowercase 64-char hashes, declared-entry allow-list, `activeWorkId`, nested SHA-256 values, nested Work ZIP validity via `workArchive.importArchiveRead()`, and outer/nested Work ID/title equality.

- [ ] **Step 4: Add hostile archive tests**

Add tests covering:

```text
unsupported format/version
empty works
unsorted Work IDs
duplicate Work IDs
duplicate/non-canonical paths
missing declared nested ZIP
extra undeclared outer entry
invalid sha256 syntax
nested ZIP checksum mismatch
invalid nested Work ZIP
outer/nested Work ID mismatch
outer/nested Work title mismatch
foreign activeWorkId
```

At least one test must mutate an otherwise valid exported Series ZIP and rebuild it with `archive-common.writeArchive()` so validation is exercised against realistic bytes.

- [ ] **Step 5: Run the archive tests and full archive regressions**

Run:

```bash
node --test tests/series-archive.test.js tests/archive-common.test.js tests/archive-compat.test.js tests/chapter-archive.test.js
node --check series-archive.js
```

Expected: all PASS; existing Work and chapter archive tests remain unchanged.

- [ ] **Step 6: Commit Task 1**

```bash
git add series-archive.js tests/series-archive.test.js
git commit -m "feat: import and validate series archives"
```

---

### Task 2: Extract a transaction-local Work writer without changing existing save semantics

**Files:**
- Modify: `storage.js`
- Create: `tests/storage-work-writer.test.js`
- Regression: `tests/series-storage.test.js`

**Interfaces:**
- Consumes: a validated Work package and an already-open IndexedDB transaction spanning all existing Work stores.
- Produces: exported base-storage helper:

```js
writeValidatedWorkToTransaction(tx, value, {
  revision,
  workRecordExtras = {}
})
```

The helper writes one validated Work and all child rows/`idRegistry` entries into the supplied transaction. It does not clear stores, open/commit/abort the transaction, validate external archive input, or mutate the `workRevisions` cache.

- [ ] **Step 1: Write failing transaction-writer equivalence test**

Create `tests/storage-work-writer.test.js`. Open a v4 base storage database with `fake-indexeddb`, validate a Work package, open a read-write transaction over the Work stores, call `writeValidatedWorkToTransaction(...)`, commit, then assert `loadWork()` returns the same Work structure and image payload metadata as a normal `saveWork()` result.

Also assert `workRecordExtras: { seriesId: 'series-x' }` appears only on the stored Work record and does not alter the validated package.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/storage-work-writer.test.js`

Expected: FAIL because `writeValidatedWorkToTransaction` is not exported.

- [ ] **Step 3: Refactor the existing row-writing body**

In `storage.js`, extract the existing full Work row serialization from `saveWork()` into:

```js
function writeValidatedWorkToTransaction(tx, value, { revision, workRecordExtras = {} } = {})
```

It must preserve the existing ordering fields, `sceneScopeKey`, image blob rows, line-character references, and all `idRegistry` entries. Require `revision` to be a positive safe integer.

Change `saveWork()` to keep its existing revision/conflict check, store clearing, transaction lifecycle, and `workRevisions` update, but call the new helper for the actual row writes.

Export the helper on the base storage API so `series-storage.js` can consume it.

- [ ] **Step 4: Add regression assertions for ordinary save behavior**

In `tests/storage-work-writer.test.js`, compare normal `saveWork()` behavior before/after the refactor for: Work revision increment, line IDs in `idRegistry`, image blobs, and Work-load round trip.

- [ ] **Step 5: Run storage regressions**

Run:

```bash
node --test tests/storage-work-writer.test.js tests/series-storage.test.js tests/series-id-isolation.test.js tests/series-creation-id-isolation.test.js
node --check storage.js
```

Expected: all PASS with no schema/version changes.

- [ ] **Step 6: Commit Task 2**

```bash
git add storage.js tests/storage-work-writer.test.js
git commit -m "refactor: share validated work transaction writer"
```

---

### Task 3: Add restore preflight and atomic Series restore

**Files:**
- Modify: `series-storage.js`
- Create: `tests/series-restore-storage.test.js`
- Regression: `tests/series-storage.test.js`
- Regression: `tests/series-switching-storage.test.js`

**Interfaces:**
- Consumes: Task 1 `SeriesRestoreValue`; Task 2 `baseStorage.writeValidatedWorkToTransaction(...)`.
- Produces:

```js
inspectSeriesRestore(db, restoreValue) -> Promise<{
  mode: 'create' | 'replace',
  seriesId: string,
  targetWorkIds: string[]
}>

restoreSeries(db, restoreValue, inspection) -> Promise<{
  series,
  workspaceMeta
}>
```

`targetWorkIds` is sorted by Work ID. `restoreSeries()` must reject if the target Series existence/membership no longer matches the supplied inspection or if collision ownership changed.

- [ ] **Step 1: Write failing inspection tests**

Create `tests/series-restore-storage.test.js` with `fake-indexeddb` helpers. Add tests asserting:

```text
new Series returns mode=create and performs zero writes
existing matching Series returns mode=replace with sorted targetWorkIds
incoming Work ID owned by another Series rejects
incoming child/global ID owned by another Series rejects
IDs owned only by the target Series are allowed for replace
```

Snapshot `listSeries()`, `listWorks()`, and active workspace before/after inspection to prove it is read-only.

- [ ] **Step 2: Run inspection tests and verify RED**

Run: `node --test tests/series-restore-storage.test.js`

Expected: FAIL because `inspectSeriesRestore` / `restoreSeries` do not exist.

- [ ] **Step 3: Implement incoming-ID collection and inspection**

In `series-storage.js`, add an internal collector for every global ID represented in `idRegistry`: Work, chapter, episode, line, scene, character, image, and character custom-field IDs.

Implement:

```js
async function inspectSeriesRestore(db, restoreValue)
```

Defensively validate every Work package with `packageTools.validatePackage()`, require unique incoming global IDs, ensure `activeWorkId` belongs to the incoming Work set, read local `works` + `idRegistry`, map owner Work IDs to Series IDs, and reject any incoming ID owned outside the target Series.

- [ ] **Step 4: Write failing atomic restore tests**

Add tests asserting:

```text
create writes all incoming Works and activates manifest activeWorkId
restored Series lastActiveWorkId equals activeWorkId
replace removes old target-Series Works not present in archive
replace preserves unrelated Series and their child records
same Work ID replacement advances _revision above local value
pre-restore stale tab save is rejected after restore
membership changed after inspection causes restore conflict
cross-Series ID claimed after inspection causes restore conflict
mid-transaction injected request failure rolls back Series/Works/registry/workspaceMeta
```

For the rollback test, use a controllable fake/monkey-patched request or transaction hook at the storage boundary rather than changing production semantics merely to create a failure.

- [ ] **Step 5: Implement `restoreSeries()` in one transaction**

Implement:

```js
async function restoreSeries(db, restoreValue, inspection)
```

Open one read-write transaction over `series`, `workspaceMeta`, and every `BASE_STORE_NAMES` store. Before deletion, read current target-Series Works and collision ownership inside that same transaction and require they still match `inspection.mode` + `inspection.targetWorkIds`; then reject any cross-Series incoming-ID collision.

For replacement, delete all rows for the target Series' current Works from every Work store. For each incoming Work, compute revision as `max(1, existingSameIdRevision + 1)` and call Task 2's transaction-local writer with `{ workRecordExtras: { seriesId: restoreValue.series.id } }`. Write the Series record with preserved archive `id/title/summary`, a fresh local `createdAt/updatedAt` policy consistent with current records, and `lastActiveWorkId`. Write `workspaceMeta/current` last.

After commit, invalidate `scopeCache` entries for all removed/restored Work IDs. Do not bump IndexedDB version.

- [ ] **Step 6: Run restore/storage regression suite**

Run:

```bash
node --test tests/series-restore-storage.test.js tests/series-storage.test.js tests/series-switching-storage.test.js tests/series-id-isolation.test.js tests/series-creation-id-isolation.test.js
node --check series-storage.js
```

Expected: all PASS; stale-save conflict behavior remains intact.

- [ ] **Step 7: Commit Task 3**

```bash
git add series-storage.js tests/series-restore-storage.test.js
git commit -m "feat: restore series archives atomically"
```

---

### Task 4: Add Series ZIP restore UI and chapter-workspace guards

**Files:**
- Modify: `index.html`
- Modify: `series.js`
- Modify: `chapter-workspace-controller.js`
- Modify: `series.css` or `styles.css` only if layout needs it
- Modify: `tests/series-topbar-ui.test.js`
- Modify: `tests/series-chapter-integration.test.js`
- Modify: `tests/chapter-workspace-app.test.js`

**Interfaces:**
- Consumes: Task 1 `importSeriesArchive(file)`; Task 3 `inspectSeriesRestore(db, value)` and `restoreSeries(db, value, inspection)`.
- Produces: top-level `シリーズZIPを開く` control with dedicated hidden file input, plus Series restore orchestration in `series.js`.

- [ ] **Step 1: Write failing UI contract tests**

Update `tests/series-topbar-ui.test.js` to require:

```html
<button id="import-series-button" type="button">シリーズZIPを開く</button>
<input id="import-series-file" type="file" accept=".zip,application/zip" hidden>
```

Keep the existing `import-button` Work ZIP behavior and `import-file` input assertions unchanged.

Add source assertions that `series.js` calls `importSeriesArchive`, then `inspectSeriesRestore`, confirms only when `mode === 'replace'`, calls `restoreSeries`, and reloads after success.

- [ ] **Step 2: Run UI contract tests and verify RED**

Run:

```bash
node --test tests/series-topbar-ui.test.js tests/series-chapter-integration.test.js tests/chapter-workspace-app.test.js
```

Expected: FAIL because the new Series import control/orchestration does not exist.

- [ ] **Step 3: Add the dedicated Series ZIP input and orchestration**

In `index.html`, add `import-series-button` and `import-series-file` alongside Series-level actions without replacing `import-button`.

In `series.js`, add:

```js
async function importSeries(file)
```

Flow: `withSeriesOperation()` → `assertFullWorkMode()` → `waitForEditorIdle()` → Task 1 import → Task 3 inspection → optional explicit destructive confirm naming the Series → Task 3 restore → success toast → `location.reload()`.

Clear the file input value after each attempt so selecting the same ZIP again still triggers `change`. Ensure overlapping imports are ignored by the existing `seriesOperation` guard.

- [ ] **Step 4: Add replacement/cancel/error-order tests**

Add tests proving:

```text
mode=create does not call confirm
mode=replace requires confirm before restore
cancel means restoreSeries is never called
cross-Series/preflight errors occur before confirm
success reloads after restore
same file can be selected again after failure/cancel
```

Use source/DOM contract tests consistent with the repository's existing UI-test style; do not introduce a new browser framework.

- [ ] **Step 5: Enforce chapter-workspace behavior**

Update `chapter-workspace-controller.js` and Series UI mode syncing so `import-series-button` is disabled in chapter-workspace mode, while the existing top-level Work ZIP control remains enabled and labeled `マスター作品ZIPを開く` for exiting chapter mode.

Add a regression test that the Series ZIP button returns to enabled state in normal full-work mode.

- [ ] **Step 6: Run UI/chapter regressions and syntax checks**

Run:

```bash
node --test tests/series-topbar-ui.test.js tests/series-chapter-integration.test.js tests/chapter-workspace-app.test.js tests/chapter-workspace-ui.test.js tests/chapter-workspace-observer-loop.test.js
node --check series.js
node --check chapter-workspace-controller.js
```

Expected: all PASS; Work ZIP and master-Work exit paths remain present.

- [ ] **Step 7: Commit Task 4**

```bash
git add index.html series.js chapter-workspace-controller.js series.css styles.css tests/series-topbar-ui.test.js tests/series-chapter-integration.test.js tests/chapter-workspace-app.test.js
git commit -m "feat: restore series archives from the UI"
```

---

### Task 5: Update PWA/docs and run release gates

**Files:**
- Modify: `sw.js`
- Modify: `README.md`
- Modify: `tests/pwa-chapter-workspace.test.js`
- Modify: `tests/pwa-update.test.js`
- Regression: all `tests/*.test.js`

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: deployable PWA app shell that exposes the restore UI immediately after update, plus user documentation of create-vs-replace semantics and limitations.

- [ ] **Step 1: Write failing PWA/docs tests**

Update PWA tests to require a new cache generation after the current main value and to require all runtime assets used by Series restore to be cached, including `series-archive.js` and the updated UI shell.

Add/extend a README contract test only if the repo already tests README text; otherwise update README without creating brittle prose-only assertions.

- [ ] **Step 2: Run focused PWA tests and verify RED**

Run:

```bash
node --test tests/pwa-chapter-workspace.test.js tests/pwa-update.test.js
```

Expected: FAIL because the cache generation/docs have not yet been updated.

- [ ] **Step 3: Bump the Service Worker cache generation and document restore**

In `sw.js`, increment the app-shell cache name exactly once; keep existing activation/update behavior unchanged.

In `README.md`, document:

```text
シリーズZIPで保存 -> 全Workのバックアップ
シリーズZIPを開く -> 全Workの復元
same Series ID -> explicit replacement confirmation
other Series ID/global-ID collision -> restore rejected
restore is all-or-nothing
Work ZIP and chapter ZIP remain separate formats
Series ZIP v1 only; no merge/partial restore/ID remap
```

- [ ] **Step 4: Run the complete local-equivalent test gate**

Run:

```bash
npm test
node --check series-storage.js
node --check series-schema.js
node --check workspace-storage.js
node --check series.js
node --check series-archive.js
node --check storage.js
node --check app.js
node --check chapter-workspace-controller.js
node --check workspace-loader.js
```

Expected: zero test failures and zero syntax errors.

- [ ] **Step 5: Review the complete diff against the approved spec**

Check specifically that:

```text
no DB version changed
no Work ZIP/chapter ZIP format changed
no ID remapping exists
all archive validation precedes DB mutation
restore is one transaction
cross-Series collision preflight and transaction re-check both exist
chapter mode cannot invoke Series restore
```

Fix any Critical/Important discrepancy before opening the PR.

- [ ] **Step 6: Integrate latest `main` before PR if needed**

Compare feature branch to `main`. If `behind_by > 0`, merge/rebase current `main`, resolve conflicts without dropping tests, then rerun Step 4 in full.

- [ ] **Step 7: Open PR and require PR CI success**

PR title:

```text
feat: restore series archives
```

PR body must summarize validation, atomic replacement, collision rules, compatibility, and verification results. Do not merge while PR CI is queued/in-progress/failing.

- [ ] **Step 8: Merge to `main` only after review and green CI**

Use the repository's normal merge method and expected head SHA protection. Record the merge commit SHA.

- [ ] **Step 9: Verify post-merge `main` CI and GitHub Pages deployment**

Require both the `main` push test workflow and Pages deployment for the merge SHA to conclude `success`. Confirm `main` contains the Series restore control, import API, restore storage API, and new Service Worker cache generation.

- [ ] **Step 10: Final completion report**

Report the PR number, merge SHA, exact passing test count from post-merge logs, syntax-check result, Pages deployment result, and the implemented restore semantics. Do not claim browser-device manual verification unless it was actually performed.
