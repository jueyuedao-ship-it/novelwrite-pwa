# Series Archive and Series Switching Design

Status: Proposed
Date: 2026-10-10

## 1. Purpose

文机の最上位操作単位を「作品」ではなく「シリーズ」に揃える。

現在のアプリは IndexedDB 上で `Series -> Work` の階層を持ち、プロット画面内で同一シリーズの作品を切り替えられる。一方、上部ツールバーには従来の単一作品モデル由来の「作品を開く」「ZIPで保存」「新しい作品」が残っており、ユーザーが操作する階層と保存モデルが一致していない。

この変更では次を実現する。

1. 上部の切替操作を「シリーズを切り替える」にする。
2. 上部のバックアップ操作を「シリーズZIPで保存」にし、現在のシリーズに属する全作品を1つのZIPへ保存する。
3. 上部の新規作成を「新しいシリーズ」にする。
4. シリーズ内の作品追加・作品切替・作品削除は、引き続きプロット画面内の「シリーズ設定」で行う。
5. 既存の作品ZIP形式は変更せず、互換機能として残す。

## 2. Non-goals

今回の実装範囲には以下を含めない。

- シリーズZIPからのインポート・復元
- シリーズ間での作品移動
- シリーズ削除
- Seriesをまたいだ共有キャラクター、共有舞台、共有タイムライン
- 既存の作品ZIPフォーマット `fumizukue-work-archive` の変更
- 章ZIPフォーマットの変更
- IndexedDBの全データ再構成

シリーズZIPの読み込みは、書き出し形式と実運用が安定した後の別変更として扱う。

## 3. Current State

現在の保存層には以下が既に存在する。

- `series` object store
- `works.seriesId`
- `workspaceMeta/current` の `activeSeriesId` / `activeWorkId`
- `NovelStorage.listSeries()`
- `NovelStorage.getSeries()`
- `NovelStorage.createSeries()`
- `NovelStorage.listWorks()`
- `NovelStorage.createWorkInSeries()`
- `NovelStorage.setActiveWorkspace()`

したがって複数Seriesを保持するための新しいobject storeは不要である。

現在のUIでは、プロット画面内のシリーズ設定から同一Series内のWorkを選択できる。上部の「作品を開く」は外部の作品ZIP/旧JSONを現在のWorkへ置き換える用途であり、「ZIPで保存」は現在のWorkのみを書き出す。

## 4. UX Model

### 4.1 Top bar

上部ツールバーを次の責務へ変更する。

| Current | New | Responsibility |
| --- | --- | --- |
| 作品を開く | シリーズを切り替える | 端末内に保存済みのSeriesを選択する |
| ZIPで保存 | シリーズZIPで保存 | active Series配下の全Workをバックアップする |
| 新しい作品 | 新しいシリーズ | 新規Seriesと最初の空Workを作成する |

「章ZIPを開く」は既存の章ワークスペース機能として維持する。

### 4.2 Plot > Series settings

プロット画面内のシリーズ設定は、Series内部を管理する場所として維持する。

- シリーズ名
- シリーズ概要
- シリーズ内の作品一覧
- `＋ 新しい作品`
- 各作品の `開く`
- 各作品の `削除`
- `作品ZIPを開く`

既存の外部作品ZIP/旧JSON読込は、上部からここへ移動する。読み込んだ作品は現在のSeriesのactive Workを置き換える既存挙動を維持する。

### 4.3 Series switch dialog

「シリーズを切り替える」を押すと、端末内のSeries一覧をダイアログで表示する。

各行には以下を表示する。

- Series title
- Work count
- active Series badge または `開く` ボタン

ダイアログ下部に `＋ 新しいシリーズ` を置いてもよいが、上部ツールバーの同操作と同じ関数を呼ぶだけとする。

章ワークスペース中はSeries切替、新規Series作成、作品ZIP置換を禁止する。既存のfull-work mode guardを再利用する。

## 5. Remembering the Last Work per Series

Seriesを切り替えたとき、そのSeriesで最後に開いていたWorkへ戻れるようにする。

`Series` レコードへ任意フィールドを追加する。

```text
Series
  id
  title
  summary
  lastActiveWorkId?   // optional
  createdAt
  updatedAt
```

IndexedDBのkeyPathやindexは変更しないため、DB version bumpは不要である。

### Rules

- Series内でWorkを開いたら、そのSeriesの `lastActiveWorkId` を更新する。
- 別Seriesへ切り替える直前にも現在の `activeWorkId` を現在Seriesへ記録する。
- Series切替時は、`lastActiveWorkId` がそのSeriesに現在も属していればそのWorkを開く。
- 無効・欠損・削除済みなら、そのSeriesの先頭Workへフォールバックする。
- Seriesには最低1 Workを保持する。既存の「最後の1作品は削除不可」を維持する。

保存層には `setActiveSeries(db, seriesId)` 相当のAPIを追加し、Work解決と `workspaceMeta/current` 更新を1つの責務にまとめる。

## 6. Creating a New Series

上部の「新しいシリーズ」は以下を原子的なユーザー操作として扱う。

1. 現在のWorkのpending save完了を待つ。
2. full-work modeであることを確認する。
3. 新しい `Series` を作成する。
4. `NovelModel.createWork()` で空Workを1つ作成する。
5. `createWorkInSeries()` でSeriesへ保存する。
6. Seriesの `lastActiveWorkId` と `workspaceMeta/current` を新Workへ設定する。
7. ページをreloadして新Seriesを表示する。

途中で失敗した場合、可能な限り孤立Seriesを残さない。保存層にSeries+初期Workをまとめた `createSeriesWithInitialWork()` を追加するか、失敗時に作成済みSeriesをロールバックする。

実装計画時に、IndexedDB transactionで一括化できる範囲を優先する。

## 7. Series ZIP Format

### 7.1 Format identity

新しいアーカイブ形式を追加する。

```text
format: fumizukue-series-archive
formatVersion: 1
```

既存作品ZIPは変更しない。

```text
fumizukue-work-archive v1
```

### 7.2 Archive layout

```text
<series-name>.zip
├─ manifest.json
└─ works/
   ├─ 0001.zip
   ├─ 0002.zip
   └─ 0003.zip
```

各 `works/*.zip` は既存 `NovelArchive.exportArchive()` が生成する `fumizukue-work-archive v1` をそのまま格納する。

これによりSeries ZIPは作品ZIPのラッパーとなり、WorkレベルのZIP仕様を重複実装しない。

### 7.3 manifest.json

概念構造:

```json
{
  "format": "fumizukue-series-archive",
  "formatVersion": 1,
  "series": {
    "id": "series-...",
    "title": "シリーズ名",
    "summary": "概要"
  },
  "activeWorkId": "work-...",
  "works": [
    {
      "id": "work-...",
      "title": "第一作",
      "path": "works/0001.zip",
      "sha256": "..."
    }
  ]
}
```

`lastActiveWorkId` は端末ローカルの操作状態として扱い、アーカイブ上は `activeWorkId` として保存する。将来Series ZIP importを追加する際、そのSeriesの初期active Work候補として使用できる。

### 7.4 Ordering

作品ZIPの格納順は、現状 `Work` にSeries内orderフィールドがないため、安定した決定順を使う。

優先順位:

1. `works` object store / `listWorks()` から得る既存順を明示的に安定化
2. titleではなくWork ID等の不変値をtie-breakerに使用

ただしユーザーが明示的に作品順を並べ替える機能は今回導入しない。

### 7.5 Export flow

Series ZIP保存は以下の順序で行う。

1. 入力composition・画像load・pending saveが完了するまで待つ。
2. active Seriesと配下Work一覧を取得する。
3. 各Workを `NovelStorage.loadWork(db, workId)` で完全ロードする。
4. 各Workを既存 `NovelArchive.exportArchive()` で作品ZIP化する。
5. 各作品ZIPのSHA-256を計算する。
6. `manifest.json` を生成する。
7. `archive-common.js` のZIP writerでSeries ZIPを作成する。
8. `<series title>.fumizukue-series.zip` に相当する識別しやすい名前でdownloadする。

ファイル拡張子は既存ブラウザ互換を優先し `.zip` とし、ファイル名中に `series` を含める。

例:

```text
星海シリーズ.series.zip
```

## 8. Archive Safety

Series ZIPでも既存ZIPと同等の安全制約を適用する。

- 各nested work ZIPのbytesを生成後、Series ZIP全体のuncompressed budgetを確認する。
- path traversalを許さない固定パスのみ生成する。
- duplicate entry namesを許さない。
- `manifest.json` のWork ID重複を許さない。
- Work ZIPのhashをmanifestへ記録する。
- 作品ZIP生成時の既存画像サイズ・形式・checksum検証をそのまま再利用する。

Series ZIP importは今回実装しないため、読み込み側のpreflightは次フェーズで設計する。

## 9. Module Boundaries

### New

`series-archive.js`

Responsibilities:

- `exportSeriesArchive({ series, works })`
- existing `NovelArchive.exportArchive()` composition
- Series manifest generation
- SHA-256 generation through `NovelArchiveCommon`
- outer ZIP assembly

Series archive moduleは遅延ロードする。通常編集時にZIP codecを追加ロードしない。

### Existing files

`series-storage.js`

- `lastActiveWorkId` handling
- `setActiveSeries()`
- atomic or rollback-safe Series + initial Work creation helper
- existing multi-Work semantics remain unchanged

`series.js`

- Series switch dialog population / selection
- new Series action integration if UI ownership is placed here
- Work switch updates `lastActiveWorkId`
- Plot内 `作品ZIPを開く` integration

`app.js`

- topbar button behavior changes
- Series ZIP export orchestration
- current Work pending-save flush before series-level operations
- existing Work ZIP import handler exposed/reused by Plot Series UI rather than removed

`index.html`

- labels and controls
- Series switch dialog container if existing generic dialog is insufficient
- Plot Series settings `作品ZIPを開く`

`series.css` / `styles.css`

- Series chooser styling

`sw.js`

- cache generation bump
- precache `series-archive.js` only if required by current app-shell policy; otherwise dynamic import remains network/cache managed consistently with `archive.js`

## 10. API Direction

Storage APIs should evolve toward:

```text
listSeries(db)
getSeries(db, seriesId)
createSeries(db, values)
listWorks(db, seriesId)
setActiveWorkspace(db, seriesId, workId)
setActiveSeries(db, seriesId)
createSeriesWithInitialWork(db, seriesValues, rawWorkPackage)
```

`setActiveSeries()` returns the resolved workspace metadata:

```text
{
  id: "current",
  activeSeriesId,
  activeWorkId
}
```

`setActiveWorkspace()` should also update `Series.lastActiveWorkId` for the targetSeries, so callers cannot accidentally create inconsistent state.

## 11. Existing Work ZIP Compatibility

Existing `NovelArchive.exportArchive()` / `importArchive()` remain valid and tested.

After this change:

- topbar primary export = Series ZIP
- Plot > Series settings = `作品ZIPを開く`
- existing Work ZIP import still replaces only the active Work within the active Series
- existing Work ZIP schema does not gain `seriesId`
- Series association remains a local container concern, not embedded into standalone Work ZIP

This separation allows a Work ZIP to be moved into another Series without rewriting the archive format.

## 12. Chapter Workspace Interaction

Chapter workspace remains scoped to one Work.

While chapter-workspace metadata is active:

- Series switch: disabled
- New Series: disabled
- Work switch: disabled
- New Work: disabled
- Work ZIP import: disabled
- Series metadata editing: read-only
- Series ZIP export: allowed only if all Series Work data can be read safely without mutating workspace state; otherwise disabled for Phase 1 implementation

Implementation should prefer disabling Series ZIP export during chapter-workspace mode unless tests demonstrate that loading sibling Work packages has no side effects. This is safer than exporting a potentially stale or partial active Work.

## 13. Failure Handling

### Series switching

- current save failure -> do not switch
- target Series missing -> show error and keep current Series
- target Series has no Work -> reject or repair before UI switch
- remembered Work missing -> fallback to first valid Work

### Series ZIP export

- any Work fails full load -> abort entire export
- any nested Work ZIP generation fails -> abort entire export
- checksum failure/impossible payload -> abort entire export
- no partial ZIP download

### New Series

- initial Work creation fails -> do not activate new Series
- avoid leaving a zero-Work Series

## 14. Migration and Backward Compatibility

No mandatory IndexedDB version bump is required because:

- `series` store already exists
- `Series.lastActiveWorkId` is an optional property
- `works.seriesId` already exists
- `workspaceMeta/current` already carries active Series and Work

On first use after upgrade:

- if `lastActiveWorkId` is absent, use current `activeWorkId` when it belongs to the Series
- otherwise use first Work
- persist `lastActiveWorkId` lazily when a Work or Series is next selected

Existing v4/v5/v6 migrations remain unchanged.

## 15. Tests

### Storage

- multiple Series coexist
- `setActiveSeries()` switches to target Series
- `setActiveSeries()` restores `lastActiveWorkId`
- missing `lastActiveWorkId` falls back to a valid Work
- deleting remembered Work does not break later Series switch
- `setActiveWorkspace()` updates target Series memory
- new Series always receives one initial Work
- failure during initial Work creation does not leave unusable active state

### Series archive

- two-Work Series exports one outer ZIP containing two valid existing Work ZIPs
- manifest format/version/Series metadata is correct
- each nested ZIP hash matches manifest
- Work IDs are unique
- missing image/blob in any Work aborts entire export
- uncompressed budget covers nested ZIP payloads
- existing Work ZIP round-trip tests remain unchanged

### UI

- topbar no longer says `作品を開く`
- topbar contains `シリーズを切り替える`
- topbar primary export says `シリーズZIPで保存`
- topbar reset says `新しいシリーズ`
- Plot Series settings contains `作品ZIPを開く`
- Series chooser lists all stored Series and Work counts
- switching Series preserves Series-internal last Work
- chapter workspace blocks Series switching/new Series

### Regression

- current Work autosave
- Work ZIP import
- chapter ZIP export/import
- v4 -> v6 migration
- v5 -> v6 chapter workspace migration
- multi-Work isolation
- Work revision conflict detection
- PWA cache/update tests

## 16. Acceptance Criteria

The change is complete when all of the following are true.

1. User can keep at least two Series in IndexedDB and switch between them from the top bar.
2. Returning to a Series reopens the Work most recently used in that Series when still valid.
3. User can create a new Series from the top bar; it immediately contains one editable blank Work.
4. User can save the active Series as one ZIP containing every Work in that Series.
5. Each nested Work archive is byte-valid according to the existing Work archive implementation.
6. Current Work ZIP import remains available from Plot > Series settings.
7. Series-internal Work switching remains in Plot > Series settings.
8. Existing Work ZIP and chapter ZIP formats are unchanged.
9. Existing user databases require no destructive migration.
10. Full automated regression suite and syntax checks pass before merge.

## 17. Rollout

Implementation will be developed on a feature branch from current `main` using TDD.

Release sequence:

1. storage behavior tests RED/GREEN
2. Series archive tests RED/GREEN
3. UI contract tests RED/GREEN
4. full regression suite
5. latest-main integration
6. PR CI
7. merge to `main`
8. post-merge CI and GitHub Pages deployment verification

No direct write to `main` before the release gate.