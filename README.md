# 文机 PWA 配布フォルダ

この内容が `App-PWA/` にビルドされます。GitHub Pages などのHTTPS静的ホスティングでは、`App-PWA/` 内のファイル一式を公開ルートへ配置し、相対パスを保ってください。

## 配布ファイル

- `index.html`、`styles.css`、`core.js`、`images.js`、`app.js`：共通の `src/` から生成
- `pwa.js`：`src/pwa.js` から生成し、Service Worker を登録
- `manifest.webmanifest`、`sw.js`、`icons/`、`.nojekyll`：この `pwa/` フォルダで管理し、ビルド時に配置
- `sw.js` のキャッシュ名はアプリの内容から生成されます。アプリ更新時に新しいキャッシュを作成し、古い文机用キャッシュを有効化時に削除します。

GitHub Pagesのプロジェクトサイトのようにリポジトリ名の下へ公開する場合も、CSS・JavaScript・マニフェスト・アイコン・Service Workerは `./` 相対参照のままにします。

## ローカルでのHTTP確認

Service Worker は `file://` では動作しません。開発用の元プロジェクトで確認する場合は、そのルートから次を実行し、出力された `http://127.0.0.1:4174/repo/` を開いてください。

```powershell
npm.cmd run build
npm.cmd run serve:pwa
```

このサーバーはGitHub Pagesのプロジェクトサイトに近いサブパス `/repo/` でPWAを配信します。使用中ポートを変える場合は `FUMIZUKUE_PWA_PORT` を設定してください。

公開用のこのリポジトリだけを取得した場合、上記の npm スクリプトは含まれません。その場合はリポジトリのルートで `python -m http.server 8000` を実行し、`http://localhost:8000/` を開いてください。

## 公開URLと保存データ

ローカルの `App-WPA/` から `App-PWA/` へのフォルダ名変更は、この公開フォルダの名前だけを変えます。GitHub上の公開URLやPagesの公開元設定は変更しません。公開済みURLを変える場合は、GitHub側の公開元を別途更新する必要があります。

2026-09-27時点で、本人から、GitHubで発行済みのURLをスマートフォンでも利用できていると報告を受けています。これは本人の利用報告です。

作品データはブラウザの同じオリジン内に保存されます。公開先のドメイン・プロトコル・ポートが変わるとブラウザ保存領域も分かれるため、その場合は旧URLで作品JSONを書き出し、新URLで取り込んでください。フォルダのパスだけを変え、オリジンが同じなら `localStorage` の復元コピーはそのまま使えます。作品JSONも定期的に書き出してください。
