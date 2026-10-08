# Chapter Workspace Archive Design

Date: 2026-10-09
Status: Proposed
Repository: `jueyuedao-ship-it/novelwrite-pwa`

## 1. Purpose

Long works should remain practical to edit on low-resource devices without requiring the entire work package to be loaded or carried around for every editing session.

The system will introduce a chapter-oriented archive and workspace model with these goals:

- Export one chapter as a dedicated ZIP work pack.
- Open and edit that chapter independently in a lightweight workspace.
- Keep enough work-level metadata to preserve context without loading every chapter body.
- Add other chapter packs into the same workspace when needed.
- Reintegrate an edited chapter into its source work with conflict detection.
- Eventually let a full-work ZIP use the same chapter-bundle format internally, so a full archive can expose individual chapters without loading every chapter payload.

The primary mental model is **master work + chapter work packs**. A chapter archive is not an independent work and must retain its relationship to the source work.

## 2. Current Architecture and Fit

The existing application already separates persistence into IndexedDB stores including `works`, `chapters`, `episodes`, `episodeBodies`, `scenes`, `characters`, `images`, and `imageBlobs`. `loadWorkIndex()` reads work/chapter/episode metadata and characters without loading every episode body, while `loadEpisode()` hydrates an individual episode on demand.

That means the application is already partially lazy-loaded at runtime. Chapter workspaces extend this design rather than replacing it.

The main benefits of chapter archives are expected to be:

- Smaller portable archives.
- Lower temporary memory pressure during ZIP import/export.
- Less image data present on low-capacity devices.
- Easier transfer of only the section currently being edited.
- A clear path toward selectively opening chapters from very large works.

## 3. Terminology

### Master Work

The canonical complete work containing all chapters and shared data.

### Chapter Bundle

The normalized representation of one chapter and its chapter-owned data. The same logical structure should eventually be used both by chapter-only archives and full-work archives.

### Chapter Work Pack

A ZIP file containing exactly one editable Chapter Bundle plus a read-only snapshot of the shared data required to understand and render it.

### Chapter Workspace

A runtime mode where only one or more selected Chapter Bundles are loaded locally. Shared data is initially read-only.

### Shared Data

Work-level data that may be referenced by multiple chapters and therefore cannot safely be edited independently in multiple chapter work packs. Initial scope includes:

- Work title and summary.
- Detailed work overview/settings when that feature is moved into the archive contract.
- Character records and character images.
- Any future global setting that may be referenced by multiple chapters.

## 4. Design Principles

1. **Stable IDs are authoritative.** Existing work, chapter, episode, line, scene, character, and image IDs are retained across export/import.
2. **Chapter-owned data is editable.** Chapter metadata, episodes, episode bodies, chapter/episode scenes, and scene-owned images may be modified in chapter mode.
3. **Shared data is read-only in v1 chapter mode.** This avoids conflicting edits to the same character or work settings from independent chapter packs.
4. **Every work pack records its source baseline.** Reintegration must be able to determine whether the master chapter changed after export.
5. **Archive validation remains strict.** Chapter archives use checksums and explicit file allow-lists similar to the current full archive format.
6. **Chapter packs never masquerade as full-work archives.** They use a distinct format identifier and import route.
7. **The workspace should show unloaded context.** Users should still see the position and names of unloaded chapters through a lightweight catalog.
8. **Full-work v1 compatibility is preserved during rollout.** Existing `fumizukue-work-archive` files continue to import.

## 5. Chapter Work Pack Format v1

Recommended format identifier:

`fumizukue-chapter-archive`

Recommended ZIP layout:

```text
manifest.json
work-ref.json
catalog.json
chapter/
  chapter.json
  episodes.json
  scenes.json
refs/
  characters.json
  shared.json
images/
  scene/
    ...
  character/
    ...
```

### 5.1 `manifest.json`

Required fields:

```json
{
  "format": "fumizukue-chapter-archive",
  "formatVersion": 1,
  "schemaVersion": 4,
  "sourceWorkId": "work-...",
  "chapterId": "chapter-...",
  "baseRevision": 12,
  "baseChapterHash": "sha256...",
  "exportedAt": "2026-10-09T00:00:00.000Z",
  "hashes": {},
  "images": []
}
```

`sourceWorkId`, `chapterId`, and `baseChapterHash` are required to identify the original source and detect master-side modifications.

`baseRevision` is advisory for whole-work chronology. Conflict decisions are based primarily on the chapter baseline hash because unrelated changes elsewhere in the work must not block a chapter merge.

### 5.2 `work-ref.json`

Contains only lightweight source-work identity and display information:

```json
{
  "id": "work-...",
  "title": "作品名",
  "summary": "作品概要"
}
```

The work ID must remain the source master work ID. A chapter pack must not generate a replacement work ID.

### 5.3 `catalog.json`

Contains lightweight metadata for all chapters in the master work so chapter mode can display unloaded context.

Recommended per-chapter fields:

```json
{
  "id": "chapter-...",
  "title": "第3章 崩壊",
  "order": 2,
  "episodeCount": 5,
  "characterCountEstimate": 8,
  "textLength": 42150,
  "loaded": false
}
```

`loaded` is not trusted archive state and may be recomputed by the importer. It exists only as optional UI-oriented metadata.

`catalog.json` must not contain full episode bodies or chapter image payloads.

### 5.4 `chapter/chapter.json`

Contains the selected chapter record only.

### 5.5 `chapter/episodes.json`

Contains every episode in the selected chapter, including its lines. Version 1 keeps chapter packs simple by storing the complete selected chapter body inside the pack.

A later format may split episode metadata and episode bodies further if individual episode extraction becomes necessary.

### 5.6 `chapter/scenes.json`

Contains:

- Scenes directly scoped to the selected chapter.
- Scenes scoped to episodes belonging to the selected chapter.

Unassigned scenes are excluded.

### 5.7 `refs/characters.json`

Contains snapshots of characters referenced by:

- `line.characterId` in the selected chapter.
- `scene.characterIds` in the selected chapter.

These records are read-only in chapter mode v1.

Character records retain their original IDs.

### 5.8 `refs/shared.json`

Contains a read-only snapshot of work-level shared settings needed by the chapter editor.

Version 1 should at minimum support:

- Work title.
- Work summary.

When the detailed story overview currently maintained outside the core work package is migrated into the archive contract, it should be represented here or in a dedicated shared file and remain read-only in chapter mode.

### 5.9 Images

Scene-owned images referenced by selected chapter scenes are editable chapter-owned assets and are included under `images/scene/`.

Character images for included reference characters may be included under `images/character/` as read-only reference assets.

The manifest image table records ID, owner type, MIME type, path, and SHA-256.

## 6. Canonical Chapter Hash

`baseChapterHash` must be reproducible from logical chapter-owned content, not from ZIP byte layout or timestamps.

Recommended canonical hash input:

1. Selected chapter record.
2. Ordered episodes with lines.
3. Ordered chapter and episode scenes.
4. Scene-owned image metadata.
5. SHA-256 values of scene-owned image blobs.

Shared characters, character images, catalog metadata, export timestamp, and work summary are excluded from `baseChapterHash` because shared data is not editable in chapter mode v1.

Canonical JSON serialization must define stable field order and array order before hashing.

## 7. Chapter Workspace Runtime Model

The application gains a workspace mode:

- `full-work`
- `chapter-workspace`

Recommended runtime metadata:

```js
{
  mode: 'chapter-workspace',
  sourceWorkId,
  loadedChapterIds: [],
  catalog: [],
  baselines: {
    [chapterId]: { baseChapterHash, exportedAt }
  },
  sharedReadOnly: true
}
```

### 7.1 Startup

When a chapter pack is opened:

1. Validate archive structure, limits, checksums, IDs, and references.
2. Create or replace the local lightweight workspace after confirmation.
3. Persist source-work identity and catalog metadata.
4. Persist the selected Chapter Bundle.
5. Persist only included shared-reference characters/images.
6. Mark the workspace as `chapter-workspace`.
7. Open the first episode of the selected chapter.

### 7.2 UI

The application should make partial loading explicit.

Example header:

```text
章ワークスペース
「第3章 崩壊」を読み込み中
[章を追加] [全章を読み込む]
```

Sidebar behavior:

- Loaded chapters render normally.
- Unloaded catalog chapters render in a muted state.
- Selecting an unloaded chapter explains that its data is not present and offers `章ZIPを追加` or `全体ZIPから読み込む` when available.

### 7.3 Read-only Shared Screens

In chapter-workspace v1:

- Work summary/settings are visible but disabled for editing.
- Character records are visible but disabled for editing.
- Character image mutation is disabled.
- Chapter/episode plot data and scene-owned images remain editable.

The UI must visually indicate that shared data is a snapshot from the master work.

## 8. Adding and Removing Chapters

### Add Another Chapter Pack

A chapter pack may be added when:

- `sourceWorkId` matches the current workspace.
- The chapter ID is not already loaded, or the user explicitly chooses a replacement/merge flow.
- Archive schema and format versions are supported.

When the same shared character snapshot differs across two packs, v1 keeps the first workspace snapshot and reports that the incoming shared snapshot differs. It must not silently replace shared reference data.

### Remove a Loaded Chapter

Before removal:

1. Detect whether the chapter differs from its baseline.
2. If modified, require export or explicit discard confirmation.
3. Delete only chapter-owned local data.
4. Garbage-collect reference characters/images only when they are no longer required by another loaded chapter.
5. Keep catalog metadata so the removed chapter remains visible as unloaded.

## 9. Reintegration into the Master Work

Chapter reintegration is an explicit operation, not ordinary full-work import.

### 9.1 Identity Checks

The importer verifies:

- `sourceWorkId` matches the open master work.
- `chapterId` exists, unless the user selects a deliberate `import as new chapter` path.
- IDs inside the Chapter Bundle are valid and do not collide outside their expected ownership scope.

### 9.2 Conflict Detection

Compute the current master chapter hash with the same canonical algorithm used at export.

Cases:

#### No master-side chapter changes

`currentMasterChapterHash === baseChapterHash`

The edited chapter can replace chapter-owned records directly.

#### Master chapter also changed

`currentMasterChapterHash !== baseChapterHash`

The application must not silently overwrite.

Initial conflict options:

- Keep master version.
- Use chapter-pack version.
- Import chapter-pack version as a duplicate chapter with newly generated IDs and rewritten internal references.

A future three-way merge may operate at episode/scene/line granularity, but it is out of scope for v1.

### 9.3 Atomicity

Applying an edited Chapter Bundle to a master work must occur as one logical storage transaction so partial replacement cannot leave broken references.

Before mutation, validate the resulting master work/package against model invariants.

## 10. Storage Changes

The existing IndexedDB structure can continue to store chapter workspace records. A new small metadata store is recommended instead of encoding workspace mode in unrelated records.

Recommended new store:

`workspaceMeta`

Example record:

```js
{
  id: 'active',
  mode: 'chapter-workspace',
  sourceWorkId,
  catalog,
  loadedChapterIds,
  baselines,
  sharedReadOnly: true
}
```

Database version should increment when this store is introduced.

The current one-work-per-database assumption may remain for the first implementation.

## 11. Archive Module Structure

Avoid expanding `archive.js` into one large mixed-format module.

Recommended direction:

- Keep current full-work v1 import/export behavior compatible.
- Introduce shared ZIP safety/checksum helpers.
- Add a chapter-archive module for Chapter Bundle validation and encoding.
- Add canonical chapter hashing as DOM-free logic suitable for unit testing.

Possible structure:

```text
archive.js                    # existing full-work v1 adapter
chapter-archive.js            # chapter archive v1
archive-common.js             # limits, hashes, ZIP entry helpers
chapter-bundle.js             # build/validate/hash/merge logical bundle
```

Exact file boundaries may be adjusted during implementation, but Chapter Bundle construction and validation should remain separate from UI code.

## 12. Full-work ZIP v2

The long-term full-work format should become a collection of the same Chapter Bundles.

Recommended layout:

```text
manifest.json
work.json
catalog.json
shared/
  characters.json
  settings.json
  images/
    ...
chapters/
  <chapter-id>/
    chapter.json
    episodes.json
    scenes.json
    images/
      ...
```

Conceptually:

- Chapter archive = one Chapter Bundle + shared snapshot.
- Full-work archive v2 = every Chapter Bundle + authoritative shared data.

This unifies validation and chapter loading logic.

## 13. Selective Full-archive Loading

The existing full-work archive importer uses whole-archive synchronous expansion. That is acceptable for the current format but does not provide the desired low-memory behavior for very large v2 archives.

Full-work v2 should therefore be designed so the importer can:

1. Read archive metadata/central directory.
2. Read `manifest.json`, `catalog.json`, and required shared metadata first.
3. Present a chapter selection UI.
4. Inflate only entries for the selected chapters and shared assets they require.

The implementation should avoid requiring all uncompressed chapter data to coexist in memory.

This capability is a later phase and is not required to ship Chapter Work Pack v1.

## 14. Validation and Security

Chapter archive import must retain the existing archive safety posture:

- Maximum ZIP size.
- Maximum per-entry uncompressed size.
- Maximum total uncompressed size.
- Maximum entry count.
- Reject encrypted archives.
- Reject unsupported compression methods.
- Reject ZIP64 if the current parser does not support it.
- Reject duplicate entry names.
- Reject unexpected files.
- Verify SHA-256 for declared JSON and image payloads.
- Validate image bytes and MIME agreement.
- Validate all IDs and references before persistence.

Chapter archives must never be accepted by the full-work replacement import path solely because they contain superficially similar JSON files.

## 15. Backward Compatibility

- Existing full-work ZIP v1 export remains available during the chapter-workspace rollout.
- Existing full-work ZIP v1 import remains supported.
- Chapter ZIP uses a new format discriminator and cannot replace the current full work through the old import flow.
- Full-work ZIP v2, when introduced, should coexist with v1 import for at least one migration period.

## 16. Failure and Recovery Behavior

- Import validation completes before destructive replacement.
- Existing autosave and unsaved-change warnings remain active.
- Chapter removal refuses to discard modified data without explicit confirmation.
- Reintegration conflicts never auto-resolve by last-write-wins.
- If an import/apply transaction fails, the previous valid local workspace remains intact.

## 17. Implementation Phases

### Phase 1 — Chapter Archive + Single Chapter Workspace

- Build Chapter Bundle from a full work.
- Export `fumizukue-chapter-archive` ZIP.
- Import one chapter pack into chapter-workspace mode.
- Add read-only shared data presentation.
- Add catalog display for unloaded chapters.

### Phase 2 — Reintegration

- Canonical chapter hash.
- Master identity checks.
- Safe replace when baseline matches.
- Conflict dialog when both sides changed.
- Duplicate-as-new-chapter fallback.

### Phase 3 — Multi-chapter Workspace

- Add another chapter pack.
- Remove loaded chapter.
- Reference-data garbage collection.
- Shared-snapshot mismatch warnings.

### Phase 4 — Full-work Archive v2

- Reorganize full archive around Chapter Bundles.
- Move authoritative shared data into `shared/`.
- Keep v1 import compatibility.

### Phase 5 — Selective Loading from Full-work v2

- Read catalog before chapter bodies.
- Chapter picker.
- Selective ZIP-entry inflation.
- `全章を読み込む` and incremental load flows.

### Phase 6 — Optional Shared-data Merge

Only after the chapter workflow is stable:

- Editable shared records in partial workspaces.
- Shared baseline hashes.
- `shared-changes.json` or equivalent.
- Explicit shared-data conflict resolution.

## 18. Testing Strategy

Required unit coverage:

- Build a Chapter Bundle from a work with multiple chapters.
- Include only episodes/scenes for the selected chapter.
- Include all referenced characters and required images.
- Exclude unrelated chapter data.
- Stable canonical chapter hash for equivalent logical data.
- Hash changes for editable chapter-owned data changes.
- Hash does not change for unrelated other-chapter changes.
- Chapter archive checksum validation.
- Reject malformed IDs/references and unexpected ZIP entries.
- Reject chapter archive through full-work import route.
- Add a second chapter from the same source work.
- Reject or explicitly route a chapter from a different source work.
- Read-only shared-data enforcement in chapter mode.
- Reintegration with unchanged master baseline.
- Reintegration conflict when master chapter changed.
- Atomic rollback on failed merge validation.

Integration/UI coverage:

- Chapter export action from the chapter UI.
- Opening a chapter pack enters chapter-workspace mode.
- Unloaded catalog chapters are clearly indicated.
- Shared settings and characters are visibly read-only.
- Modified chapter removal requires protection flow.
- Conflict choices behave as labeled.

Regression coverage:

- Existing full-work ZIP v1 round trip still passes.
- Normal full-work IndexedDB boot/edit/autosave remains unchanged.
- Existing lazy episode loading remains functional.

## 19. Non-goals for Initial Release

The first release will not:

- Automatically merge concurrent edits line by line.
- Allow shared character/work-setting edits from chapter mode.
- Synchronize chapter packs over a server.
- Load arbitrary nested ZIPs.
- Replace the existing full-work v1 archive format immediately.
- Guarantee low-memory selective loading from full-work ZIP v1.

## 20. Accepted Product Decisions

The following decisions are approved for the initial design:

- Use a dedicated chapter ZIP format.
- Treat chapter ZIPs as work packs tied to a source master, not standalone works.
- Use a lightweight whole-work catalog in chapter mode.
- Keep work-level settings and character data read-only in the first chapter-workspace version.
- Allow chapter-owned manuscript, scenes, and scene images to be edited.
- Detect reintegration conflicts using a canonical chapter baseline hash.
- Evolve toward a full-work ZIP v2 whose internal chapters use the same Chapter Bundle abstraction.
