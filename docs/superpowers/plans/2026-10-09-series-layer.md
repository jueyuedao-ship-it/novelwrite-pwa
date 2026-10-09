# Series Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Series workspace above Work so one browser database can safely hold and switch between multiple works without changing the existing work archive schema.

**Architecture:** Keep `storage.js` as the compatibility engine for strict package/patch validation. Add `series-storage.js` before `app.js`; it upgrades IndexedDB with `series`/`workspaceMeta`, provides a stable per-work database proxy so the existing storage module keeps Work-scoped revision state, and scopes full-work `clear()`/`getAll()` calls to the active work. Add `series.js` after `app.js` for Series UI and work switching; switching persists the active work ID then reloads the page so the existing editor boot path initializes cleanly.

**Tech Stack:** Vanilla JavaScript, IndexedDB, PWA Service Worker, Node.js built-in test runner, `fake-indexeddb@6.2.5` for persistence tests.

**Spec:** `docs/superpowers/specs/2026-10-09-series-layer-design.md`

## Global Constraints

- Keep existing `NovelPackage` schema version 4 and `fumizukue-work-archive` format unchanged.
- Existing single-work databases must migrate without changing Work/Chapter/Episode/Scene/Character/Image IDs.
- Work A save/delete/replace must never modify Work B records.
- Revision conflict tracking must be independent per Work.
- Existing chapter-workspace design continues to use Work IDs; no chapter archive format change.
- Series metadata is local workspace metadata and is not included in the current work ZIP.
- Series deletion, Series ZIP, cross-work shared entities, timeline, and cross-work links are out of scope.

## Review Focus

- Upgrade from an existing v4 database with one work preserves all content and assigns one Series.
- Two works can coexist and repeated autosaves in one do not delete or conflict with the other.
- Replacing the active work with an imported package whose Work ID differs updates workspace metadata without deleting sibling works.
- Broken `workspaceMeta` repairs to a valid Series/Work instead of making boot fail.
- Deleting the active work selects another work, while deleting the final work is rejected.

---

### Task 1: Persistence compatibility layer and migration

**Files:**
- Create: `series-storage.js`
- Create: `tests/series-storage.test.js`
- Create: `package.json`
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: existing `NovelStorage`, `NovelPackage`, and IndexedDB schema v4.
- Produces: augmented `NovelStorage` with `listSeries`, `getSeries`, `updateSeries`, `listWorks`, `createWorkInSeries`, `deleteWork`, `getWorkspaceMeta`, `setActiveWorkspace`, plus compatible overrides of `openStore`, `loadWorkIndex`, `loadWork`, `saveWork`, `saveChanges`.

- [ ] **Step 1: Write failing migration/isolation tests**
  - v4 single Work -> one Series + active workspace.
  - create Work B -> `listWorks` returns A/B.
  - saving A leaves B package byte-equivalent at the model level.
  - deleting B leaves A.
  - final Work deletion rejects.
- [ ] **Step 2: Run `npm test` and verify RED** because `series-storage.js` and the new APIs do not exist.
- [ ] **Step 3: Implement `series-storage.js`**
  - `SERIES_DATABASE_VERSION = 5`.
  - First normalize legacy DB through the original v4 `openStore`, then upgrade to v5.
  - Add `series`, `workspaceMeta`, and `works.seriesId` index.
  - Use deterministic migration Series IDs so retrying migration cannot duplicate Series.
  - Create stable Work-scoped DB proxy objects; filter `getAll()` and scope `clear()` to one Work while forwarding all other IndexedDB behavior.
  - Reuse original `loadWorkIndex`, `loadWork`, and `saveChanges` through the Work-scoped proxy so existing validation remains authoritative.
  - Reuse original `saveWork` through a scoped proxy; intercept `works.put()` to preserve `seriesId` and atomically update `workspaceMeta` when replacing/creating the active work.
  - Implement Series/workspace CRUD and Work deletion with one readwrite transaction.
- [ ] **Step 4: Run `npm test` and verify GREEN.**
- [ ] **Step 5: Commit.**

### Task 2: Series screen and work switching

**Files:**
- Create: `series.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `sw.js`
- Test: `tests/series-ui-contract.test.js`

**Interfaces:**
- Consumes: Task 1 Series APIs and existing `window.NovelWorkspace`.
- Produces: `シリーズ | 本文 | プロット | キャラクター` navigation and Series screen with edit/create/open/delete.

- [ ] **Step 1: Write failing UI contract tests** asserting the Series scripts are loaded, Series tab/panel exists, and Service Worker precaches the new files.
- [ ] **Step 2: Run `npm test` and verify RED.**
- [ ] **Step 3: Add Series tab/panel and `series.js`.**
  - Render Series title/summary and Work cards.
  - Create a new Work using `NovelModel.createWork()` through `createWorkInSeries()`.
  - On Open: persist workspace selection then `location.reload()` after pending editor writes settle by waiting for save status to become saved/idle.
  - On Delete: confirm, reject last Work, delete, and reload if active Work changed.
  - Existing tabs hide the Series panel; Series tab hides the three existing panes/sidebar.
- [ ] **Step 4: Add responsive Series styles and precache assets; run `npm test` GREEN.**
- [ ] **Step 5: Commit.**

### Task 3: Import/export and replacement regression

**Files:**
- Test: `tests/series-storage.test.js`
- Modify: `series-storage.js`

**Interfaces:**
- Consumes: Task 1 scoped `saveWork`/`loadWork` behavior.
- Produces: legacy app import/export semantics scoped to the active Work.

- [ ] **Step 1: Add failing tests**
  - `loadWork(db)` returns only active Work when siblings exist.
  - `saveWork(db, packageWithDifferentWorkId)` replaces only active Work, keeps siblings, keeps Series, and updates `activeWorkId` to the imported ID.
  - Work A and Work B revision states do not conflict with each other; stale concurrent save of the same Work still conflicts.
- [ ] **Step 2: Run targeted test and verify RED.**
- [ ] **Step 3: Fix scoped proxy/revision replacement behavior minimally.**
- [ ] **Step 4: Run full `npm test` GREEN.**
- [ ] **Step 5: Commit.**

### Task 4: Final compatibility and release gate

**Files:**
- Modify only as required by failing tests/review.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: release-ready branch.

- [ ] **Step 1: Run full Node suite and syntax checks for `series-storage.js`, `series.js`, `storage.js`, `app.js`, `workspace-loader.js`.**
- [ ] **Step 2: Verify branch diff does not change `model.js`, `package.js`, `archive.js`, or chapter archive format.**
- [ ] **Step 3: Review migration, Work isolation, replacement atomicity, broken-meta repair, and last-Work protection against the spec.**
- [ ] **Step 4: Fix any Critical/Important review finding with RED→GREEN coverage; rerun full suite.**
- [ ] **Step 5: Open PR to `main`, confirm checks, merge, then verify `main` contains the merged files and is green.**
