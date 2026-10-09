# Series Layer Design

Date: 2026-10-09
Status: Proposed
Repository: `jueyuedao-ship-it/novelwrite-pwa`

## 1. Purpose

文机を「1作品だけを保持する執筆アプリ」から、**1つのシリーズ内に複数の作品を保持し、作品を切り替えて執筆できるワークスペース**へ拡張する。

今回の変更は、将来追加する共有キャラクター、シリーズ年表、作品間リンク、シリーズ横断伏線管理の土台を作ることを目的とする。

今回の実装範囲は次に限定する。

- `Series -> Work -> Chapter / Episode / Scene / Character` の階層を成立させる。
- 同一IndexedDB内に複数Workを安全に共存させる。
- シリーズ画面から作品を一覧・作成・切替・削除できるようにする。
- 既存の作品ZIP v1 / schema v4互換を維持する。
- 既存ユーザーの単一作品DBを自動移行する。

共有キャラクター、シリーズ年表、作品間リンク、シリーズZIPは今回のスコープ外とする。

## 2. Current Architecture and Constraints

現在のIndexedDBは `works`, `chapters`, `episodes`, `episodeBodies`, `scenes`, `characters`, `images`, `imageBlobs`, `lineCharacterRefs`, `idRegistry` などのストアで1作品分のデータを保持する。

現状は複数作品を想定していない。

- `loadWorkIndex()` と `loadWork()` は複数の `works` レコードが存在するとエラーにする。
- `saveWork()` は保存時に全ストアを `clear()` してから1作品を書き戻す。
- `workRevisions` はDB単位で1つのrevisionしか追跡しない。
- 起動処理は「現在の作品」という暗黙の単一Workを前提にしている。

一方、章・話・シーン・人物・画像はすでに `workId` を持っているため、子データの多くは複数Work共存へ拡張しやすい。

## 3. Design Principles

1. **Work schemaを壊さない。** 既存の作品ZIPと `NovelPackage` のschema v4は変更しない。
2. **Seriesはワークスペースメタデータとして扱う。** 作品ファイル内部へSeries情報を強制的に埋め込まない。
3. **Work間のデータ隔離を維持する。** 保存・読込・削除は必ず `workId` を境界にする。
4. **既存IDを保持する。** 作品をSeriesへ移行してもWork/Chapter/Episode等の既存IDを書き換えない。
5. **競合検出をWork単位にする。** A作品を編集してもB作品のrevision変化によって競合扱いにならない。
6. **旧DBは自動移行する。** ユーザー操作なしで既存WorkをSeries配下に置く。
7. **作品ZIPとシリーズ管理を分離する。** ZIPの「作品を開く」は当面、現在のWorkを置換する既存挙動を維持する。
8. **将来の共有Entityを追加しやすい構造にする。** Series IDをワークスペース側で安定して持つ。

## 4. Proposed Data Model

### 4.1 Series

新規 `series` object storeを追加する。

```text
Series
  id: string
  title: string
  summary: string
  createdAt: string
  updatedAt: string
```

`id` はSeries内で永続的に安定する。

初期実装ではSeriesの並べ替えや複数Series管理UIは必須としない。DB構造としては複数Seriesを保持できるようにするが、UIはまず現在Seriesを中心にする。

### 4.2 WorkspaceMeta

新規 `workspaceMeta` object storeを追加する。

単一レコードを次の形で保持する。

```text
WorkspaceMeta
  id: "current"
  activeSeriesId: string
  activeWorkId: string
```

これは作品データではなく、最後に開いていた場所を復元するためのローカルUI状態である。

### 4.3 Works

既存 `works` レコードへ保存層専用の `seriesId` を追加する。

```text
WorkRecord
  schemaVersion
  id
  seriesId
  title
  summary
  _revision
```

`seriesId` はIndexedDB内部だけの属性とし、既存作品ZIPの `work.json` や `NovelPackage` schemaへは追加しない。

`works` storeに `seriesId` indexを追加する。

### 4.4 Existing Child Records

次の既存レコードは引き続き `workId` を境界として利用する。

- chapters
- episodes
- episodeBodies
- scenes
- characters
- images
- imageBlobs
- lineCharacterRefs
- idRegistry

Series IDをこれらすべてへ重複保存しない。所属Seriesは `workId -> works.seriesId` で解決する。

## 5. IndexedDB Migration

DB versionを現在の4から次バージョンへ上げる。

アップグレード時に以下を行う。

1. `series` storeを作成する。
2. `workspaceMeta` storeを作成する。
3. `works` storeへ `seriesId` indexを追加する。
4. 既存 `works` を列挙する。
5. Series未所属WorkへSeriesを割り当てる。
6. `workspaceMeta/current` を作成する。

### 5.1 Normal v4 Migration

通常の既存ユーザーはWorkが0件または1件である。

Workが1件の場合:

- Series IDは移行時に生成する。
- Series titleはWork titleを初期値とする。
- Series summaryは空文字とする。
- Work recordへ `seriesId` を追加する。
- `activeSeriesId` と `activeWorkId` をその値へ設定する。

Workが0件の場合はアップグレード時点ではSeriesを作らず、通常のboot初期化時に新規Series + 新規Workを原子的に作る。

### 5.2 Unexpected Multiple Works During Migration

旧コードでは複数Workを正常利用できなかったが、何らかの理由で複数Workが存在するDBも破壊しない。

その場合は全Workを削除せず、**1つの移行Seriesへまとめて所属**させる。

- Series title: `移行されたシリーズ`
- activeWorkId: 先頭のWork

これにより異常状態でもデータロスを避ける。

## 6. Revision and Concurrency Model

現在の `workRevisions` はDBごとに1 revisionを保持するため、複数Workでは不適切である。

次の形へ変更する。

```text
WeakMap<IDBDatabase, Map<workId, revision>>
```

または同等のWork単位revision管理を採用する。

### Rules

- `loadWorkIndex(workId)` / `loadWork(workId)` 実行時に、そのWorkの現在revisionをキャッシュする。
- `saveChanges()` は `changes.workId` に対応するrevisionだけを比較する。
- `saveWork(workId)` も対象Workだけのrevisionを更新する。
- 別Workの保存は現在Workのexpected revisionへ影響しない。

これにより複数タブ競合検出の意味を維持したまま、Work間の誤検出を防ぐ。

## 7. Storage API Changes

### 7.1 New APIs

```text
listSeries(store)
getSeries(store, seriesId)
createSeries(store, values)
updateSeries(store, seriesId, changes)

listWorks(store, seriesId)
createWorkInSeries(store, seriesId, rawPackage?)
deleteWork(store, workId)

getWorkspaceMeta(store)
setActiveWorkspace(store, seriesId, workId)
```

UIからIndexedDBを直接操作せず、Series操作はStorage APIを通す。

### 7.2 `loadWorkIndex`

変更前:

```text
loadWorkIndex(store)
```

変更後:

```text
loadWorkIndex(store, workId)
```

`workId` は必須とする。

読み込む章・話・人物はすべて対象Workに限定する。

### 7.3 `loadWork`

変更前:

```text
loadWork(store)
```

変更後:

```text
loadWork(store, workId)
```

ZIP保存などで現在Workの完全Packageを構築するときに使用する。

すべての補助ストアについて、対象 `workId` 以外の行を孤立データ判定へ含めない。

### 7.4 `saveWork`

`saveWork()` は全ストア `clear()` を廃止する。

対象Workを置換するときは、同一トランザクション内で以下を行う。

1. 対象 `workId` の既存子レコードを取得・削除する。
2. 対象Workの `works` recordを更新する。
3. 新Packageの子レコードを書き込む。
4. 他Workのレコードには触れない。
5. Workの `seriesId` は既存所属を保持する。

新規Work作成時はSeries IDを明示して保存する。

### 7.5 `saveChanges`

現在すでに `changes.workId` が必須なので基本構造を維持する。

追加で以下を保証する。

- 更新対象のWorkが存在する。
- 子レコードの `workId` が対象Workと一致する。
- 参照検証時に別Workの同一種別データを誤参照しない。
- global ID registryの重複ポリシーは現行挙動を維持する。

## 8. Work Deletion

`deleteWork(store, workId)` は1トランザクションで対象Workと所属子データを削除する。

対象:

- works
- chapters
- episodes
- episodeBodies
- scenes
- characters
- images
- imageBlobs
- lineCharacterRefs
- idRegistry

削除対象は必ず `workId` で限定する。

### Safety Rules

- 現在Seriesの最後の1作品は削除不可。
- activeWorkIdを削除する場合、削除前または同一トランザクション内で次のWorkをactiveにする。
- 画像BlobやepisodeBodiesなど、直接 `workId` indexがない場合は必要に応じてindex追加または関連ID経由で安全に削除する。
- Series自体の削除UIは今回実装しない。

## 9. Application Boot Flow

新bootフロー:

```text
openStore()
  -> migrate if needed
  -> getWorkspaceMeta()
  -> validate activeSeriesId / activeWorkId
  -> if missing, repair from available Series/Works
  -> if no data, create initial Series + Work
  -> loadWorkIndex(activeWorkId)
  -> load first/remembered episode
  -> initialize editor state
```

`workspaceMeta` が壊れている場合でも起動不能にせず、既存データから修復する。

優先順位:

1. workspaceMeta.activeWorkIdが有効なら使用
2. activeSeries内の先頭Work
3. 任意のSeriesの先頭Work
4. データがなければ新規作成

## 10. Series UI

上部ナビゲーションを次の4画面にする。

```text
シリーズ | 本文 | プロット | キャラクター
```

### 10.1 Series Screen

表示内容:

```text
シリーズ名
シリーズ概要

作品
┌─────────────────────┐
│ 作品A                 │
│ 概要...               │
│ [開いている]          │
└─────────────────────┘

┌─────────────────────┐
│ 作品B                 │
│ 概要...               │
│ [開く] [削除]         │
└─────────────────────┘

[＋ 新しい作品]
```

シリーズ名と概要は自動保存する。

### 10.2 Create Work

`＋ 新しい作品` では `NovelModel.createWork()` を基に空Workを作成し、現在Seriesへ保存する。

作成後はその作品をactiveへ切り替える。

### 10.3 Switch Work

作品切替手順:

1. compositionや画像読込中なら切替をブロックする。
2. 現在のpending changesをflushする。
3. 保存失敗時は切替しない。
4. `setActiveWorkspace()` を更新する。
5. `loadWorkIndex(targetWorkId)` を読む。
6. 最初のEpisodeとSceneを読む。
7. History / selection / activeScene / loaded imagesをリセットする。
8. editor stateを対象Workへ差し替える。
9. 各画面へworkspace変更通知を送る。

別Workへundo/redoが跨らないよう、Historyは完全に切る。

### 10.4 Delete Work

削除前に作品名を示した確認ダイアログを出す。

現在開いているWorkを削除する場合は、別Workを選択してから削除処理を完了する。

最後の1作品では削除ボタンを無効化する。

## 11. Existing ZIP Behavior

### Export

「ZIPで保存」は**現在開いているWorkのみ**を既存 `fumizukue-work-archive` 形式で出力する。

`NovelStorage.loadWork(db, activeWorkId)` を使用する。

Series metadataはZIPへ含めない。

### Import

既存の「作品を開く」は当面、**現在開いているWorkをインポートしたWorkで置き換える**。

Series内へ新しい別Workとして追加する機能は今回実装しない。

重要点:

- importされたWork IDが現在Workと異なる場合でも、置換操作として現在Workを消した後に新Workを同じSeriesへ所属させる。
- Series IDはZIP由来ではなく現在Seriesを引き継ぐ。
- 既存確認文言は「現在の作品を置き換える」で維持する。

将来は「現在作品を置換」と「シリーズへ別作品として追加」を分離できる。

## 12. Detailed Overview and Other Local State

作品概要詳細などWork IDをキーとしてlocalStorageへ保存している機能は、Work IDが維持される限り引き続き作品単位で分離できる。

Series切替によるlocalStorage全消去は行わない。

将来的にSeries ZIPを追加するときは、これらのローカル補助データを正式な永続化契約へ移すことを別課題とする。

## 13. Interaction with Chapter Workspace Design

既存の「master work + chapter work pack」設計と矛盾しないことを必須とする。

Series Layerの責務:

```text
Series
  -> multiple Work
```

Chapter Workspaceの責務:

```text
Work
  -> selected Chapter Bundles
```

したがって階層は最終的に次のようになる。

```text
Series
  ├─ Work A
  │    ├─ Chapter A1
  │    └─ Chapter A2
  └─ Work B
       ├─ Chapter B1
       └─ Chapter B2
```

Chapter archiveの `sourceWorkId` はSeries導入後もWork IDを参照し続ける。

Series Layer導入によって章ZIP形式を変更しない。

## 14. Error Handling and Recovery

次のケースを明示的に扱う。

### Broken WorkspaceMeta

Series/Work実データから自動修復する。

### Work Belongs to Missing Series

起動時のrepairで新しい回復Seriesを作成し、そのWorkを所属させる。

### Series With No Works

UI上は通常作らない。発生した場合はSeries画面で新規Work作成を促すか、boot repairで空Workを1件作る。

### Partial Work Data

既存の厳格なvalidation方針を維持し、対象Work内だけで孤立データを判定する。

他Workの行を「孤立」と誤判定してはならない。

### Save Conflict

競合エラーには対象Workの競合だけを反映する。

別Workの更新は競合理由にしない。

## 15. PWA / Cache Changes

新規 `series.js` を追加する場合はService Workerのprecacheへ追加し、cache versionを更新する。

Series画面はオフラインでも完全利用可能であることを維持する。

IndexedDB migration自体はネットワーク接続に依存しない。

## 16. Proposed File Changes

主対象:

- `storage.js`
  - DB version更新
  - stores/index migration
  - Work単位revision
  - Work-scoped load/save/delete
  - Series/WorkspaceMeta APIs
- `app.js`
  - activeSeries/work lifecycle
  - Work切替
  - import/exportのactiveWork対応
  - boot repair
- `index.html`
  - Series tab/panel
- `styles.css`
  - Series screen/cards
- `series.js` (new)
  - Series UI rendering and interactions
- `workspace-loader.js`
  - 必要ならWork ID明示ロードへ追従
- `sw.js`
  - 新規JS cache

必要に応じて `editor-state.js` の初期化APIを再利用または最小拡張する。

`model.js` と `package.js` の作品schemaは原則変更しない。

## 17. Testing Strategy

### Migration Tests

- v4単一Work DB -> Series 1件 + Work 1件へ移行
- Work ID / Chapter ID / Episode ID等が不変
- 既存本文・人物・画像が不変
- workspaceMetaが正しく設定される
- 予期せぬ複数Work DBでもデータを削除しない

### Persistence Tests

- SeriesにWork A/Bを保存できる
- AをsaveしてもBのデータが変わらない
- Bを削除してもAのデータが残る
- `loadWork(A)` がBのbody/blobを孤立扱いしない
- `saveWork(A)` がBのレコードを削除しない

### Revision Tests

- AのrevisionとBのrevisionが独立
- Aを別タブで競合更新すると従来通り検出
- Bの更新はA保存の競合にならない

### UI/Flow Tests

- 初回起動でSeries + Workが作られる
- Series画面に作品一覧が表示される
- 新規作品作成後、その作品へ切替可能
- Work A -> Work B -> Work Aで内容が保持される
- 最後の1作品を削除できない
- activeWork削除時に別Workへ安全に移る

### Compatibility Tests

- 既存work ZIP export/importが成功
- export ZIP内部形式が変わっていない
- legacy migrationが引き続き機能する
- plot/characters/manuscript各画面がWork切替後に正しいデータへ追従
- Service Worker cacheにSeries UI資産が含まれる

## 18. Non-Goals for This Phase

今回は実装しない。

- 複数Seriesを切り替える専用UI
- Series削除
- Workを別Seriesへ移動
- Series ZIP
- ZIPを別Workとして追加
- シリーズ共有Character / Place / Organization
- Series timeline
- cross-work links
- cross-work foreshadowing
- cross-work consistency checker
- cloud sync

DBはこれらを後から追加できる形にする。

## 19. Acceptance Criteria

このフェーズは以下をすべて満たしたとき完了とする。

1. 既存ユーザーの単一作品データが失われずSeries配下へ移行する。
2. 1Series内に2件以上のWorkを保存できる。
3. Series画面からWorkを作成・開く・削除できる。
4. Work切替後に本文、プロット、人物が正しいWorkへ切り替わる。
5. Work Aの保存・削除・置換がWork Bへ影響しない。
6. Work単位の競合検出が維持される。
7. 既存作品ZIPの読み書き互換が維持される。
8. PWAオフライン利用が維持される。
9. 既存の章ワークスペース設計を破壊しない。

## 20. Recommended Implementation Order

1. IndexedDB migration + Series/WorkspaceMeta stores
2. Work単位revisionとWork-scoped read/write/delete
3. Storage APIテスト
4. app bootをactiveWork対応へ変更
5. Series UI追加
6. Work作成・切替・削除
7. ZIP import/export activeWork対応
8. PWA cache更新
9. 全回帰テスト

保存層の複数Work対応を先に完成させ、UIから未完成APIへ依存しない順序で進める。
