# AZITO ユーザーガイド

## AZITO とは

AZITO は、ブラウザベースの tmux セッションマネージャーであり、自律エージェント開発のためのワークスペースです。複数のコーディングエージェント（Claude Code、Codex）をローカル・SSH・エージェントサーバー上で管理し、UnitType が定義するフェーズループで自律的なタスク実行を実現します。タスクの進め方と実行ランタイムは Unit（オペレーションを実行するチーム）、フェーズごとの作業内容は Sidekick（タグ付きスキルパッケージ）が担い、Operation は Unit がタスクを遂行する1回の実行ランを指します。

## 主な機能

- **ターミナル管理** -- ブラウザから tmux セッション・ウィンドウ・ペインを操作。xterm.js によるフルターミナルモード（タッチスクロール・クイックアクション対応）
- **ターミナルテーマ** -- プリセット7種＋自作テーマの保存に対応。配色（ANSI 16色含む）・背景（グラデーション/画像/単色）・適用範囲（ターミナルのみ/画面全体）をライブ編集でカスタマイズ
- **tmux 実行系統の選択** -- サーバーごとに system（既存 tmux）と managed（AZITO 管理の tmux、推奨設定込みで自動配置）を選択可能
- **自律タスク実行** -- ワーカー（Claude Code / Codex）を Planning → Implementing → Reviewing → Testing → Pushing のフェーズループで駆動する自律実行。フェーズごとの Sidekick 割当と有効/無効は Unit の `phase_config` で設定する
- **azt-harness** -- 各フェーズを Claude Code の `/azt-*` スキルとして実行するハーネス。マーカーに依存せず Claude Code が自然な対話でタスクを進める。azt-mcp（MCP ツール）・prompt-modules（実装ルール）・完了通知 hook を同梱し、`setup.sh` で導入
- **プロジェクトワークスペース** -- プロジェクト単位でウィンドウ、Sidekick、Unit、タスク、ファイル、リポジトリを統合管理
- **プロジェクトアイコン・カラー** -- プロジェクトごとにアイコン（絵文字）とテーマカラーを設定可能。プロジェクトバーやタブに反映
- **プロジェクトナビゲーション** -- サイドバータイトルのドロップダウンからプロジェクトを素早く切り替え。デスクトップ・モバイル両対応
- **タブのプロジェクト横断化** -- プロジェクトを切り替えてもタブが維持され、他プロジェクトのタブにはカラードットで識別表示
- **画像プレビュー** -- ファイルエクスプローラーで画像ファイル（PNG, JPEG, GIF, WebP, SVG 等）をインラインプレビュー
- **ファイルダウンロード** -- サーバー上のファイルをブラウザからダウンロード（50MB 制限、バイナリ対応）
- **外部エディタ連携** -- ファイルプレビューから VS Code / Zed でファイルやフォルダを直接オープン。Tailscale ホスト名の自動検出に対応
- **Phase プロンプト選択** -- タスクへのフォローアップ時にフェーズプロンプトをチップで選択可能
- **ウィンドウ一括登録** -- 「Entire Session」タブからセッション内の全ウィンドウを一括でプロジェクトに登録
- **並列タスク実行** -- 複数タスクをそれぞれ独立した tmux ウィンドウ・worktree で並列実行
- **タスク停滞監視** -- 5分間出力が変化しないタスクを検知し、警告バナーとリトライボタンを表示
- **Worktree ベース実行** -- タスクごとに Git worktree を作成し、独立したブランチで実行。正確な差分表示と分離実行を実現
- **タスクのアーカイブと復帰** -- 使い終わったタスクをリソース解放付きでアーカイブし、worktree・tmux ウィンドウごと復帰可能
- **コミット履歴表示** -- タスク詳細の Commits タブで worktree のコミット一覧とコミット単位の diff を確認可能
- **タスクフォーム画面** -- タスクの作成/編集を Workspace のタブとして専用フォーム画面化。GitHub/GitLab イシューをフォームから直接リンク・参照可能
- **Base / Target ブランチ指定** -- タスク作成時に分岐元（base）と push 先（target）のブランチを指定可能
- **GitHub / GitLab 連携** -- リポジトリのイシュー・プルリクエスト / マージリクエストの取得・検索、イシューからのタスク作成（セルフホスト GitLab 対応）
- **サーバー詳細パネル** -- サーバーごとの依存（tmux / Node.js / harness / Tailscale 等）のインストール状況を可視化し、導入導線を提供
- **トークン使用量表示** -- ヘッダーから Claude / Codex のトークン使用量をドロップダウンで確認
- **サブエージェント委譲設定** -- Unit／タスク単位でサブエージェント（agent / model / 追加引数）を設定。実装ルールはファイル化してサブエージェントへ確実に渡す
- **エージェント完了 Webhook** -- エージェントの完了通知を Webhook で受信（`AZITO_WEBHOOK_TOKEN` 共有）
- **tmux ウィンドウのリードモード表示** -- タスクの tmux ウィンドウをモーダルでリードオンリー表示し、「Open in Terminal」から接続可能
- **PR / MR 取得** -- リポジトリのプルリクエスト / マージリクエストをステータスバッジ付きで一覧表示。ブランチ情報の表示にも対応
- **LLM セッション resume** -- タスク再開時にログから会話を再構築し、LLM セッションを復元
- **ファイルストレージ** -- MinIO（S3 互換）によるファイルアップロード・共有。ドラッグ&ドロップ対応、ダウンロードボタン付き
- **PWA 完全対応** -- プッシュ通知（タスク完了・失敗時）、ホーム画面追加、オフラインサポート。HTTPS 必須（Tailscale 連携）
- **UI 共通化** -- TabBar、FormInput、LoadingState 等の共有コンポーネントによる統一的な UI

## クイックスタート

### 前提条件

| ソフトウェア | バージョン | 用途 |
|---|---|---|
| Node.js | v24 以上 | バックエンド・フロントエンド実行（リリース版は同梱のため不要。ブラウザランタイム導入と supervised ウィンドウにのみ必要） |
| tmux | 3.4 以上 | ターミナルセッション管理 |
| Docker | 最新推奨 | MinIO（ファイルストレージ）用 |
| Tailscale | 最新推奨 | HTTPS / プッシュ通知 / SSH 接続 |

コーディングエージェントを使う場合は、以下も必要です:

- **Claude Code CLI** -- `claude` コマンドが使用可能であること
- **Codex CLI** -- `codex` コマンドが使用可能であること（フラットレートプラン）

### インストール

用途に応じて2通りあります。

| | リリース版 | ソース版（開発） |
|---|---|---|
| 用途 | AZITO を使う | AZITO 自体を開発する |
| 入手 | GitHub Releases の tarball（Node.js 同梱） | `git clone` + `npm ci` |
| 設定 | `~/.azito/hub/.env` | `packages/server/.env` |
| 起動 | systemd / launchd サービス | `npm run dev` |

**リリース版**の手順は [インストールとアップデート](./install-and-update.md) を参照してください。以降はソース版の手順です。

```bash
git clone <repository-url> azito
cd azito
npm ci
```

### 環境変数の設定（必須）

AZITO は認証トークンなしでは起動しません。`packages/server/.env` を作成します。

```bash
cat > packages/server/.env <<EOF
AZITO_UI_TOKEN=$(openssl rand -hex 32)
AZITO_WEBHOOK_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 packages/server/.env
cat packages/server/.env   # トークンを控える（ブラウザ入力と harness で使う）
```

Tailscale 経由でアクセスする場合や MinIO を使う場合は追加の設定が必要です。全変数の一覧と手順は [セキュリティ設定・環境構築ガイド](./security-setup.md) を参照してください。

### 初回起動

```bash
npm run dev
```

バックエンド（Fastify、`:3001`）とフロントエンド（Vite、`:5173`）が同時に起動します。ブラウザで `http://localhost:5173` を開き、`AZITO_UI_TOKEN` を入力すると AZITO にアクセスできます。

> トークンは `sessionStorage` に保存されるため、ブラウザのセッションごとに入力が必要です。

### 初期セットアップ

1. **サーバーの確認** -- デフォルトで `local` サーバーが登録されています。SSH サーバーを追加する場合は Settings から設定します
2. **harness の導入** -- `./harness/setup.sh --azito-url http://localhost:3001 --webhook-token <token> --ui-token <token> --server-name local` を実行します（`/azt-*` スキルの API 呼び出しに必要）
3. **プロジェクトの作成** -- Projects ページから新規プロジェクトを作成し、ワーキングディレクトリを設定します
4. **ワークスペースを開く** -- 作成したプロジェクトのワークスペースに移動し、ウィンドウの追加や Unit（ワークフロー＋実行ランタイム）の設定を行います

## ドキュメント一覧

| ドキュメント | 内容 |
|---|---|
| [インストールとアップデート](./install-and-update.md) | リリース版の導入手順、設定ファイルの場所、Tailscale 経由のアクセス、更新とロールバック |
| [セキュリティ設定・環境構築ガイド](./security-setup.md) | 必須の環境変数、既存環境の移行手順、新規環境の構築手順、Tailscale 設定、トラブルシューティング |
| [隔離実行プロファイル](./isolated-execution.md) | 外部入力タスクを資格情報の無いサーバーで実行する隔離実行（3層モデル、isolation doctor、allow ポリシー、ネットワーク隔離） |
| [コード配信](./code-distribution.md) | hub 代行によるコード配信（bare mirror・bundle 転送・増分配信）、隔離サーバー以外への適用 |
| [ワークスペースガイド](./workspace.md) | レイアウト、サイドバー、タブ管理、ナビゲーション |
| [プッシュ通知セットアップ](./push-notifications.md) | Tailscale を使った PWA プッシュ通知の有効化 |
| [ファイルストレージガイド](./storage.md) | MinIO のセットアップとファイル管理 |
| [GitHub/GitLab 連携ガイド](./github-integration.md) | リポジトリ連携、イシュー管理、PR/MR、タスク作成 |
| [Sidekick / Unit / Operation ガイド](./sidekicks.md) | Sidekick（タグ付きスキルパッケージ）、Unit（オペレーションを実行するチーム）、Operation（Unit の実行ラン）の全体像と使い方 |
| [azt-harness ガイド](./harness.md) | Claude Code ネイティブ実行（/azt-* スキル、azt-mcp、prompt-modules、hook、setup.sh） |
| [タスク管理ガイド](./tasks.md) | タスクの作成・実行フロー、Worktree、停滞検知、ログ |
| [ファイル操作ガイド](./files.md) | ファイルエクスプローラー、プレビュー、ダウンロード、外部エディタ連携 |
| [tmux 設定ガイド](./tmux.md) | AZITO に必須/推奨の tmux 設定、managed/system モード別の適用方法 |
| [稼働検知 Tier 判定リファレンス](./activity-detection.md) | 稼働/ブロック/非稼働の判定ラダー（Tier 0〜4）、停止理由、タイミング定数、診断パネル、質問ライフサイクル |
