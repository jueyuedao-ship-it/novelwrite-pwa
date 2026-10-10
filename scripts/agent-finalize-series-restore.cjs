const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`${label} marker not found`);
  return source.replace(before, after);
}

// Service Worker cache generation.
{
  const path = 'sw.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "const CACHE_NAME = 'fumizukue-series-chapter-v8';",
    "const CACHE_NAME = 'fumizukue-series-chapter-v9';",
    'service worker cache name'
  );
  fs.writeFileSync(path, source);
}

// User-facing inline help.
{
  const path = 'index.html';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    'シリーズZIPは現在のシリーズ内の全作品をまとめて保存します。単体作品ZIPの保存・読み込みはプロットの「シリーズ設定」から、章ZIPは特定の章だけを軽量な作業パックとして保存できます。',
    'シリーズZIPは現在のシリーズ内の全作品をまとめて保存・復元できます。上部の「シリーズZIPを開く」でバックアップを復元できます。単体作品ZIPの保存・読み込みはプロットの「シリーズ設定」から、章ZIPは特定の章だけを軽量な作業パックとして保存できます。',
    'index Series ZIP help'
  );
  fs.writeFileSync(path, source);
}

// README: replace stale Series restore guidance while keeping Work/chapter behavior unchanged.
{
  const path = 'README.md';
  let source = fs.readFileSync(path, 'utf8');

  source = replaceOnce(
    source,
    '文机の最上位の作業単位はシリーズです。通常モードの上部には「シリーズを切り替える」「シリーズZIPで保存」「新しいシリーズ」があり、同じ端末内に複数シリーズを保持して切り替えられます。シリーズへ戻ったときは、そのシリーズで最後に開いていた作品へ戻ります。',
    '文机の最上位の作業単位はシリーズです。通常モードの上部には「作品ZIPを開く」「シリーズZIPを開く」「章ZIPを開く」「シリーズZIPで保存」「新しいシリーズ」があります。シリーズZIPを復元すると、manifest の `activeWorkId` に記録された最後に開いていた作品が開かれます。',
    'README top Series controls'
  );

  source = replaceOnce(
    source,
    '「シリーズZIPで保存」は、現在のシリーズに含まれるすべての作品を `fumizukue-series-archive` v1 として1つのZIPへまとめます。内部では既存の作品ZIPを `works/0001.zip` などとして保持し、manifestに作品一覧とSHA-256を記録します。現在のフェーズでは**シリーズZIPの読み込み・復元は未実装**です。復元や端末間移送が必要な作品については、プロット画面から単体作品ZIPも保存してください。',
    '「シリーズZIPで保存」は、現在のシリーズに含まれるすべての作品を `fumizukue-series-archive` v1 として1つのZIPへまとめます。内部では既存の作品ZIPを `works/0001.zip` などとして保持し、manifestに作品一覧とSHA-256を記録します。「シリーズZIPを開く」でこのバックアップを検証して復元できます。端末内に同じシリーズIDのシリーズがない場合は新規シリーズとして復元し、同じシリーズIDがある場合は確認後にその同じシリーズだけをバックアップ内容で置き換えます。別シリーズが同じ作品・章・話・行・シーン・人物・画像などのIDを使用していてID衝突が起きる場合は復元を中止します。ZIP全体と各作品ZIPの検証が完了するまでIndexedDBは変更せず、復元中に失敗した場合も途中状態は残しません。',
    'README Series restore behavior'
  );

  source = replaceOnce(
    source,
    '章ワークスペース中はシリーズ切替・新しいシリーズ・シリーズZIP保存・シリーズ内の作品切替を無効にします。通常モードへ戻るときは、編集した章ZIPを先に保存したうえで、上部の「マスター作品ZIPを開く」から元の作品ZIPを読み込んでください。フル作品を読み込むと章ワークスペース情報が解除されます。',
    '章ワークスペース中は新しいシリーズ・シリーズZIP保存・シリーズZIP復元・シリーズ内の作品切替を無効にします。通常モードへ戻るときは、編集した章ZIPを先に保存したうえで、上部の「マスター作品ZIPを開く」から元の作品ZIPを読み込んでください。フル作品を読み込むと章ワークスペース情報が解除されます。',
    'README chapter Series restrictions'
  );

  source = replaceOnce(
    source,
    '作品と画像を確認したら、プロット画面の「現在の作品ZIPで保存」で単体作品ZIPを保存し、必要な作品をすべてシリーズへ追加した後に「シリーズZIPで保存」も実行してください。単体作品ZIPは現在の復元・移送用、シリーズZIPはシリーズ全体の一括バックアップ用として保管します。',
    '作品と画像を確認したら、プロット画面の「現在の作品ZIPで保存」で単体作品ZIPを保存し、必要な作品をすべてシリーズへ追加した後に「シリーズZIPで保存」も実行してください。単体作品ZIPは1作品だけを移送・置換したい場合に、シリーズZIPはシリーズ全体を一括バックアップ・復元したい場合に使います。',
    'README archive role guidance'
  );

  source = replaceOnce(
    source,
    'Safariからホーム画面アプリへ移す場合は、Safari版のプロット画面で「現在の作品ZIPで保存」を押し、ダウンロードしたZIPを共有シートから「ファイルに保存」します。ホーム画面アプリを開き、必要なら新しいシリーズを作成してから、プロット画面の「作品ZIP / 旧JSONを開く」でそのZIPを選びます。作品を置き換える確認が出たら、内容を確認して読み込みます。',
    'Safariからホーム画面アプリへシリーズ全体を移す場合は、Safari版で「シリーズZIPで保存」を押し、ダウンロードしたZIPを共有シートから「ファイルに保存」します。ホーム画面アプリを開き、上部の「シリーズZIPを開く」でそのZIPを選びます。移送先に同じシリーズIDがある場合は置き換え確認が出るため、内容を確認して復元します。1作品だけを移す場合は、従来どおりプロット画面の「現在の作品ZIPで保存」と「作品ZIP / 旧JSONを開く」を使えます。',
    'README Safari to home transfer'
  );

  source = replaceOnce(
    source,
    'ホーム画面アプリからSafariへ戻す場合も同じ手順です。ホーム画面アプリで単体作品ZIPを書き出して「ファイル」に保存し、Safariで文机を開いてプロット画面から取り込みます。シリーズ全体を移送する場合は、シリーズ内の各作品について単体作品ZIPを保存してください。シリーズZIPの読み込みは今後のフェーズで追加予定です。',
    'ホーム画面アプリからSafariへ戻す場合も同じ手順です。シリーズ全体ならホーム画面アプリでシリーズZIPを書き出して「ファイル」に保存し、Safariで文机を開いて「シリーズZIPを開く」から復元します。復元成功後はバックアップの `activeWorkId` に対応する作品が開きます。',
    'README home to Safari transfer'
  );

  fs.writeFileSync(path, source);
}

// Mark the user-approved design as accepted.
{
  const path = 'docs/superpowers/specs/2026-10-10-series-archive-restore-design.md';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(source, 'Status: Proposed', 'Status: Accepted', 'spec status');
  fs.writeFileSync(path, source);
}
