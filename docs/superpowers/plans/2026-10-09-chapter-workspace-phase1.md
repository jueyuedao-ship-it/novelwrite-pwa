# Chapter Workspace Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dedicated one-chapter ZIP format that can be exported from a full work and opened as a lightweight single-chapter workspace while work-level/character data remains read-only.

**Architecture:** Add a DOM-free Chapter Bundle layer, a chapter ZIP codec that shares hardened ZIP primitives with the existing archive path, and explicit IndexedDB workspace metadata. The application will dispatch full-work ZIPs and chapter ZIPs through separate import routes, expose the current workspace mode through `NovelWorkspace`, and enforce shared-data read-only rules both in UI affordances and the workspace commit boundary.

**Tech Stack:** Vanilla JavaScript, IndexedDB, Blob/Web Crypto, bundled `fflate`, Service Worker cache, Node `node:test` / `node:assert`.

**Spec:** `docs/superpowers/specs/2026-10-09-chapter-workspace-archive-design.md`

## Global Constraints

- Chapter ZIP format identifier is exactly `fumizukue-chapter-archive` with `formatVersion: 1`.
- Existing `fumizukue-work-archive` version 1 import/export behavior must remain compatible.
- Preserve all existing work/chapter/episode/line/scene/character/image IDs when exporting and opening a chapter pack.
- In chapter-workspace v1, work-level settings and characters are read-only; chapter metadata, episodes, chapter/episode scenes, and scene-owned images are editable.
- A v1 chapter workspace contains one loaded chapter. Multi-chapter add/remove is Phase 3 and is not implemented by this plan.
- A chapter with zero episodes is rejected in Phase 1 because the current editor and package invariants require an episode body to open.
- No new runtime dependency is added; use the checked-in `vendor/fflate.mjs` codec.
- ZIP limits and validation remain at least as strict as the current archive path: max ZIP 258 MiB, max entry 64 MiB, max expanded total 256 MiB, max 10,010 entries; reject encrypted, duplicate-name, unsupported-method, multi-disk, and ZIP64 inputs.
- Existing autosave, unsaved-change protection, image validation, and full-work ZIP backup remain operational.
- Phase 1 does not implement edited-chapter reintegration into a master. It records `baseChapterHash` now so Phase 2 can use it without changing the archive contract.
- The detailed plot-overview data currently stored only in `localStorage` is not part of the chapter archive contract. Chapter mode must not present or mutate that local data as if it came from the chapter pack.

## Review Focus

- A chapter archive whose `sourceWorkId` or contained records disagree must be rejected before storage mutation; pinned by Task 2 import-validation tests.
- A ZIP with an extra entry, duplicate entry, bad checksum, unsupported compression/encryption flags, or oversized expanded payload must be rejected; pinned by Task 2 archive tests.
- A bundle that references a character/image/scene/episode not included in its closed dependency set must be rejected; pinned by Task 1 validation tests.
- Chapter mode must never mutate work metadata, character records, character-owned images, or local-only detailed overview data; pinned by Tasks 3 and 6 policy tests.
- Export during pending edits/image loads must either include the latest merged patch or retain the current blocking/error behavior; pinned by Task 4 orchestration tests/static assertions and Task 7 browser verification.

---

### Task 1: Chapter Bundle extraction and validation

**Files:**
- Create: `chapter-bundle.js`
- Create: `tests/chapter-bundle.test.js`

**Interfaces:**
- Consumes: validated full-work packages shaped as `{ work, images }`.
- Produces: `buildChapterBundle(rawPackage, chapterId) -> Promise<ChapterBundle>`.
- Produces: `validateChapterBundle(rawBundle) -> ChapterBundle`.
- Produces: `chapterBundleToPackage(bundle) -> { work, images }` for persistence with existing package validation.
- Produces: `canonicalChapterValue(bundle, sceneImageHashes) -> object` for Task 2 hashing.

- [ ] **Step 1: Write failing extraction tests**

Cover these assertions in `tests/chapter-bundle.test.js`:

```js
assert.equal(bundle.chapter.id, targetChapterId);
assert.deepEqual(bundle.episodes.map(item => item.chapterId), [targetChapterId, targetChapterId]);
assert.ok(bundle.scenes.every(scene => scene.chapterId === targetChapterId));
assert.deepEqual(bundle.characters.map(item => item.id).sort(), ['character-line', 'character-scene']);
assert.equal(bundle.catalog.length, source.work.chapters.length);
assert.ok(bundle.images.some(image => image.ownerType === 'scene'));
assert.ok(bundle.images.some(image => image.ownerType === 'character'));
```

Also prove unreferenced characters, scenes, episodes, and images are absent.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/chapter-bundle.test.js`
Expected: FAIL because `chapter-bundle.js` does not exist.

- [ ] **Step 3: Implement `buildChapterBundle(rawPackage, chapterId)`**

The bundle shape is fixed as:

```js
{
  sourceWork: { schemaVersion, id, title, summary },
  catalog: [{ id, title, order, episodeCount, textLength }],
  chapter,
  episodes,
  scenes,
  characters,
  images // metadata plus `blob`, for scene-owned and included-character-owned images
}
```

`textLength` is the sum of `line.text.length` for episodes in that catalog chapter. Character closure comes from selected episode `line.characterId` plus selected scene `characterIds`. Include all character-owned images for those included characters and all scene-owned images referenced by selected scenes.

- [ ] **Step 4: Add failing validation/closure tests**

Test `validateChapterBundle` rejects: wrong work IDs, episode assigned to another chapter, scene episode/chapter mismatch, missing referenced character, missing referenced image, image owner mismatch, duplicate IDs, and zero-episode bundles.

- [ ] **Step 5: Implement `validateChapterBundle(rawBundle)` and `chapterBundleToPackage(bundle)`**

`chapterBundleToPackage` must keep the source work ID and build a one-chapter partial package that passes the existing `NovelPackage.validatePackage()` contract.

- [ ] **Step 6: Add canonical-value tests**

Verify `canonicalChapterValue` is unchanged when only shared character text/catalog/work summary changes, but changes when chapter title, episode line text, scene content, scene-image metadata, or a supplied scene-image hash changes.

- [ ] **Step 7: Implement `canonicalChapterValue(bundle, sceneImageHashes)`**

Canonicalize only chapter-owned data: chapter record; episodes ordered by `order` then `id`; scenes ordered by scope/order/id; scene-owned image metadata; and the scene-image SHA-256 map. Do not include characters, character images, catalog, source summary, or timestamps.

- [ ] **Step 8: Run tests**

Run: `node --test tests/chapter-bundle.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add chapter-bundle.js tests/chapter-bundle.test.js
git commit -m "feat: add chapter bundle model"
```

---

### Task 2: Hardened chapter ZIP codec and full-ZIP compatibility

**Files:**
- Create: `archive-common.js`
- Create: `chapter-archive.js`
- Create: `tests/archive-common.test.js`
- Create: `tests/chapter-archive.test.js`
- Create: `tests/archive-compat.test.js`
- Modify: `archive.js`

**Interfaces:**
- Consumes from Task 1: `buildChapterBundle`, `validateChapterBundle`, `chapterBundleToPackage`, `canonicalChapterValue`.
- Produces from `archive-common.js`: `readArchive(file)`, `writeArchive(entries)`, `sha256(bytes)`, `encodeJson(value)`, `parseJson(files, name)`, `extensionFor(mimeType)`, and shared size constants.
- Produces from `chapter-archive.js`: `exportChapterArchive(rawPackage, chapterId, options?) -> Promise<Blob>`.
- Produces: `importChapterArchiveRead(readResult) -> Promise<{ bundle, packageValue, workspaceMeta }>`.
- Produces: `importChapterArchive(file) -> Promise<{ bundle, packageValue, workspaceMeta }>` convenience wrapper.
- Existing `NovelArchive.exportArchive(rawPackage)` and `NovelArchive.importArchive(file)` signatures stay unchanged.

- [ ] **Step 1: Write failing common ZIP safety tests**

Pin the existing limits and reject malformed EOCD/central-directory data, duplicate names, encrypted entries, unsupported methods, ZIP64 sentinels, oversized entry/expanded totals, and invalid UTF-8 entry names.

- [ ] **Step 2: Run the common tests and verify failure**

Run: `node --test tests/archive-common.test.js`
Expected: FAIL because `archive-common.js` does not exist.

- [ ] **Step 3: Extract reusable ZIP primitives into `archive-common.js`**

Use the checked-in `./vendor/fflate.mjs` via dynamic import in Node and browser paths. `readArchive(file)` performs preflight, exactly one unzip, size verification, and `manifest.json` parse. `writeArchive(entries)` enforces entry and total limits before returning an `application/zip` Blob.

- [ ] **Step 4: Write a failing full-work archive regression test before refactoring `archive.js`**

Round-trip a minimal no-image valid work through `exportArchive()` then `importArchive()` and assert the restored package equals the validated source package. Also assert a chapter-format manifest is rejected by the full-work import adapter.

- [ ] **Step 5: Refactor `archive.js` onto `archive-common.js` without changing its public API**

Full-work import must consume one `readArchive()` result internally; keep format/version/hash/image-path allow-list behavior and existing Japanese error semantics materially equivalent.

- [ ] **Step 6: Run full-work compatibility tests**

Run: `node --test tests/archive-common.test.js tests/archive-compat.test.js`
Expected: PASS.

- [ ] **Step 7: Write failing chapter archive round-trip tests**

Assert exported `manifest.json` has exactly:

```js
{
  format: 'fumizukue-chapter-archive',
  formatVersion: 1,
  schemaVersion: 4,
  sourceWorkId,
  chapterId,
  baseRevision,
  baseChapterHash,
  exportedAt,
  hashes,
  images
}
```

Assert JSON allow-list is `work-ref.json`, `catalog.json`, `chapter/chapter.json`, `chapter/episodes.json`, `chapter/scenes.json`, `refs/characters.json`, `refs/shared.json`, plus declared image paths and `manifest.json` only.

- [ ] **Step 8: Implement `chapter-archive.js` export/import**

`baseChapterHash` is SHA-256 over the stable JSON encoding returned by `canonicalChapterValue`, with scene-image blob hashes supplied. Character images are checksummed for archive integrity but excluded from `baseChapterHash` because they are shared/read-only.

`importChapterArchiveRead` validates the format, exact file set, checksums, image bytes/MIME types, bundle closure, `sourceWorkId`, `chapterId`, and then returns the partial package plus workspace metadata. No storage mutation occurs here.

- [ ] **Step 9: Add malicious/mismatch tests**

Cover bad `sourceWorkId`, bad `chapterId`, missing JSON, unexpected JSON, missing image, undeclared image, wrong checksum, path mismatch, and record reference mismatch.

- [ ] **Step 10: Run archive tests**

Run: `node --test tests/archive-common.test.js tests/archive-compat.test.js tests/chapter-archive.test.js`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add archive-common.js archive.js chapter-archive.js tests/archive-common.test.js tests/archive-compat.test.js tests/chapter-archive.test.js
git commit -m "feat: add chapter archive codec"
```

---

### Task 3: Workspace metadata and shared-data mutation policy

**Files:**
- Create: `workspace-mode.js`
- Create: `tests/workspace-mode.test.js`
- Modify: `storage.js`

**Interfaces:**
- Consumes from Task 2: `workspaceMeta` returned from chapter import.
- Produces from `workspace-mode.js`: `normalizeWorkspaceMeta(raw)`, `createChapterWorkspaceMeta(bundle, baseChapterHash, exportedAt)`, `assertPatchAllowed(meta, patch)`.
- Produces from `storage.js`: `loadWorkspaceMeta(store) -> Promise<object|null>` and `saveChapterWorkspace(store, packageValue, workspaceMeta) -> Promise<object>`.
- Existing `saveWork(store, packageValue)` remains the full-work path and clears active chapter-workspace metadata.

- [ ] **Step 1: Write failing workspace metadata tests**

Assert normalized chapter metadata contains:

```js
{
  id: 'active',
  mode: 'chapter-workspace',
  sourceWorkId,
  catalog,
  loadedChapterIds: [chapterId],
  baselines: { [chapterId]: { baseChapterHash, exportedAt } },
  sharedReadOnly: true
}
```

- [ ] **Step 2: Add failing mutation-policy tests**

`assertPatchAllowed` must reject `patch.work`, `patch.characters`, and character-owned image upserts/deletes while allowing selected-chapter episode/scene edits and scene-owned image edits. It must reject mutations targeting a chapter ID outside `loadedChapterIds`.

- [ ] **Step 3: Run and verify failure**

Run: `node --test tests/workspace-mode.test.js`
Expected: FAIL because `workspace-mode.js` does not exist.

- [ ] **Step 4: Implement `workspace-mode.js`**

Full-work/null metadata is unrestricted. Chapter-workspace metadata enforces the Phase 1 rules above. The policy is intentionally independent from DOM and IndexedDB.

- [ ] **Step 5: Add `workspaceMeta` store to IndexedDB version 5**

Update `DATABASE_VERSION` from `4` to `5`; include `workspaceMeta` with keyPath `id`. Normal `saveWork()` must clear it. Existing version 1–4 migrations must continue to create/register existing stores exactly as before.

- [ ] **Step 6: Implement `saveChapterWorkspace` and `loadWorkspaceMeta`**

`saveChapterWorkspace` validates the partial package and normalized metadata, then writes the package and `workspaceMeta[id='active']` in the same logical replacement transaction. Do not persist metadata if package validation/writing fails.

- [ ] **Step 7: Run unit tests and syntax checks**

Run: `node --test tests/workspace-mode.test.js`
Expected: PASS.

Run: `node --check storage.js && node --check workspace-mode.js`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add workspace-mode.js storage.js tests/workspace-mode.test.js
git commit -m "feat: persist chapter workspace mode"
```

---

### Task 4: Application import/export orchestration

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Create: `tests/chapter-workspace-app.test.js`

**Interfaces:**
- Consumes: `NovelArchiveCommon.readArchive`, `NovelArchive.importArchiveRead`/existing adapter, `NovelChapterArchive.importChapterArchiveRead`, `NovelWorkspaceMode.assertPatchAllowed`, and storage metadata APIs.
- Produces through `window.NovelWorkspace`: `getWorkspaceMeta()`, `exportChapter(chapterId)` in addition to existing methods.

- [ ] **Step 1: Write failing static/orchestration tests**

Using Node file reads/assertions, pin that `index.html` loads `workspace-mode.js` before `app.js`; `app.js` exposes `getWorkspaceMeta` and `exportChapter`; the ZIP import branch dispatches on manifest `format`; and chapter imports call `saveChapterWorkspace` rather than `installPackage`/`saveWork`.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/chapter-workspace-app.test.js`
Expected: FAIL on missing wiring.

- [ ] **Step 3: Track `workspaceMeta` in `app.js` boot/install state**

At boot, load `NovelStorage.loadWorkspaceMeta(db)` after opening the store. Full-work creation/import/reset sets the in-memory mode to full work. Chapter import sets the returned chapter metadata.

- [ ] **Step 4: Enforce mutation policy at `commitWorkspace`**

Before applying/queuing a patch, call `NovelWorkspaceMode.assertPatchAllowed(workspaceMeta, patch)`. This is the central protection used by manuscript, plot, and character extensions.

- [ ] **Step 5: Implement one-read ZIP dispatch**

Load the shared archive reader once, call `readArchive(file)`, then dispatch by `read.manifest.format`:

- `fumizukue-work-archive` -> existing full-work import adapter and normal replace confirmation.
- `fumizukue-chapter-archive` -> chapter import adapter and chapter-workspace replacement confirmation.
- anything else -> unsupported ZIP error.

Avoid unzipping the same file twice.

- [ ] **Step 6: Implement `exportChapter(chapterId)`**

Reuse the current full ZIP export safety sequence: block during replacement/input/image load, attempt `flushPendingSave`, load saved package, overlay `pendingChanges` + `activeChanges`, then call `exportChapterArchive`. Filename is `${filename(work.title)}_${filename(chapter.title)}.zip`.

- [ ] **Step 7: Define Ctrl/Cmd+S behavior**

In full-work mode keep exporting the whole work. In chapter-workspace mode export the single loaded chapter pack, so the keyboard backup command never creates a misleading “full” backup from a partial workspace.

- [ ] **Step 8: Run tests and syntax checks**

Run: `node --test tests/chapter-workspace-app.test.js`
Expected: PASS.

Run: `node --check app.js`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add app.js index.html tests/chapter-workspace-app.test.js
git commit -m "feat: open and export chapter workspaces"
```

---

### Task 5: Chapter workspace status, catalog, and chapter export UI

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js`
- Modify: `plot.js`
- Create: `tests/chapter-workspace-ui.test.js`

**Interfaces:**
- Consumes: `NovelWorkspace.getWorkspaceMeta()` and `NovelWorkspace.exportChapter(chapterId)` from Task 4.
- Produces: visible chapter-workspace banner/catalog; per-chapter “章ZIP保存” action in full-work plot UI.

- [ ] **Step 1: Write failing UI wiring tests**

Assert stable IDs/classes exist for `workspace-mode-strip` and `chapter-catalog`, `plot.js` calls `workspace.exportChapter(chapter.id)`, and unloaded catalog rows use a distinct class/disabled action path.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/chapter-workspace-ui.test.js`
Expected: FAIL.

- [ ] **Step 3: Add workspace status UI**

In chapter mode show copy equivalent to:

```text
章ワークスペース
「<chapter title>」のみ読み込み中
```

Include an explicit “作品全体ではありません” indication. Hide the strip in full-work mode.

- [ ] **Step 4: Add lightweight catalog rendering**

Render `workspaceMeta.catalog` without loading episode bodies. The loaded chapter is normal; unloaded chapters are muted and non-editable with a message that their data is not present. Do not implement “章を追加” or “全章を読み込む” actions yet; those belong to later phases.

- [ ] **Step 5: Add chapter export action to plot chapter rows**

In full-work mode each chapter row offers `章ZIP保存`. In chapter-workspace mode the loaded chapter can still be exported, but chapter create/delete/reorder controls that would violate the one-chapter Phase 1 model are disabled or omitted.

- [ ] **Step 6: Run UI tests and syntax checks**

Run: `node --test tests/chapter-workspace-ui.test.js`
Expected: PASS.

Run: `node --check app.js && node --check plot.js`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add index.html styles.css app.js plot.js tests/chapter-workspace-ui.test.js
git commit -m "feat: show chapter workspace context"
```

---

### Task 6: Read-only shared screens and local-overview isolation

**Files:**
- Modify: `characters.js`
- Modify: `plot-overview.js`
- Modify: `plot.js`
- Create: `tests/chapter-workspace-readonly.test.js`

**Interfaces:**
- Consumes: `NovelWorkspace.getWorkspaceMeta()` and central commit policy from Task 4.
- Produces: read-only character UI and safe overview behavior in chapter mode.

- [ ] **Step 1: Write failing read-only wiring tests**

Pin that both `characters.js` and `plot-overview.js` query workspace metadata; character mutation entry points are guarded in chapter mode; and `plot-overview.js` does not call `saveOverview`/work summary commit from chapter mode.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/chapter-workspace-readonly.test.js`
Expected: FAIL.

- [ ] **Step 3: Make characters read-only in chapter mode**

Keep navigation, search, reference display, and image viewing. Disable/hide add, delete, text-edit, custom-field mutation, image add/remove/reorder, and any commit-producing control. Add a visible note that character data is a snapshot from the master work.

- [ ] **Step 4: Isolate detailed plot overview data**

Because detailed overview data is currently localStorage-only and is not in the chapter pack, chapter mode must not show the local master editor as editable chapter data. Render a read-only notice such as “詳細設定はマスター作品で編集してください”; show the chapter pack’s `work.summary` snapshot read-only if useful, but do not read/write `fumizukue.plot-overview.v1:<workId>` for chapter-mode editing.

- [ ] **Step 5: Ensure basic work title/summary controls are non-editable**

Disable the main work-title field and any plot summary editor in chapter mode. The central `assertPatchAllowed` remains the defense if a UI regression attempts the mutation.

- [ ] **Step 6: Run tests and syntax checks**

Run: `node --test tests/chapter-workspace-readonly.test.js`
Expected: PASS.

Run: `node --check characters.js && node --check plot-overview.js && node --check plot.js`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add characters.js plot-overview.js plot.js tests/chapter-workspace-readonly.test.js
git commit -m "feat: protect shared data in chapter mode"
```

---

### Task 7: Offline cache, regression suite, and browser acceptance pass

**Files:**
- Modify: `sw.js`
- Modify: `README.md`
- Create: `tests/chapter-workspace-cache.test.js`

**Interfaces:**
- Consumes all Phase 1 modules.
- Produces a cache-complete/offline-capable Phase 1 build and documented user workflow.

- [ ] **Step 1: Write failing cache test**

Assert `APP_SHELL` contains `archive-common.js`, `chapter-bundle.js`, `chapter-archive.js`, and `workspace-mode.js`, and the cache name changes from the previous release value.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/chapter-workspace-cache.test.js`
Expected: FAIL until service-worker wiring is updated.

- [ ] **Step 3: Update `sw.js` and README**

Bump `CACHE_NAME`; cache new static modules. Document: full-work ZIP remains the canonical complete backup; a chapter ZIP is a partial work pack; chapter mode keeps shared settings read-only; edited chapter reintegration is not yet included in Phase 1.

- [ ] **Step 4: Run the complete automated suite**

Run:

```bash
node --test tests/*.test.js
node --check app.js
node --check archive.js
node --check archive-common.js
node --check chapter-archive.js
node --check chapter-bundle.js
node --check workspace-mode.js
node --check storage.js
node --check plot.js
node --check plot-overview.js
node --check characters.js
node --check sw.js
```

Expected: all tests PASS; all syntax checks exit 0.

- [ ] **Step 5: Browser acceptance verification**

Using a disposable work with at least two chapters, a referenced character, one scene image, and one character image, verify:

1. Export chapter A; filename contains work + chapter title.
2. Existing full-work ZIP export/import still works.
3. Open chapter A ZIP; banner clearly says it is a chapter workspace.
4. Catalog shows chapter B as unloaded without loading its body.
5. Chapter A body, scenes, and scene images can be edited and autosaved.
6. Work title/summary, characters, character images, and detailed overview cannot be modified.
7. Reload the PWA offline; chapter workspace metadata and loaded chapter reopen correctly.
8. Ctrl/Cmd+S in chapter mode downloads a chapter archive, not a full-work archive.
9. Malformed/wrong-work chapter archives are rejected without replacing the current valid workspace.

- [ ] **Step 6: Commit**

```bash
git add sw.js README.md tests/chapter-workspace-cache.test.js
git commit -m "docs: finish chapter workspace phase 1"
```

---

## Scope Boundary After Phase 1

Do **not** implement these in this plan:

- Edited chapter -> master reintegration/conflict dialog (Phase 2).
- Multiple chapter packs in one workspace or chapter removal/GC (Phase 3).
- Full-work archive v2 / Chapter Bundle collection format (Phase 4).
- Selective entry inflation from a full-work v2 ZIP (Phase 5).
- Shared-character/settings merge (`shared-changes.json`) (future extension).

These should receive separate implementation plans after the preceding phase APIs are verified. Phase 2 can rely on the Phase 1 `baseChapterHash` contract without changing chapter ZIP v1.