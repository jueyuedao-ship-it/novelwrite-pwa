# Chapter Workspace Phase 1 Plan Clarifications

This file is an authoritative companion to `2026-10-09-chapter-workspace-phase1.md` and resolves interface ambiguities found during self-review. If wording conflicts, this file wins.

## 1. Single-read full-work ZIP adapter

Task 2 must additionally expose:

```js
NovelArchive.importArchiveRead(readResult) -> Promise<{ work, images }>
```

`NovelArchive.importArchive(file)` remains public and backward-compatible, implemented as `NovelArchiveCommon.readArchive(file)` followed by `importArchiveRead(readResult)`.

Task 4 ZIP dispatch therefore reads/inflates once:

```js
const read = await NovelArchiveCommon.readArchive(file);
if (read.manifest.format === 'fumizukue-work-archive') {
  value = await NovelArchive.importArchiveRead(read);
} else if (read.manifest.format === 'fumizukue-chapter-archive') {
  value = await NovelChapterArchive.importChapterArchiveRead(read);
} else {
  throw new Error('対応していないZIP形式です。');
}
```

No ZIP import path may call `readArchive()` twice for the same user operation.

## 2. Mutation policy requires current state

Replace the Task 3/4 signature with:

```js
NovelWorkspaceMode.assertPatchAllowed(workspaceMeta, patch, currentState) -> void
```

The current state is required to resolve `patch.images.deleteIds` back to existing image owners. In chapter mode:

- character-owned image upsert/delete: reject;
- scene-owned image upsert/delete for a scene in the loaded chapter: allow;
- work or character mutation: reject;
- chapter/episode/scene mutation outside `loadedChapterIds`: reject.

`app.js` must call it from `commitWorkspace` before applying or queuing the patch.

## 3. Base revision source

Task 3 must also expose:

```js
NovelStorage.loadWorkRevision(store) -> Promise<number>
```

It returns the current persisted `_revision` from the single `works` row, normalized to a non-negative safe integer. Task 4 passes this value as `baseRevision` to `exportChapterArchive`. `baseChapterHash` remains the authoritative conflict baseline; `baseRevision` is advisory chronology only.

## 4. Lazy module load order

Chapter/archive implementation modules remain lazy. Do not add ZIP codecs to the eager page startup solely for dependency ordering.

Task 4 should implement one loader that imports in this order when ZIP work is requested:

1. `archive-common.js`
2. `chapter-bundle.js`
3. `archive.js`
4. `chapter-archive.js`

It then verifies `window.NovelArchiveCommon`, `window.NovelChapterBundle`, `window.NovelArchive`, and `window.NovelChapterArchive` exist. `workspace-mode.js` is the only new Phase 1 module that must be eager-loaded before `app.js`, because autosave/commit policy uses it during normal editing.

## 5. Phase 1 self-review result

Spec coverage is complete for Phase 1 after these clarifications. The later spec phases deliberately remain separate implementation plans:

- Phase 2: reintegration/conflict handling.
- Phase 3: multi-chapter workspace.
- Phase 4: full-work ZIP v2.
- Phase 5: selective entry inflation.

The Phase 1 archive contract already records `baseChapterHash` and `baseRevision` so Phase 2 can be added without changing chapter archive format version 1.