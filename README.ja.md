# AZITO

[English](./README.md) | 日本語

**いつでも、どこでも、どんな端末からでも開発環境にアクセスできるワークスペース**

AZITO は、ブラウザからリモートサーバー上の tmux セッションを操作し、複数のAIコーディングエージェント（Claude Code, Codex）を一元管理するためのWebアプリケーションです。

## 解決する課題

エージェンティック開発では、複数のプロジェクトで同時にAIエージェントを稼働させ、成果物の確認・指示出しを繰り返します。従来のワークフローには以下の問題がありました。

- **リソースの圧迫** -- プロジェクトごとにVS Codeを立ち上げると、クライアントPCのメモリ・CPUを大量消費し、動作が不安定になる
- **コンテキストの散逸** -- 複数のエディタウィンドウ × 複数のtmuxウィンドウ × 複数ペインが乱立し、「どこで何をしていたか」を見失う
- **場所とデバイスの制約** -- スマートフォンや非力な端末からtmuxを直接操作するのは現実的でなく、外出先や移動中の作業が困難

AZITO はこれらの課題を解消し、ブラウザひとつで完結する開発体験を提供します。

## 特長

### ブラウザベースのターミナル管理
xterm.js によるフルターミナルモードを提供し、タッチスワイプスクロールやモバイル向けクイックアクションキー（Enter / Esc / Ctrl+C / 矢印）に対応。tmux セッション・ウィンドウ・ペインをブラウザから直接操作できます。

### プロジェクト単位のワークスペース
ウィンドウ、タスク、ファイル、Unit（実行チーム定義）をプロジェクトごとに統合管理。プロジェクト間の切り替えはドロップダウンからワンクリックで行え、タブはプロジェクトを横断して維持されます。タブグループによる整理にも対応しています。

### 自律エージェント実行
オーケストレーターがタスクを分析し、ワーカーエージェントに指示を送る自律実行ループ。Planning → Implementing → Reviewing → Testing → Pushing のフェーズ管理に対応し、フェーズ完了はファイルベースで検知されます。各フェーズの作業内容は Sidekick（タグ付きスキルパッケージ）が定義し、フェーズワークフロー（どのフェーズをどの Sidekick が担うか）と実行ランタイム（ワーカー種別・モデル・オーケストレーターモード）は Unit が定義します。Unit の1回の実行ランを Operation と呼びます。停滞検知（5分間無出力）とリトライにも対応しています。

### azt-harness（Claude Code ネイティブ実行）
タスクの各フェーズを Claude Code の **`/azt-*` スキル**として実行できるハーネスです。`AZITO_DONE` などのマーカーに依存せず、Claude Code がユーザーと自然に対話しながら plan → implement → review → test → push を進めます。AZITO API を MCP ツールとして公開する **azt-mcp**、サブエージェントへ渡す実装ルール（prompt-modules）、完了通知・アクティビティ通知 hook を同梱し、`setup.sh` 一発で Claude Code 環境に組み込めます。

### マルチサーバー対応
Tailscale によるプライベートネットワーク経由で複数の開発サーバーに接続。Local と Agent の2種類のサーバータイプをサポートしています。Agent タイプは SSH 経由でリモートサーバーに配備され、自動インストール・自動アップデートに対応しています。

### Worktree ベースのタスク実行
タスクごとに Git worktree を作成し、独立したブランチで実行。正確な差分表示と分離実行を実現します。`IWorktreeService` インターフェースによりローカル・リモートサーバーの両方でworktree操作が可能です。ユーザー指定のブランチ名にも対応し、PR作成をスキップする実行モード（skipPr）も選択できます。

### GitHub / GitLab 連携
リポジトリのイシュー・PR/MR を取得・検索し、イシューから直接タスクを作成できます。セルフホスト GitLab にも対応しています。

### PWA 対応
プッシュ通知（タスク完了・失敗・質問・計画レビュー待ち・エージェント idle・承認要求など全11種）、ホーム画面への追加、オフラインサポートに対応。スマートフォンからでもネイティブアプリに近い操作感で利用できます。

### ファイル操作
ファイルエクスプローラー、シンタックスハイライト付きプレビュー、画像プレビュー、PDFプレビュー、ファイルダウンロード、VS Code / Zed との連携に対応しています。

### セッション復帰
エージェントのペインが消失した場合、保存されたセッションIDを使用してワンクリックでエージェントを再起動できます。30秒間隔のペイン生存確認と復帰UIを提供します。

### タスク管理の強化
タスクID・Issue番号・PR番号のバッジ表示、タスク完了時のサマリ自動生成、タスク削除時の関連リソース（tmuxウィンドウ・worktree・一時ファイル）自動クリーンアップ、起動時の非終端タスク自動復旧に対応しています。

### トークン使用量トラッキング
ローカルのセッションログから Claude / Codex のトークン使用量を集計し、ヘッダーのドロップダウンに表示します。

### tmux 実行系統の選択
サーバーごとに、システムの tmux と AZITO 管理の tmux（SHA256 検証付きで自動ダウンロードされる静的バイナリ、Linux x86_64/aarch64 のみ）を選択できます。推奨 tmux 設定はサーバー設定画面から適用できます。

### ファイルストレージ
MinIO（S3 互換）によるファイルアップロード・共有。ドラッグ&ドロップ対応。

## アーキテクチャ

```
Browser (React 19 + Vite)
  ├── HTTP REST API ──► Fastify Server (TypeScript, feature-first modules)
  ├── WebSocket ──► ターミナル / キャプチャストリーム / タスクログ
  │
  └── Fastify Server
        ├── modules/         # 1機能 = 1モジュール（routes・service・repository を同居）
        │     ├── tmux/, servers/          # 基盤層: tmux クライアント、サーバートランスポート（Local / Agent）
        │     ├── agents/, git/, llm/,     # 中間層: ワーカー、worktree、LLM クライアント、
        │     │   prompt/, sidekicks/      #   フェーズプロンプト、Sidekick パッケージ
        │     └── tasks/, windows/, units/, operations/,   # 上位層: タスク実行（オーケストレーター）、
        │         projects/, files/, usage/, notifications/ #   プロジェクト、ファイル、使用量、プッシュ通知
        └── shared/db/       # SQLite（WAL モード）+ マイグレーション
```

### サーバータイプ

| タイプ | 接続方式 | 用途 |
|---|---|---|
| Local | 直接実行 | AZITO が動作しているマシン |
| Agent | AZITO Agent (HTTP/WS) | リモートサーバー — SSH（Tailscale）経由で配備。自動インストール・自動アップデート対応 |

## クイックスタート

### 前提条件

リリース版は Node.js を同梱しています。それ以外はホスト側に必要です。

| ソフトウェア | バージョン | 用途 |
|---|---|---|
| Node.js | v24+ | バックエンド・フロントエンド（リリース版は同梱） |
| tmux | 3.4+ | ターミナルセッション管理 |
| Tailscale | 最新 | SSH 接続 / HTTPS / プッシュ通知 |
| Docker | 最新（任意） | MinIO（ファイルストレージ）用 |

AIエージェントを使用する場合:
- **Claude Code CLI** (`claude`)
- **Codex CLI** (`codex`) -- フラットレートプラン

GitHub 連携を使用する場合は **GitHub CLI** (`gh`) も必要です。

### インストール（リリース版）

リリース版は Node.js を同梱しているため、npm も clone も不要です:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/wireframeslayout/azito/releases/latest/download/install.sh | bash
```

> `| sh` ではなく `| bash` を使ってください — インストーラは bash 依存です（`set -euo pipefail`）。

`~/.azito` に導入し、systemd（Linux）または launchd（macOS）のサービスを登録して UI トークンを表示します。ブラウザで `http://localhost:3001` を開いてください。中身を確認してからの実行・オプション指定・チェックサム検証は [インストールとアップデート](./docs/ja/install-and-update.md) を参照してください。

対応環境: Linux x64 / arm64、macOS Apple Silicon。

### ソースから起動（開発）

```bash
git clone <repository-url> azito
cd azito
npm install
```

バックエンド（`:3001`）とフロントエンド（`:5173`）をまとめて起動します。

```bash
npm run dev
```

ブラウザで `http://localhost:5173` を開くとアクセスできます。

### 初期セットアップ

1. **サーバーの確認** -- デフォルトで `local` サーバーが登録済み。Agent サーバーは Settings から追加
2. **プロジェクトの作成** -- Projects ページからプロジェクトを作成し、ワーキングディレクトリを設定
3. **ワークスペースを開く** -- プロジェクトのワークスペースでウィンドウの追加や Unit を設定

## ドキュメント

詳細なガイドは [docs/ja/](./docs/ja/) を参照してください。

| ドキュメント | 内容 |
|---|---|
| [ユーザーガイド](./docs/ja/README.md) | 全体概要とクイックスタート |
| [インストールとアップデート](./docs/ja/install-and-update.md) | リリース版の導入、設定ファイルの場所、Tailscale 経由のアクセス、更新とロールバック |
| [セキュリティ設定・環境構築](./docs/ja/security-setup.md) | 環境変数、トークン管理、公開範囲の設定、トラブルシューティング |
| [ワークスペース](./docs/ja/workspace.md) | レイアウト、サイドバー、タブ管理 |
| [Sidekick / Unit / Operation](./docs/ja/sidekicks.md) | Sidekick（タグ付きスキルパッケージ）・Unit（実行チーム）・Operation（実行ラン）の全体像 |
| [azt-harness](./docs/ja/harness.md) | Claude Code ネイティブ実行（/azt-* スキル・azt-mcp・hook） |
| [タスク管理](./docs/ja/tasks.md) | タスクの作成・実行・Worktree・停滞検知 |
| [ファイル操作](./docs/ja/files.md) | エクスプローラー、プレビュー（画像・PDF）、エディタ連携 |
| [GitHub/GitLab 連携](./docs/ja/github-integration.md) | イシュー・PR/MR の取得とタスク作成 |
| [プッシュ通知](./docs/ja/push-notifications.md) | PWA プッシュ通知の有効化 |
| [ファイルストレージ](./docs/ja/storage.md) | MinIO によるファイル管理 |
| [tmux 設定ガイド](./docs/ja/tmux.md) | 必須/推奨の tmux 設定、managed/system モード |

## 技術スタック

- **Frontend**: React 19, Vite, TypeScript, xterm.js
- **Backend**: Fastify, TypeScript (feature-first modules)
- **Database**: SQLite (better-sqlite3, WAL mode)
- **Terminal**: tmux, node-pty
- **Network**: Tailscale (SSH, HTTPS)
- **AI Agents**: Claude Code, Codex

## ライセンス

本プロジェクトは GNU Affero General Public License v3.0 (AGPL-3.0) の下で公開されています。詳細は [LICENSE](./LICENSE) ファイルを参照してください。

Copyright (c) 2026 Junzo Matsunoo (wireframeslayout)

コントリビューションには CLA（Contributor License Agreement）への同意が必要です。詳細は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。
