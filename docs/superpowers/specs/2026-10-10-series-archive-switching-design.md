# Series Archive and Series Switching Design

Status: Proposed
Date: 2026-10-10

## 1. Purpose

文机の最上位操作単位を「作品」から「シリーズ」へ揃える。

現在の保存モデルは `Series -> Work` だが、上部ツールバーには単一作品モデル由来の「作品を開く」「ZIPで保存」「新しい作品」が残っている。本変更では、上部ツールバーをSeries単位の操作へ変更し、Work単位の操作はプロット画面内の「シリーズ設定」へ集約する。

実現する内容:

1. 上部の「作品を開く」を「シリーズを切り替える」に変更する。
2. 上部の「ZIPで保存」を「シリーズZIPで保存」に変更し、active Series配下の全Workを1つのZIPへ保存する。
3. 上部の「新しい作品」を「新しいシリーズ」に変更する。
4. Series内のWork追加・Work切替・Work削除・単体Workファイル操作はプロット画面内に残す。
5. 既存の作品ZIP `fumizukue-work-archive v1` と章ZIPは変更しない。

## 2. Non-goals

今回の実装には以下を含めない。

- シリーズZIPからのインポート・復元
- Series削除
- Series間のWork移動
- WorkのSeries内並べ替え
- Series共有キャラクター・舞台・タイムライン
- 既存作品ZIP形式の変更
- 章ZIP形式の変更
- destructiveなIndexedDB migration

シリーズZIP importは別フェーズとする。

## 3. Current State

現在の保存層には以下がある。

- `series` object store
- `works.seriesId`
- `workspaceMeta/current.activeSeriesId`
- `workspaceMeta/current.activeWorkId`
- `NovelStorage.listSeries()`
- `NovelStorage.getSeries()`
- `NovelStorage.createSeries()`
- `NovelStorage.listWorks()`
- `NovelStorage.createWorkInSeries()`
- `NovelStorage.setActiveWorkspace()`

したがって、複数Seriesを保持するための新しいobject storeは不要。

現在のプロット画面では、同一Series内のWorkを追加・切替・削除できる。上部の「作品を開く」は外部Work ZIP/旧JSONをactive Workへ置換する操作で、「ZIPで保存」はactive Workのみを書き出す。

## 4. UX Model

### 4.1 Top bar

| Current | New | Responsibility |
| --- | --- | --- |
| 作品を開く | シリーズを切り替える | 端末内に保存済みのSeriesを選択 |
| ZIPで保存 | シリーズZIPで保存 | active Series配下の全Workを一括バックアップ |
| 新しい作品 | 新しいシリーズ | 新規Series + 最初の空Workを作成 |

「章ZIPを開く」は既存機能として維持する。

### 4.2 Plot > シリーズ設定

ここをWork単位の管理場所とする。

表示・操作:

- シリーズ名
- シリーズ概要
- シリーズ内の作品一覧
- `＋ 新しい作品`
- 各作品の `開く`
- 各作品の `削除`
- `現在の作品ZIPで保存`
- `作品ZIP / 旧JSONを開く`

これにより、上部をSeries単位へ変更しても既存の単体Work ZIP入出力をUIから失わない。

### 4.3 Series switch dialog

「シリーズを切り替える」で端末内のSeries一覧を表示する。

各行:

- Series title
- Work count
- active Seriesなら `現在のシリーズ`
- 非active Seriesなら `開く`

ダイアログ下部に `＋ 新しいシリーズ` を置いてよい。上部の「新しいシリーズ」と同じ処理を呼ぶ。

章ワークスペース中はSeries切替・新規Series・Work切替・Work追加・Work置換を禁止する。

## 5. Remembering the Last Work per Series

Seriesへ戻ったとき、そのSeriesで最後に開いていたWorkへ復帰する。

`Series` レコードへ任意フィールドを追加する。

```text
Series
  id
  title
  summary
  lastActiveWorkId?
  createdAt
  updatedAt
```

keyPath/index変更はないためDB version bumpは不要。

Rules:

- Series内でWorkを開くたびに、対象Seriesの `lastActiveWorkId` を更新する。
- 別Seriesへ切り替える直前にも現在Seriesのactive Workを記録する。
- `lastActiveWorkId` が対象Seriesにまだ属していればそれを開く。
- 欠損・削除済みなら、対象SeriesのWorkを `id` 昇順に並べた先頭へフォールバックする。
- Seriesには常に最低1 Workを保持する。既存の「最後の1作品は削除不可」を維持する。

保存層に `setActiveSeries(db, seriesId)` を追加し、Work解決・Series memory更新・`workspaceMeta/current` 更新をまとめる。

`setActiveWorkspace(db, seriesId, workId)` もtarget Seriesの `lastActiveWorkId` を同じtransactionで更新する。

## 6. Creating a New Series

新規Series作成は保存層の `createSeriesWithInitialWork()` で原子的に実施する。

```text
createSeriesWithInitialWork(db, seriesValues, rawWorkPackage)
  -> { series, workspaceMeta }
```

処理:

1. `Series` recordを生成する。
2. `NovelModel.createWork()` で作成した空Work packageを検証する。
3. 既存 `baseStorage.saveWork()` の保存transactionをSeries-aware proxyで拡張する。
4. 同一transaction内でSeries record、Work本体、関連stores、`workspaceMeta/current` を保存する。
5. Seriesの `lastActiveWorkId` を初期Work IDに設定する。

Work保存が失敗した場合はtransaction全体をabortし、zero-Work Seriesを残さない。

UI側では操作前に現在Workのpending save完了とfull-work modeを確認する。新規Series作成は既存Seriesを破壊しないため、destructive確認は不要。

## 7. Series ZIP Format

### 7.1 Identity

```text
format: fumizukue-series-archive
formatVersion: 1
```

既存:

```text
fumizukue-work-archive v1
```

は変更しない。

### 7.2 Layout

```text
<series-title>.series.zip
├─ manifest.json
└─ works/
   ├─ 0001.zip
   ├─ 0002.zip
   └─ 0003.zip
```

各 `works/*.zip` は既存 `NovelArchive.exportArchive()` が生成するWork ZIPそのもの。

Series ZIPはWork ZIPのwrapperとし、WorkレベルのJSON/画像仕様を重複実装しない。

### 7.3 manifest.json

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

`lastActiveWorkId` はローカル操作状態なのでarchiveには直接保存せず、`activeWorkId` を将来import時の初期候補として保存する。

### 7.4 Work ordering

Series ZIP内のWork順は **Work IDの昇順** とする。

理由:

- 現行WorkモデルにSeries内orderがない。
- title順はrenameで変化する。
- Work IDなら同一データ集合から毎回同じarchive layoutを生成できる。

UIのSeries内並べ替えは今回導入しない。

### 7.5 Export flow

1. composition・画像load・pending saveの完了を待つ。
2. full-work modeを確認する。
3. active Seriesを取得する。
4. Series配下WorkをID昇順で取得する。
5. 各Workを `NovelStorage.loadWork(db, workId)` で完全ロードする。
6. 各Workを既存 `NovelArchive.exportArchive()` でZIP化する。
7. nested ZIP bytesのSHA-256を計算する。
8. manifestを生成する。
9. `NovelArchiveCommon.assertUncompressedBudget()` でouter archive payloadを検証する。
10. `NovelArchiveCommon.writeArchive()` でSeries ZIPを生成する。
11. `<series title>.series.zip` としてdownloadする。

## 8. Archive Safety

Series ZIPでも既存archive安全制約を利用する。

- nested Work ZIPは既存Work ZIP validator/export pathを通す。
- outer ZIPは固定pathだけを生成する。
- duplicate pathを禁止する。
- manifest内Work ID重複を禁止する。
- 各nested Work ZIP hashをmanifestへ保存する。
- missing image/blobが1件でもあれば全Series exportをabortする。
- outer archiveのuncompressed budgetを検証する。
- partial downloadはしない。

Series ZIP importを実装しないため、外部Series ZIPのpreflight/read pathは今回追加しない。

## 9. Module Boundaries

### New: `series-archive.js`

Responsibilities:

- `exportSeriesArchive({ series, activeWorkId, works })`
- existing `NovelArchive.exportArchive()` composition
- deterministic Work ordering
- manifest generation
- nested ZIP SHA-256
- outer ZIP assembly

ZIP codecは通常編集時にロードせず、Series ZIP操作時にlazy-loadする。

### `series-storage.js`

- `lastActiveWorkId`
- `setActiveSeries()`
- `setActiveWorkspace()` memory update
- `createSeriesWithInitialWork()` atomic creation
- existing multi-Work isolation remains unchanged

### `series.js`

- Series chooser UI
- Series switch
- New Series
- Plot内Work switch/add/delete
- Plot内Work ZIP export/import controls

### `app.js`

- topbar Series controls
- pending-save flush shared helper
- Series ZIP export orchestration entry point
- current Work ZIP import/export handlers reusable from `series.js`

### `index.html`

- topbar labels
- Series switch dialog/container
- Plot Series settingsのWork archive controls

### `series.css` / `styles.css`

- chooser and archive control styling

### `sw.js`

- app-shell cache generation bump
- new runtime asset handling

## 10. Storage API Direction

```text
listSeries(db)
getSeries(db, seriesId)
createSeries(db, values)
listWorks(db, seriesId)
setActiveWorkspace(db, seriesId, workId)
setActiveSeries(db, seriesId)
createSeriesWithInitialWork(db, seriesValues, rawWorkPackage)
```

`setActiveSeries()` returns:

```text
{
  id: "current",
  activeSeriesId,
  activeWorkId
}
```

`setActiveSeries()` must reject a Series with zero valid Works rather than silently activating an invalid workspace.

## 11. Work ZIP Compatibility

既存 `NovelArchive.exportArchive()` / `importArchive()` は変更しない。

After change:

- topbar primary export = Series ZIP
- Plot > Series settings = `現在の作品ZIPで保存`
- Plot > Series settings = `作品ZIP / 旧JSONを開く`
- Work ZIP importはactive Series内のactive Workだけを置換する
- Work ZIPへ`seriesId`は追加しない

Series associationはlocal container concernのままにする。これにより単体Work ZIPを別Seriesへ持ち込める互換性を維持する。

## 12. Chapter Workspace Interaction

章ワークスペース中は以下を固定する。

- Series switch: disabled
- New Series: disabled
- Work switch: disabled
- New Work: disabled
- Work ZIP import: disabled
- Work ZIP export: existing chapter/full-work policyに従う
- Series metadata editing: read-only
- **Series ZIP export: disabled**

Series ZIPはactive Workを含む全Workの完全バックアップを意味するため、部分的なchapter workspace状態からは作成しない。

## 13. Failure Handling

### Series switch

- current save failure -> switchしない
- target Series missing -> current Series維持
- target Series has zero Work -> reject
- remembered Work missing -> target SeriesのWork ID昇順先頭へfallback

### New Series

- Series/initial Work transaction failure -> 何も作成しない
- active workspace更新失敗 -> transaction abort

### Series ZIP

- any Work full-load failure -> export全体abort
- nested Work ZIP failure -> export全体abort
- checksum/hash generation failure -> export全体abort
- budget exceeded -> export全体abort
- no partial download

## 14. Migration and Backward Compatibility

DB version bumpは不要。

理由:

- `series` storeは既存
- `works.seriesId`は既存
- `workspaceMeta/current`は既存
- `lastActiveWorkId`はoptional property

既存Seriesに`lastActiveWorkId`がない場合:

1. current workspaceのactive WorkがそのSeriesに属していれば使用
2. それ以外はWork ID昇順先頭を使用
3. 次回選択時にlazy persist

既存v4/v5/v6 migration codeは変更しない。

## 15. Tests

### Storage

- 2 Series coexist
- `setActiveSeries()` switches Series
- remembered Work restoration
- missing remembered Work fallback
- deleting remembered Work does not break switch
- `setActiveWorkspace()` updates `lastActiveWorkId`
- `createSeriesWithInitialWork()` creates exactly one Series + one Work
- initial Work save failure leaves no Series

### Series archive

- 2 Work Series -> outer ZIP with 2 nested valid Work ZIPs
- Work ID sort is deterministic
- manifest format/version/Series metadata/activeWorkId correct
- nested ZIP hashes match
- duplicate Work IDs rejected
- missing image/blob aborts entire export
- budget overflow rejected
- existing Work ZIP tests unchanged

### UI

- topbar contains `シリーズを切り替える`
- topbar no longer exposes old `作品を開く` behavior
- primary export is `シリーズZIPで保存`
- reset action is `新しいシリーズ`
- Plot contains `現在の作品ZIPで保存`
- Plot contains `作品ZIP / 旧JSONを開く`
- chooser lists every stored Series and Work count
- switch restores last Work
- chapter workspace disables Series-level controls

### Regression

- autosave
- Work ZIP export/import
- chapter ZIP export/import
- v4 -> v6 migration
- v5 -> v6 chapter workspace migration
- multi-Work isolation
- revision conflict detection
- PWA cache/update

## 16. Acceptance Criteria

1. 端末内に2つ以上のSeriesを保持し、上部UIから切り替えられる。
2. Seriesへ戻ると、そのSeriesで最後に開いていた有効なWorkへ戻る。
3. 新しいSeriesを作ると、必ず1つの編集可能な空Workを持つ。
4. active Seriesを1つのZIPとして保存でき、そのSeriesの全Workが含まれる。
5. nested Work ZIPは既存Work ZIP実装で有効な形式である。
6. 単体Work ZIP export/importと旧JSON importをPlotから引き続き利用できる。
7. Series内Work切替はPlotのシリーズ設定に残る。
8. Work ZIP/章ZIP形式は変更されない。
9. destructive migration不要。
10. full regression、syntax checks、PR CI、post-merge CIを通過してから完了とする。

## 17. Rollout

実装はcurrent `main`からfeature branchを作りTDDで行う。

1. storage RED/GREEN
2. Series archive RED/GREEN
3. UI RED/GREEN
4. full regression
5. latest-main integration
6. PR CI
7. merge to `main`
8. post-merge CI
9. GitHub Pages deployment確認

release gate前に`main`へ直接書き込まない。