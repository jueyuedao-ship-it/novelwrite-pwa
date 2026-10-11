# Series Archive Restore Design

Status: Accepted
Date: 2026-10-10

## 1. Purpose

Add safe import and restore support for the existing `fumizukue-series-archive` v1 format.

The user must be able to export a Series ZIP on one device and later restore the whole Series, including every Work and the previously active Work, without changing the existing Work ZIP or chapter ZIP formats.

## 2. Goals

- Open a `.series.zip` produced by the current Series export implementation.
- Validate the outer Series archive and every nested Work archive before modifying IndexedDB.
- Restore all Works in the archive as one Series.
- Preserve all Series, Work, chapter, episode, line, scene, character, image, and custom-field IDs from the archive.
- Restore `activeWorkId` from the Series manifest.
- Preserve the user-controlled Work order encoded by the manifest sequence.
- If the same Series ID already exists locally, allow the user to replace that Series after explicit confirmation.
- Reject restores that would collide with IDs owned by another local Series.
- Make the local restore atomic: either the complete Series is restored or IndexedDB remains unchanged.
- Preserve stale-save/revision conflict behavior for restored Works.
- Keep existing Work ZIP import/export and chapter ZIP behavior unchanged.
- Keep chapter-workspace Series operations disabled.

## 3. Non-goals

This change does not add:

- automatic ID remapping or "duplicate as new Series" behavior;
- merge-by-Work or merge-by-record behavior;
- partial restore of selected Works;
- cross-version Series archive migration beyond `fumizukue-series-archive` v1;
- cloud synchronization;
- Series deletion UI;
- changes to `fumizukue-work-archive` v1;
- changes to the chapter archive format;
- a destructive IndexedDB migration.

## 4. Existing archive contract

The existing Series archive remains unchanged:

```text
<series-title>.series.zip
├─ manifest.json
└─ works/
   ├─ 0001.zip
   ├─ 0002.zip
   └─ ...
```

The outer manifest has this shape:

```json
{
  "format": "fumizukue-series-archive",
  "formatVersion": 1,
  "series": {
    "id": "series-id",
    "title": "Series title",
    "summary": "Series summary"
  },
  "activeWorkId": "work-id",
  "works": [
    {
      "id": "work-id",
      "title": "Work title",
      "path": "works/0001.zip",
      "sha256": "..."
    }
  ]
}
```

Each nested ZIP must remain a valid `fumizukue-work-archive` v1 archive.

The current exporter preserves the user-controlled Work order in the manifest. The importer treats manifest order as the Series Work order to restore.

## 5. Restore semantics

### 5.1 New Series ID

If no local Series has the archive's `series.id`, restore creates that Series and all nested Works, then activates the archive's `activeWorkId`.

No existing Series is modified.

### 5.2 Existing matching Series ID

If a local Series with the same `series.id` exists, the UI must show a destructive confirmation before any write begins.

If confirmed, restore replaces only that Series:

- every existing Work belonging to that Series is removed;
- every nested Work from the archive is written;
- Series title and summary are replaced by archive values;
- `lastActiveWorkId` is set to the archive's `activeWorkId`;
- `workspaceMeta/current` is changed to the restored Series and `activeWorkId`.

Other Series must remain unchanged.

If the user cancels, no write occurs.

### 5.3 ID conflicts with other Series

IDs in a restored Series are authoritative and are not remapped.

Before replacement confirmation and before write, restore must reject the archive if any global ID that belongs to the incoming Series is already owned by a Work outside the target Series.

The collision check covers all IDs represented by the storage `idRegistry`, including:

- Work IDs;
- chapter IDs;
- episode IDs;
- line IDs;
- scene IDs;
- character IDs;
- image IDs;
- custom-field IDs.

For replacement of an existing matching Series, collisions against records already owned by that same Series are allowed because those records are replaced in the same transaction.

## 6. Archive read and validation flow

`series-archive.js` gains an import path in addition to the existing export path.

Recommended public API:

```js
importSeriesArchive(file)
importSeriesArchiveRead(readResult)
```

The import path performs the following steps in order:

1. Read the outer ZIP with `NovelArchiveCommon.readArchive()`.
2. Validate `manifest.json` exists and is valid JSON.
3. Require `format === "fumizukue-series-archive"`.
4. Require `formatVersion === 1`.
5. Validate `series.id`, `series.title`, and `series.summary`.
6. Require a non-empty `works` array.
7. Require unique Work IDs while preserving manifest order.
8. Require unique paths and canonical paths in exact sequence: `works/0001.zip`, `works/0002.zip`, ...; this sequence defines restored Work order.
9. Require every `sha256` to be a lowercase 64-character hex digest.
10. Require `activeWorkId` to match exactly one declared Work.
11. Require the outer ZIP to contain only `manifest.json` plus declared Work ZIP paths.
12. Verify SHA-256 for every nested Work ZIP before parsing it.
13. Parse each nested ZIP with `NovelArchiveCommon.readArchive()`.
14. Validate each nested ZIP through the existing `NovelArchive.importArchiveRead()` path.
15. Require the imported nested Work ID to equal its outer manifest Work ID.
16. Require the imported nested Work title to equal the title declared in the outer manifest.
17. Return a fully validated in-memory restore value containing Series metadata, `activeWorkId`, and validated Work packages.

No IndexedDB write may occur before all steps succeed.

## 7. Storage architecture

### 7.1 Restore inspection and commit APIs

`series-storage.js` gains a read-only restore preflight plus a dedicated atomic restore API. Suggested shapes:

```js
inspectSeriesRestore(db, {
  series,
  activeWorkId,
  works
})

restoreSeries(db, {
  series,
  activeWorkId,
  works
})
```

`inspectSeriesRestore()`:

- performs defensive package/ID validation;
- determines whether the operation is `create` or `replace`;
- identifies the current target-Series Work IDs when replacing;
- checks incoming global IDs against local `idRegistry` ownership;
- rejects collisions owned by another Series;
- performs no writes;
- returns enough information for the UI to decide whether replacement confirmation is needed.

`restoreSeries()` must not trust an earlier inspection as a lock. It repeats all assumptions that can change concurrently inside the write transaction before destructive mutation.

### 7.2 One transaction

The complete restore is committed through one read-write IndexedDB transaction spanning:

- `series`;
- `workspaceMeta`;
- all existing Work-related stores in `BASE_STORE_NAMES`.

The transaction performs:

1. Re-check target Series existence and collision assumptions inside the transaction.
2. If replacing an existing matching Series, delete all rows belonging to its current Works from every Work-related store.
3. Write the restored Series record.
4. Write every restored Work and all child rows, persisting its manifest position as the Work `order`.
5. Rebuild `idRegistry` for restored records.
6. Set `lastActiveWorkId` on the restored Series.
7. Write `workspaceMeta/current` with the restored Series and `activeWorkId`.
8. Commit.

Any request error or validation failure aborts the transaction.

### 7.3 Shared Work-row serialization

The current base `storage.js` Work save path already knows how to turn a validated Work package into rows for all stores, but it owns its transaction.

To support multi-Work restore without duplicating storage semantics, extract or introduce a transaction-local helper that writes one validated Work package into already-open object stores.

The normal existing `saveWork()` behavior must call the same helper after its revision check and store clearing. Series restore calls the helper repeatedly in one larger transaction.

This refactor is in scope because it is necessary to keep one canonical row-writing implementation.

### 7.4 Revision semantics

Restored Works must not reset revision conflict protection in a way that makes stale browser tabs silently overwrite restored content.

For each incoming Work:

- if replacing a Work with the same ID in the target Series, the restored `_revision` must be strictly greater than the local current `_revision`;
- otherwise the Work starts from a valid initial revision greater than zero;
- in-memory revision caches must be invalidated/refreshed after restore so the reloaded page reads the committed revision.

The exact numeric increment can reuse the existing `savedRevision` rules, but tests must prove stale saves are still rejected.

## 8. Collision detection

The storage layer performs two levels of collision protection.

### 8.1 Read-only preflight

Before replacement confirmation, `inspectSeriesRestore()` gathers incoming global IDs and compares them with local `idRegistry` ownership.

Allow an existing ID only when its owner Work currently belongs to the target Series being replaced.

Reject any collision owned by another Series with a clear error before the destructive confirmation is shown.

### 8.2 Transaction-time re-check

Because another tab may modify IndexedDB between preflight and commit, `restoreSeries()` re-checks relevant registry ownership and target-Series membership inside the write transaction.

If assumptions changed, abort with a conflict error rather than partially restoring.

## 9. UI design

### 9.1 Series ZIP open control

Normal full-work mode gains an explicit control labeled:

`シリーズZIPを開く`

This control belongs with Series-level operations, not with the standalone Work ZIP controls in Plot > Series settings.

A dedicated hidden file input accepts `.zip` / `application/zip`.

The existing Work ZIP open/export controls remain available according to their current UI contract. Series ZIP import does not replace the standalone Work ZIP flow.

### 9.2 Import flow

On file selection:

1. Enter the existing Series-operation busy guard.
2. Assert full-work mode.
3. Wait for current editor persistence to become idle.
4. Load and fully validate the Series ZIP.
5. Call `inspectSeriesRestore()` to perform local collision preflight and determine create/replace mode.
6. If replacing, show an explicit confirmation that identifies the Series and explains that all local Works in that Series will be replaced.
7. If cancelled, stop with no write.
8. Call atomic `restoreSeries()`, which re-checks concurrent assumptions inside its transaction.
9. Show success feedback.
10. Reload the page so the restored `activeWorkId` becomes the active editor state.

Archive and cross-Series collision errors are shown before replacement confirmation.

### 9.3 Chapter workspace

While chapter-workspace mode is active:

- Series ZIP import is disabled;
- Series switching remains disabled;
- new Series creation remains disabled;
- Series ZIP export remains disabled;
- the existing master Work ZIP path used to return to full-work mode remains available.

## 10. Error handling

User-visible failures should distinguish these classes where practical:

- unsupported Series ZIP format/version;
- invalid or incomplete outer manifest;
- undeclared/extra ZIP entries;
- nested ZIP checksum mismatch;
- invalid nested Work ZIP;
- outer/nested Work metadata mismatch;
- duplicate Work IDs;
- duplicate/non-canonical Work paths;
- invalid `activeWorkId`;
- ID conflict with another Series;
- concurrent database change / stale assumptions;
- transaction failure / storage quota failure.

No failure after the write transaction starts may leave a partial Series restore.

## 11. Module boundaries

Expected changes:

- `series-archive.js`
  - add Series ZIP read/import validation;
  - reuse `archive-common.js` and existing Work archive import.
- `storage.js`
  - expose or internally reuse a transaction-local validated Work row writer;
  - preserve existing single-Work save behavior.
- `series-storage.js`
  - add `inspectSeriesRestore()` and atomic `restoreSeries()`;
  - manage collision checks, replacement deletion, revisions, Series metadata, and workspace activation.
- `series.js`
  - own Series ZIP import orchestration, preflight, confirmation, busy state, and reload.
- `index.html`
  - add Series ZIP open control/input if needed by the chosen UI placement.
- `series.css` / `styles.css`
  - style the new Series-level import control if needed.
- `sw.js`
  - bump app-shell cache generation when runtime assets/UI change.
- tests
  - extend Series archive, storage, UI, chapter-workspace, and PWA regression coverage.
- `README.md`
  - document Series ZIP restore behavior and replacement semantics.

## 12. IndexedDB migration

No database version bump is required.

The feature uses existing stores and indexes. `inspectSeriesRestore()` and `restoreSeries()` operate on the current schema.

## 13. Security and integrity constraints

Series archive import is treated as untrusted external input.

The implementation must retain existing ZIP protections from `archive-common.js`, including archive structure and uncompressed-size limits. Nested Work ZIPs must pass the same Work archive validation used for standalone Work ZIP import.

The outer Series importer must not trust titles, IDs, paths, hashes, or nested content solely because they appear in `manifest.json`.

## 14. Test strategy

Tests are written first for each behavior.

### Series archive tests

- valid multi-Work Series ZIP imports and returns validated packages;
- manifest Work order is preserved and canonical `works/NNNN.zip` paths are enforced;
- checksum tampering is rejected;
- nested invalid Work ZIP is rejected;
- nested Work ID mismatch is rejected;
- nested Work title mismatch is rejected;
- duplicate Work IDs and duplicate paths are rejected;
- missing/extra outer entries are rejected;
- invalid or foreign `activeWorkId` is rejected;
- unsupported format/version is rejected.

### Storage tests

- restore inspection reports create vs replace without writing;
- inspection rejects another Series' Work/global ID before confirmation;
- restore of a new Series writes all Works and activates `activeWorkId`;
- replacement of an existing matching Series deletes only that Series' old Works;
- unrelated Series remain record-equivalent;
- collision with another Series' Work ID is rejected;
- collision with another Series' child/global ID is rejected;
- same-Series IDs are allowed during replacement;
- injected failure midway through restore rolls back every change;
- restored Series has correct `lastActiveWorkId`;
- replacement advances Work revisions;
- stale saves against pre-restore revisions are rejected;
- concurrent collision changes after inspection are detected inside the transaction.

### UI tests

- normal mode exposes `シリーズZIPを開く`;
- valid new-Series restore proceeds without replacement confirmation;
- existing-Series restore requires explicit confirmation;
- cross-Series collision is reported before replacement confirmation;
- cancellation makes no restore call;
- successful restore reloads into the manifest `activeWorkId`;
- chapter workspace disables Series ZIP restore while preserving the master Work ZIP exit path.

### Regression tests

- standalone Work ZIP export/import remains unchanged;
- Series ZIP export remains unchanged;
- chapter ZIP export/import remains unchanged;
- existing Series switching and last-active-Work restoration remain unchanged;
- service worker precaches all required runtime assets and receives a new cache generation.

## 15. Acceptance criteria

The feature is complete when all of the following are true:

1. A Series ZIP exported by the current app can be restored into an app with no matching Series.
2. All Works and their nested records/images are restored with original IDs.
3. The archive's `activeWorkId` is active after successful restore.
4. Restoring a Series whose ID already exists requires explicit replacement confirmation.
5. Cross-Series ID collisions are rejected before that replacement confirmation.
6. Replacement changes only that Series and leaves all other Series untouched.
7. Any invalid outer/nested archive or checksum rejects the restore before IndexedDB mutation.
8. Any write failure or concurrent collision rolls back the entire restore.
9. Existing Work ZIP and chapter ZIP formats and workflows remain compatible.
10. Chapter-workspace restrictions remain intact and the master Work ZIP exit path still works.
11. No destructive IndexedDB migration or version bump is introduced.
12. All repository tests and syntax checks pass on the feature branch, PR CI, and `main` after merge.
13. GitHub Pages deployment succeeds after merge.

## 16. Rollout plan

Implementation follows TDD in this order:

1. Series archive read/validation tests and implementation.
2. Transaction-local Work row writer refactor with existing storage regressions green.
3. Restore inspection plus atomic Series restore and collision/revision tests.
4. Series ZIP import UI and replacement confirmation.
5. Chapter-workspace and PWA integration.
6. README and compatibility regression pass.
7. Integrate latest `main` if needed.
8. PR review and CI.
9. Merge to `main` only after all gates pass.
10. Verify post-merge CI and GitHub Pages deployment.
