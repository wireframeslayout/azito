# ファイル操作ガイド

## ファイルエクスプローラー

ワークスペースのアクティビティバーで **Files** モードを選択すると、プロジェクトのサーバー上のファイルツリーが表示されます。

### 基本操作

- ディレクトリをクリックして展開・折りたたみ
- ファイルをクリックするとメインエリアにプレビュータブが開く
- パンくずリスト（ブレッドクラム）で現在のパスを確認可能

### ファイルツリーの構成

ファイルツリーはプロジェクトの `workingDirectory` を起点として表示されます。ディレクトリの展開はサーバーに対してリアルタイムにリクエストされるため、最新のファイル状態が反映されます。

## ファイルプレビュー

ファイルをクリックすると、メインエリアにプレビューが表示されます。

### シンタックスハイライト

highlight.js による多言語対応のコードハイライトに対応しています。

| 言語 | 拡張子 |
|---|---|
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx` |
| JSON | `.json` |
| CSS | `.css` |
| XML / HTML | `.xml`, `.html`, `.svg` |
| Markdown | `.md` |
| Python | `.py` |
| Bash / Shell | `.sh`, `.bash` |
| YAML | `.yml`, `.yaml` |
| SQL | `.sql` |

上記は明示的に登録されている言語です。それ以外も highlight.js の自動検出が試みられます。

#### Markdown の表示モード

Markdown ファイルは3つの表示モードを切り替えられます。

| モード | 説明 |
|---|---|
| Source | ソースコードとして表示（シンタックスハイライト付き） |
| Preview | レンダリングされた Markdown として表示 |
| Split | 左右に Source と Preview を並べて表示 |

### 画像プレビュー

以下の形式の画像ファイルはインラインでプレビュー表示されます。

| 形式 | 拡張子 |
|---|---|
| PNG | `.png` |
| JPEG | `.jpg`, `.jpeg` |
| GIF | `.gif` |
| WebP | `.webp` |
| SVG | `.svg` |
| BMP | `.bmp` |
| ICO | `.ico` |
| TIFF | `.tiff`, `.tif` |

画像はサーバー経由のプロキシエンドポイントから取得され、Base64 エンコードで表示されます。

### PDF プレビュー

PDF ファイル（`.pdf`）は埋め込みビューアーでプレビュー表示されます。

### ストレージ画像プレビュー

ファイルストレージ（MinIO）のファイル一覧で画像ファイルを選択すると、サイドバー内にプレビューが表示されます。モバイルでは画像プレビューをクリックするとサイドバーが自動的に閉じます。

## ダウンロード

ファイルプレビュー画面の上部にあるダウンロードボタンをクリックすると、ファイルをブラウザにダウンロードできます。

### 制限事項

- 最大ファイルサイズ: **50MB**
- バイナリファイルにも対応（テキスト以外のファイルもダウンロード可能）
- ダウンロードは AZITO サーバー経由のプロキシエンドポイントを通じて行われます

### エンドポイント

```
GET /api/servers/:name/files/download?path=<filepath>
```

## 外部エディタ連携

ファイルプレビュー画面から外部エディタでファイルを直接開くことができます。

### 対応エディタ

| エディタ | ボタン | URI スキーム |
|---|---|---|
| VS Code | 「Open in VS Code」 | `vscode://` |
| Zed | 「Open in Zed」 | `zed://` |

いずれの場合も、**ファイルの親ディレクトリ**がエディタのワークスペースとして開かれます。

### Tailscale ホスト名の自動検出

リモートサーバーのファイルを外部エディタで開く場合、AZITO は Tailscale のホスト名を自動検出し、SSH リモート接続用の URI を生成します。

- VS Code: `vscode://vscode-remote/ssh-remote+<host>/<parent-dir>` 形式
- Zed: `zed://ssh/<host>/<parent-dir>` 形式

## Browser runtime（Chromium）

AZITO の CDP ブラウザ機能（タブスナップショット、エージェント操作など）を利用するには、サーバーに Chromium をインストールする必要があります。

### 前提条件

- **Linux または macOS** のみ対応（Windows は非対応）
- **Node.js v24 以上** がホストにインストールされていること（`npx` を使用するため）

### インストール手順

1. Servers → 対象サーバー → Setup タブを開く
2. 「Browser runtime (Chromium)」セクションの **Install** ボタンをクリック
3. インストールが完了するまで待つ（タイムアウト: 10分）

内部的には `npx playwright install chromium` を実行し、Hub にインストールされている Playwright のバージョンに固定された Chromium をインストールします。

### Linux での追加処理

Linux 環境では、日本語表示に必要な **Noto Sans CJK JP** フォントが自動的にインストールされます（`~/.local/share/fonts/` に配置）。フォントのインストールに失敗しても Chromium 自体のインストールは成功します（non-fatal）。

### API

```
POST /api/servers/:name/install-browser-runtime
```

レスポンス: `{ ok, chromiumVersion, fontInstalled, warning }`
