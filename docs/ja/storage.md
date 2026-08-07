# ファイルストレージガイド

> **ファイルストレージは既定では無効です。** S3 互換ストレージ（ローカルの MinIO、AWS S3、Cloudflare R2 など）を別途用意し、Settings → Storage で接続設定を登録して有効化してください。

AZITO は MinIO（S3 互換オブジェクトストレージ）を使ったファイルストレージ機能を提供します。プロジェクトごとにファイルをアップロード・共有できます。

## MinIO のセットアップ

プロジェクトルートに `docker-compose.yml` が用意されています。

```yaml
services:
  minio:
    image: minio/minio
    container_name: azito-minio
    ports:
      - "9000:9000"   # S3 API
      - "9001:9001"   # Web コンソール
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio-data:/data
    command: server /data --console-address ":9001"
    restart: unless-stopped

volumes:
  minio-data:
```

MinIO を起動します。

```bash
docker compose up -d
```

起動後、MinIO Web コンソール（`http://localhost:9001`）にアクセスして動作を確認できます（ユーザー: `minioadmin` / パスワード: `minioadmin`）。

## AZITO での設定

1. AZITO のナビゲーションから **Settings** を開く
2. サイドバーで **Storage** を選択
3. 以下の項目を設定する

| 項目 | 値（デフォルト） | 説明 |
|---|---|---|
| Endpoint URL | `http://localhost:9000` | MinIO の S3 API エンドポイント |
| Access Key | `minioadmin` | MinIO のアクセスキー |
| Secret Key | `minioadmin` | MinIO のシークレットキー |
| Bucket Name | `azito-files` | ファイル保存先バケット名（自動作成） |
| Region | `us-east-1` | リージョン（MinIO ではデフォルト値で可） |
| Max File Size | `50` MB | アップロード可能な最大ファイルサイズ |
| Use SSL | オフ | ローカル環境ではオフ |

4. **Save** ボタンをクリック

バケットが存在しない場合は自動的に作成されます。

## ファイルアップロード

### サイドバーからアップロード

1. ワークスペースのアクティビティバーで **Storage** モードを選択
2. 「+」ボタンをクリックしてファイル選択ダイアログを開く
3. アップロードするファイルを選択（複数選択可）

### ドラッグ&ドロップ

Storage サイドバーが表示されている状態で、ファイルをサイドバーエリアにドラッグ&ドロップするとアップロードされます。

また、ターミナルの入力モード（Input View）でもテキスト入力エリアにファイルをドラッグ&ドロップできます。アップロード後、Markdown 形式のリンクが自動挿入されます。

- 画像ファイル: `![filename](URL)`
- その他のファイル: `[filename](URL)`

### 添付ボタン

入力モードのテキストエリア左にある添付ボタン（クリップアイコン）からもファイルをアップロードできます。

## ファイルのダウンロード

ファイル一覧の各ファイルの右側にあるダウンロードアイコンをクリックすると、ファイルをブラウザにダウンロードできます。ダウンロードは AZITO サーバー経由のプロキシエンドポイントを通じて行われるため、MinIO が外部公開されていなくても利用可能です。

## URL のコピー

ファイル一覧の各ファイルの右側にあるリンクアイコンをクリックすると、ファイルのプロキシ URL がクリップボードにコピーされます。

URL の形式:

```
https://<host>/api/projects/<projectId>/storage/<filename>/raw
```

この URL は AZITO サーバー経由のプロキシアクセスのため、MinIO が外部公開されていなくても利用できます。

## サムネイル表示

画像ファイル（JPEG, PNG, GIF, WebP, SVG, BMP, ICO）はファイル一覧でサムネイルが表示されます。

## ファイルの削除

ファイル一覧の各ファイルの右側にある削除アイコンをクリックすると、ファイルが削除されます。

## ストレージパス

ファイルは MinIO 上で以下のパスに保存されます。

```
<bucket>/projects/<projectId>/<timestamp>_<filename>
```

プロジェクトごとにディレクトリが分離されています。
