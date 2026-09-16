# 文机 PWA 分割版

GitHub Pages などの静的ホスティングへ、そのまま配置できる構成です。

## ファイル構成

- `index.html` — HTML 本体
- `styles.css` — 元の `<style>` を分離
- `core.js` — DOM 非依存のデータ/編集ロジック
- `images.js` — 画像読み込み・検証
- `app.js` — UI とアプリ本体
- `pwa.js` — Service Worker 登録
- `manifest.webmanifest` — PWA マニフェスト
- `sw.js` — オフラインキャッシュ
- `icons/` — PWA アイコン
- `.nojekyll` — GitHub Pages で Jekyll 処理を無効化

## GitHub Pages での配置

> 前提: `github.io` で配信される GitHub Pages を使用します。通常の `github.com/.../blob/...` や `raw.githubusercontent.com/...` のファイル URL は、PWA の公開先としては扱いません。

リポジトリ内で上記ファイルの相対関係を保ったまま公開してください。`.nojekyll` もリポジトリの公開ルートに置きます。

この構成では CSS / JavaScript / manifest / アイコン / Service Worker の参照を `./` で統一しています。そのため、GitHub Pages のプロジェクトサイトのように URL が `/<repository>/` 配下になる場合でも動作します。

`./` を `/` に変更するとドメイン直下を参照してしまい、プロジェクトサイトではファイルが見つからなくなる場合があるため変更しないでください。

## ローカルでの確認

Service Worker は `file://` では動作しません。開発時は HTTP サーバーで配信してください。

```powershell
cd fumizukue-pwa
python -m http.server 8000
```

PC では `http://localhost:8000/` で確認できます。

## キャッシュ方針

- 初回インストール時にアプリ本体をキャッシュします。
- オンライン時はネットワークを優先して最新版を取得し、成功したレスポンスをキャッシュ更新します。
- オフライン時は最後に取得できたキャッシュへフォールバックします。
- Service Worker は自身の scope 内だけを処理するため、同一 GitHub Pages ドメイン上の別パスを誤ってキャッシュしません。

通常の CSS / JS 更新では `CACHE_NAME` を毎回変更する必要はありません。キャッシュ構造そのものを変更したときだけ、`sw.js` の `CACHE_NAME` を更新してください。
