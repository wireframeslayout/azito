# AZITO 現状仕様書

- 作成日: 2026-05-31
- 最終更新: 2026-07-15 (v0.2.1 の変更を反映)
- ステータス: 実装ベースの逆引き仕様

---

## 1. 目的

複数サーバー上で動作する AI コーディングエージェント (Claude Code, Codex 等) を、ブラウザ上から一元的に管理・操作するための Web アプリケーション。tmux セッションを介してエージェントのターミナルを操作し、タスクの割り当て・自動実行・監視を行う。

## 2. システム構成

### 2.1 全体アーキテクチャ

```
Browser (React SPA)
  │
  ├── HTTP REST API ──► Fastify Server (TypeScript / feature-first モジュール構成)
  └── WebSocket (/ws) ──► ターミナル接続 / タスクログ / 通知ストリーム
```

### 2.2 パッケージ構成 (npm workspaces)

```
azito/
├── package.json              # ルート (workspaces定義)
├── data.db                   # SQLite データベース
├── harness/                  # azt-harness (skills / prompt-modules / sidekicks / hooks)
├── packages/
│   ├── server/               # Fastify + TypeScript
│   │   └── src/
│   │       ├── main.ts               # エントリポイント (composition root)
│   │       ├── app/                  # buildServer (プラグイン・ルート・WS登録)
│   │       ├── agent/                # リモートサーバーへ配布する軽量エージェント
│   │       ├── modules/              # 機能モジュール (routes+service+repository 同居)
│   │       └── shared/               # DB (SQLite/WAL) + マイグレーション
│   ├── frontend/             # React + Vite
│   │   └── src/
│   │       ├── App.tsx / router.tsx
│   │       ├── pages/                # ページコンポーネント (Workspace 中心)
│   │       ├── components/           # 共通コンポーネント
│   │       ├── hooks/                # カスタムフック
│   │       ├── api/                  # APIクライアント
│   │       └── styles/               # CSS
│   └── tui-supervisor/       # TUI スーパーバイザー (WS /ws/supervisor に接続)
```

### 2.3 技術スタック

| レイヤー | 技術 |
|---|---|
| バックエンド | Fastify 5, TypeScript, feature-first モジュール構成 |
| フロントエンド | React 19, React Router 7, Vite 6 |
| ターミナルエミュレータ | xterm.js (@xterm/xterm 5.5) |
| データベース | SQLite (better-sqlite3), WALモード |
| ターミナル管理 | tmux (ローカル: child_process, リモート: SSH) |
| SSH | ssh2 ライブラリ, ~/.ssh/config 自動解析 |
| PTY | node-pty (ローカルターミナル接続) |
| LLM連携 | OpenAI API / Anthropic API (fetch直接呼び出し), Codex CLI exec |

### 2.4 起動方法

| コマンド | 説明 |
|---|---|
| `npm run dev` | Fastify開発サーバー (tsx watch, ポート3001) + Vite devサーバー (ポート5173) を同時起動 |

## 3. 主要機能

### 3.1 サーバー管理 (Servers)

登録されたサーバー (ローカル/SSH) に対して tmux セッションを操作する。

- サーバーの CRUD (`local` / `ssh` タイプ)
- tmux セッション一覧取得 (5秒 TTL キャッシュ)
- セッション作成・削除・リネーム
- ウィンドウ作成・リネーム
- ペイン分割 (水平/垂直)・削除・リネーム
- ペインキャプチャ (スクロールバック対応, `?start=&end=` / `?history=N`)
- ペインへのキー送信 (特殊キー対応)

### 3.2 プロジェクト管理 (Projects)

作業対象のコードベースを管理する論理単位。

- プロジェクトの CRUD
- 作業ディレクトリ (`working_directory`) の設定
- アイコン (`icon`) の設定 -- 絵文字によるプロジェクト識別
- カラー (`color`) の設定 -- テーマカラー（プロジェクトバー、タブのカラードット等に反映）
- リポジトリ URL の紐付け (多対多)
- tmux ウィンドウの紐付け (サーバー名 + tmux ターゲット)
- Unit の紐付け (多対多。既定 Unit は `default_unit_id`)

### 3.3 Unit 管理 / Operations (実行ラン)

**Unit** はタスクの進め方（ワークフロー）と実行手段（ランタイム）の両方を1つのエンティティとして
持つ、「オペレーションを実行するチーム」。旧設計では Operation（振る舞い）と WorkerProfile（実行
ランタイム）に分離されていたが、最終形では Unit に統合されている（Issue #263 Refine B）。
所属サーバー・tmux セッションのみ引き続き `project_servers` / `tasks.server_name` が担う。

- Unit の CRUD (`/api/units`)
- 構成要素:
  - 実行ランタイム: Worker 種別・モデル・追加引数 (`worker_type`/`worker_model`/`worker_extra_args`)
  - UnitType（TOML 定義。フェーズ順序・シグナル能力・デフォルト Sidekick を宣言）
  - システムプロンプト (`system_prompt`)
  - Self-Review 最大試行回数 (`self_review_max_attempts`)
  - サブエージェント委譲設定 (`review_subagent` / `implement_subagent`)
  - `phase_config` -- フェーズ (`planning`/`implementing`/`reviewing`/`testing`/`pushing`) ごとの
    Sidekick パッケージ割当・有効/無効。省略時は各フェーズの既定 Sidekick (`isDefault: true` かつ
    そのフェーズの phase タグを持つもの) が使われる
- タスク実行 (`POST /api/units/:id/execute`)
- フォローアップ指示送信 (`POST /api/units/:id/follow-up`)
- タスク停止 (`POST /api/units/:id/stop`)
- プラン承認 / 差し戻し (`POST /api/units/:id/approve-plan`)
- 実行ログ取得 (`GET /api/units/:id/logs`)

**Operation** は Unit がタスクを遂行している**1回の実行ラン**を指す。DB に永続化される設定
エンティティではなく、`GET /api/operations` が返す「現在実行中の (unitId, taskId, target) の組」
一覧としてのみ観測できる（実行中状態は `ExecuteTaskUseCase` のメモリ上のランレジストリが保持し、
DB にステータスを持たない）。

プロジェクトは既定 Unit (`default_unit_id`) を持ち、タスク単位で `unit_id` により上書きできる。
実行サーバーも同様に `project_servers` の既定値をタスク単位の `server_name` で上書きできる。

### 3.4 タスク管理 (Tasks)

Unit に割り当てる作業単位。

- タスクの CRUD
- 属性:
  - プロジェクト紐付け (`project_id`)
  - Unit 紐付け (`unit_id`)
  - タイトル・説明
  - 優先度 (`priority`, デフォルト 0)
  - tmux ウィンドウ名 (`tmux_window`)
  - ソース (`local` / `github`)
  - ソース参照 (`source_ref`)
- ステータス: `open` → `running` (current_phase: planning → implementing → reviewing → testing → pushing) → `review` / `failed` (State Machine モード)、`open` → `in_progress` → `done` / `failed` (LLM モード)。`phase_review` はフェーズ承認待ち、`waiting_input` は質問待ち
- Worktree / ブランチ関連フィールド:
  - `worktree_path` -- Git worktree のファイルシステムパス
  - `worktree_branch` -- worktree のブランチ名 (`task/{id}-{slug}`)
  - `base_branch` -- 分岐元のブランチ名 (タスク作成時に指定可能)
  - `target_branch` -- push / PR 作成時のターゲットブランチ (タスク作成時に指定可能)
  - `summary` -- タスク完了時の実行サマリ（JSON）
  - `agent_session_id` -- エージェントのセッションID（セッション復帰用）
  - `skip_pr` -- PR作成をスキップするフラグ（pushing時にコミット+プッシュのみ）
  - `branch` -- ユーザー指定の作業ブランチ名（skipPr時に指定可能）
- タスクの作成/編集は専用フォーム画面 (Workspace タブ) で行い、GitHub/GitLab イシューをフォームから直接リンク可能
- フィルタリング: プロジェクト別、Unit 別、ステータス別
- タスク実行ログ取得

### 3.5 タスク自動実行 (ExecuteTaskUseCase)

Orchestrator-Worker パターンによるタスクの自動実行。

**実行フロー:**
1. tmux セッションの存在確認 (なければ作成)
2. Git worktree の作成 (`git worktree add` でタスク専用ブランチを作成)
   - 作成失敗時は `failed` 状態にしエラーをthrow（フォールバックなし）
   - `IWorktreeService` インターフェース経由でworktree操作（local/remote対応）
   - `WorktreeServiceFactory` がサーバータイプに応じた実装を返却
   - ユーザー指定ブランチ名（`branch`フィールド）がある場合、既存ブランチの存在確認を行い、あればチェックアウト、なければ新規作成
3. 既存の同名ウィンドウがあれば削除
4. 新しい tmux ウィンドウを作成・リネーム
5. タスクステータスを更新 (State Machine: `planning`, LLM: `in_progress`)
6. worktree ディレクトリへ `cd`
7. Worker コマンドを起動 (例: `claude --dangerously-skip-permissions`)
8. 非同期で実行ループ開始

**State Machine モード:**
フェーズ遷移に基づく実行:
1. `planning` -- 実行計画の策定
2. `phase_review` -- ユーザーによる計画承認 (approve / request changes)
3. `implementing` -- コード変更の実装
4. `reviewing` -- 実装結果のレビュー
5. `testing` -- テストの実行
6. `pushing` -- 変更の push / PR 作成
各フェーズのプロンプトは Phase Prompts 設定でカスタマイズ可能。
- `skip_pr` が有効な場合、pushing フェーズでPR作成をスキップ（コミット+プッシュのみ）
- `verifyPushCompleted` でPR存在チェックをスキップ（SHA一致のみで完了判定）

**LLM モード (最大30イテレーション):**
1. Orchestrator (Codex exec / LLM API) にコンテキストを送信して次のアクションを決定
2. アクション種別に応じて処理:
   - `prompt`: Worker にプロンプト送信 → 出力をポーリングで待機
   - `done`: タスクを完了
   - `error`: タスクを失敗
3. Worker 出力の安定検出 (3回連続同一出力で完了とみなす)
4. 確認プロンプトの自動応答 (`y/n`, `Are you sure?` 等のパターン検出)

**LLM セッション resume:**
- タスク再開時に実行ログから会話履歴を再構築
- オーケストレーター LLM にコンテキストを復元して中断地点から継続

**制約:**
- Worker 出力待機タイムアウト: 120秒
- ポーリング間隔: 3秒
- 安定判定: 3回連続 (9秒)
- 最大イテレーション: 30回 (LLM モード)
- 停滞検知: 5分間出力変化なしで警告
- AbortController による中断対応

### 3.6 Worker タイプ

| タイプ | 起動コマンド | 備考 |
|---|---|---|
| `claude` | `claude --dangerously-skip-permissions --permission-mode bypassPermissions` | Claude Code CLI |
| `codex` | `codex --dangerously-bypass-approvals-and-sandbox` | OpenAI Codex CLI |
| `generic` | 任意コマンド (デフォルト: `bash`) | カスタム |

全 Worker は tmux `send-keys` でプロンプト送信、`capture-pane` で出力取得を行う共通インターフェースを持つ。

Worker の起動コマンドは、ワーカータイプ・モデル・追加引数 (`worker_extra_args`) から導出される。また、作業をサブエージェントへ委譲でき、委譲先はワーカー種別に応じて分岐する。利用可能なエージェント／モデルは `modules/agents/` の `IAgentProvider` レジストリに一元定義され、委譲時には実装ルール (コーディング規約・設計/UI 原則・レビュー観点) を `PromptModuleLoader` が `harness/prompt-modules/` からファイルとして注入する。サブエージェント設定は Unit 単位で保持し (`review_subagent` / `implement_subagent`)、タスク単位で上書き可能。

### 3.6.1 azt-harness (Claude Code ネイティブ実行)

`harness/` 配下に同梱されるハーネス。State Machine モードの各フェーズを Claude Code の `/azt-*` スキルとして実行する。サーバーが tmux ペインにワーカーを起動してマーカー (`AZITO_DONE` / `QUESTIONS_JSON`) を検知する方式 (3.5) とは異なり、Claude Code 自身がスキルとしてフェーズを実行し、ユーザーと自然な対話でタスクを進める。

**構成要素:**

| 要素 | 配置 | 役割 |
|---|---|---|
| `/azt-*` スキル | `harness/skills/azt-{plan,implement,review,test,push}` | 各フェーズを実行。`GET /api/phase-prompts/:phase?render=skill&task_id=<id>` からプロンプトを取得し、応答の `nextPhase` で次フェーズへ連結。取得元のプロンプトはサーバー側で、タスクが属する Unit の `phase_config` が指す Sidekick パッケージから解決される |
| `/azt-sidekick` | `harness/skills/azt-sidekick` | 任意の Sidekick パッケージを1つ以上、名前指定で順に実行する（`GET /api/sidekicks/:name?render=1[&task_id=]`）。名前省略時は `GET /api/sidekicks` の一覧を提示 |
| `/azt-summon` | `harness/skills/azt-summon` | 会話中の作業を Sidekick パッケージとしてユーザー層に作成・編集する（新規: `POST /api/sidekicks`、既存の編集: `GET /api/sidekicks/:name` で現状取得後 `PUT /api/sidekicks/:name`。ビルトインは copy-on-write）。ペルソナ名（robin/falcon 等）を推奨 |
| `/azt-issue` | `harness/skills/azt-issue` | イシュー作成。実体は Sidekick `issue-default`（`harness/sidekicks/issue-default`）にあり、本スキルは `GET /api/sidekicks/issue-default?render=1` を取得して従う薄いラッパー |
| azt-mcp | `harness/skills/azt-mcp` | AZITO の REST API (プロジェクト・タスク・Unit・Operation・Sidekick・フェーズプロンプト) を MCP ツールとして公開 |
| prompt-modules | `harness/prompt-modules/` | コーディング規約・設計/UI 原則・レビュー観点・AI アンチパターン回避のルールファイル |
| Stop hook | `harness/hooks/azito-notify.sh` | エージェント完了時に `POST /api/webhooks/agent-done` を送信 (`AZITO_WEBHOOK_TOKEN` 共有) |

**`/azt-*` スキル:**

| スキル | フェーズ |
|---|---|
| `/azt-plan <task_id>` | planning |
| `/azt-implement <task_id>` | implementing |
| `/azt-review <task_id>` | reviewing |
| `/azt-test <task_id>` | testing |
| `/azt-push <task_id>` | pushing (最終) |
| `/azt-sidekick <name...> [task_id]` | 任意の Sidekick を1つ以上、名前指定で順に実行（phase タグ無しの汎用 Sidekick 含む） |
| `/azt-summon` | Sidekick の作成・編集（既存は GET 後に PUT で更新）。ペルソナ名を推奨 |
| `/azt-issue [description]` | イシュー作成（phase タグ無しの汎用 Sidekick `issue-default` のラッパー） |

**azt-mcp 提供ツール:** `azt_list_projects` / `azt_create_project` / `azt_list_tasks` / `azt_create_task` / `azt_list_units` / `azt_list_operations` / `azt_list_sidekicks` / `azt_render_sidekick` / `azt_get_phase_prompt`（`azt_get_phase_prompt` は互換API）。

**セットアップ:** `harness/setup.sh` が `harness/skills/azt-*` を `~/.claude/skills/`、`harness/prompt-modules/*.md` を `~/.claude/rules/` へシンボリックリンクし、azt-mcp (MCP サーバー) と Stop hook を `~/.claude/settings.json` へマージ登録する。`AZITO_URL` (既定 `http://localhost:3001`) と `AZITO_WEBHOOK_TOKEN` は引数または環境変数から解決する。

### 3.7 Orchestrator

タスクの進行を制御する LLM ベースの意思決定エンジン。

- LLM モードの実装: `CodexOrchestrator` (`codex exec` CLI を使用)。State Machine モードは `StateMachineOrchestrator` (`OrchestratorFactory` で選択)
- Codex CLI の `exec` サブコマンドを `--ephemeral` オプション付きで実行
- 出力は一時ファイル (`-o` オプション) 経由で取得
- タイムアウト: 120秒
- レスポンスは JSON (`action: prompt/done/error`)
- Markdown コードフェンスで囲まれた JSON にも対応

### 3.8 LLM プロバイダ管理 (Providers)

- プロバイダの CRUD
- デフォルトシード: OpenAI, Anthropic
- 対応タイプ: `openai` / `anthropic` / `custom`
- API キーのマスク表示 (先頭4文字 + 末尾4文字)
- 接続テスト機能
- Orchestrator 用モデル一覧 / Worker 用モデル一覧の提供

### 3.9 WebSocket 接続

#### ターミナルモード (デフォルト)
- パス: `ws://.../ws?server=<name>&target=<target>&cols=<n>&rows=<n>`
- ローカル: node-pty で `tmux attach-session` を起動
- リモート: SSH シェル経由で tmux attach
- リサイズ対応 (`{ type: "resize", cols, rows }`)

#### タスクログモード
- パス: `ws://.../ws?mode=task-logs&taskId=<id>`
- 実行ログを EventEmitter 経由でリアルタイム配信

#### 通知ストリーム
- パス: `ws://.../ws?mode=events`
- NotificationBus のイベント (タスク状態変化・エージェント完了等) をブラウザへプッシュ

### 3.10 フロントエンド画面

単一の統合 Workspace (`/workspace/:id`) がメイン UI であり、Projects / Tasks / Units / Sidekicks /
Operations / Settings はすべて Workspace 内のタブとして開かれる（個別の詳細ページではなく `TaskDetail`
等は廃止済み）。ルーティングはパス変更を検知してタブを開閉するのみで、各パスに対応する専用ページ
コンポーネントは持たない。

| パス | タブ内容 | 概要 |
|---|---|---|
| `/` | Terminals | サーバー選択 → tmux セッション/ウィンドウ/ペイン操作、ターミナル表示 |
| `/workspace/:id` / `/workspace/:id/:mode` | Workspace | プロジェクトワークスペース（メインUI） |
| `/servers` | Servers | サーバー一覧・詳細（依存インストール状況） |
| `/projects`, `/projects/new`, `/projects/:id` | Projects | プロジェクト一覧・作成・詳細（リポジトリ、ウィンドウ、既定 Unit 紐付け） |
| `/units`, `/units/new`, `/units/:id`, `/units/:id/edit` | Units | Unit 一覧・作成・詳細（設定・割当タスク・ログ）・編集 |
| `/operations` | Operations | 現在実行中の Operation（Unit の実行ラン）一覧 |
| `/sidekicks`, `/sidekicks/new`, `/sidekicks/:name/edit` | Sidekicks | Sidekick（スキルパッケージ）一覧（タグでグルーピング・絞り込み）・作成・編集 |
| `/tasks` | Tasks | タスク一覧・作成 |
| `/settings/:section` | Settings | LLM プロバイダ・ストレージ・通知等の設定 |

Workspace 内タブ／パネルとして表示される主なもの:

- タスク作成/編集フォーム (TaskFormView) -- Unit セレクトはプロジェクトの既定 Unit を事前選択
- サーバー詳細パネル (ServerDetailPanel) -- 依存インストール状況の可視化と導入導線
- トークン使用量ドロップダウン (UsageDropdown) -- ヘッダーから Claude / Codex 使用量を表示
- `TaskRefBadges` -- タスクID・Issue番号・PR番号のバッジ表示
- `StorageFilePreview` -- 画像・PDFプレビュー

**主要ファイル:**

| ファイル | 説明 |
|---|---|
| `packages/server/src/modules/git/WorktreeService.ts` | Git worktree management (LocalWorktreeService) |
| `packages/server/src/modules/git/RemoteWorktreeService.ts` | リモートサーバーのworktree操作 |
| `packages/server/src/modules/git/WorktreeServiceFactory.ts` | サーバータイプに応じたWorktreeService実装の選択 |
| `packages/server/src/modules/tasks/recovery/RecoverStuckTasksUseCase.ts` | 起動時の非終端タスク自動復旧 |

## 4. 外部インターフェース

### 4.1 REST API 一覧

#### Servers
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/servers` | サーバー一覧 |
| POST | `/api/servers` | サーバー作成 |
| PUT | `/api/servers/:name` | サーバー更新 |
| DELETE | `/api/servers/:name` | サーバー削除 |
| GET | `/api/servers/:name/sessions` | tmux セッション一覧 |
| POST | `/api/servers/:name/sessions` | セッション作成 |
| POST | `/api/servers/:name/sessions/:session/windows` | ウィンドウ作成 |
| POST | `/api/servers/:name/sessions/:session/windows/:window/panes` | ペイン分割 |
| DELETE | `/api/servers/:name/sessions/:session` | セッション削除 |
| DELETE | `/api/servers/:name/panes/:target` | ペイン削除 |
| PUT | `/api/servers/:name/sessions/:session/rename` | セッションリネーム |
| PUT | `/api/servers/:name/windows/:target/rename` | ウィンドウリネーム |
| PUT | `/api/servers/:name/panes/:target/rename` | ペインリネーム |
| GET | `/api/servers/:name/panes/:target/capture` | ペインキャプチャ |
| POST | `/api/servers/:name/panes/:target/send-keys` | キー送信 |
| GET | `/api/servers/:name/status` | サーバーステータス確認 |
| GET | `/api/servers/:name/editor-uri` | 外部エディタ URI 取得 (VS Code / Zed) |
| GET | `/api/servers/:name/files/download` | ファイルダウンロード (50MB 制限) |
| GET | `/api/servers/:name/files/content` | ファイル内容取得 (画像 Base64 対応) |
| GET | `/api/servers/:name/install-status` | 依存 (tmux / Node.js / harness / Tailscale) のインストール状況 |
| POST | `/api/servers/:name/agent/install` | エージェントのインストール |
| POST | `/api/servers/:name/harness/install` | harness のインストール |

#### Projects
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/projects` | プロジェクト一覧 |
| POST | `/api/projects` | プロジェクト作成 |
| GET | `/api/projects/:id` | プロジェクト詳細 |
| PUT | `/api/projects/:id` | プロジェクト更新 |
| DELETE | `/api/projects/:id` | プロジェクト削除 |
| POST | `/api/projects/:id/repositories` | リポジトリ追加 |
| DELETE | `/api/projects/:id/repositories/:rid` | リポジトリ削除 |
| POST | `/api/projects/:id/windows` | ウィンドウ追加 |
| DELETE | `/api/projects/:id/windows/:wid` | ウィンドウ削除 |
| POST | `/api/projects/:id/windows/session` | セッション内全ウィンドウ一括登録 |
| GET | `/api/projects/:id/remote-pulls` | プルリクエスト / マージリクエスト一覧 |
| GET | `/api/projects/:id/remote-pulls/:number` | プルリクエスト / マージリクエスト詳細 |

#### Units
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/units` | Unit 一覧 |
| POST | `/api/units` | Unit 作成 |
| GET | `/api/units/:id` | Unit 詳細 |
| PUT | `/api/units/:id` | Unit 更新 |
| DELETE | `/api/units/:id` | Unit 削除 |
| POST | `/api/units/:id/execute` | タスク実行開始 |
| POST | `/api/units/:id/follow-up` | フォローアップ指示送信 (phaseNames 対応、phaseIds は互換維持) |
| POST | `/api/units/:id/stop` | タスク実行停止 |
| POST | `/api/units/:id/approve-plan` | プラン承認 / 差し戻し |
| GET | `/api/units/:id/logs` | 実行ログ |

#### Operations
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/operations` | 現在実行中の Operation（Unit の実行ラン）一覧。DB には永続化されない |

#### Tasks
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/tasks` | タスク一覧 (フィルタ: `project_id`, `status`, `unit_id`) |
| POST | `/api/tasks` | タスク作成 |
| GET | `/api/tasks/:id` | タスク詳細 |
| PUT | `/api/tasks/:id` | タスク更新 |
| DELETE | `/api/tasks/:id` | タスク削除（関連リソースのクリーンアップ: tmuxウィンドウ・worktree・一時ファイル） |
| GET | `/api/tasks/:id/logs` | タスク実行ログ |
| GET | `/api/tasks/:id/health` | タスクの停滞状態チェック |
| POST | `/api/tasks/:id/retry` | 停滞タスクのリトライ |
| POST | `/api/tasks/:id/answer` | 構造化質問 (QUESTIONS_JSON) への回答送信 |
| POST | `/api/tasks/:id/recover-session` | ペイン消失時のエージェントセッション復帰 |
| POST | `/api/tasks/:id/archive` | タスクのアーカイブ |
| POST | `/api/tasks/:id/restore` | アーカイブしたタスクの復元 |

#### Providers
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/providers` | プロバイダ一覧 (APIキーはマスク) |
| POST | `/api/providers` | プロバイダ作成 |
| PUT | `/api/providers/:id` | プロバイダ更新 |
| DELETE | `/api/providers/:id` | プロバイダ削除 |
| POST | `/api/providers/:id/test` | 接続テスト |
| GET | `/api/providers/models/:type` | Orchestrator モデル一覧 |
| GET | `/api/workers/types` | Worker タイプ一覧 |
| GET | `/api/workers/models/:type` | Worker モデル一覧 |

#### Phase Prompts
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/phase-prompts` | フェーズプロンプト一覧取得 |
| PUT | `/api/phase-prompts` | フェーズプロンプト更新 |
| GET | `/api/phase-prompts/:phase` | 単一フェーズのプロンプト取得 (`?render=skill&task_id=` でレンダリング済み本文) |

#### Sidekicks
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/sidekicks` | Sidekick パッケージ一覧 (builtin/user 2層マージ) |
| GET | `/api/sidekicks/:name` | Sidekick 取得 (`?render=1[&task_id=]` でレンダリング済み本文) |
| POST | `/api/sidekicks` | ユーザー層に新規作成 |
| PUT | `/api/sidekicks/:name` | 更新 (builtin は copy-on-write でユーザー層へ) |
| DELETE | `/api/sidekicks/:name` | ユーザー層コピーの削除 (builtin へ戻す / user 専用は完全削除) |

#### Storage
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/storage/settings` | ストレージ設定取得 |
| PUT | `/api/storage/settings` | ストレージ設定更新 |
| GET | `/api/projects/:id/storage` | プロジェクトのファイル一覧 |
| POST | `/api/projects/:id/storage` | ファイルアップロード |
| DELETE | `/api/projects/:id/storage/:filename` | ファイル削除 |
| GET | `/api/projects/:id/storage/:filename/raw` | ファイルプロキシ取得 |

#### Notifications
| Method | Path | 説明 |
|---|---|---|
| POST | `/api/notifications/subscribe` | プッシュ通知サブスクリプション登録 |
| POST | `/api/notifications/unsubscribe` | プッシュ通知サブスクリプション解除 |
| POST | `/api/notifications/test` | テスト通知の送信 |

#### Usage
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/usage` | Claude / Codex のトークン使用量集計 (ローカル JSONL セッションから収集) |

#### Webhooks
| Method | Path | 説明 |
|---|---|---|
| POST | `/api/webhooks/agent-done` | エージェント完了通知の受信 (`AZITO_WEBHOOK_TOKEN` で認証、ボディをバリデーション) |
| POST | `/api/webhooks/agent-activity` | Claude Code フック (`UserPromptSubmit`/`Stop`) からのエージェント活動シグナル受信 (同トークン) |

### 4.2 WebSocket

| パス | パラメータ | 説明 |
|---|---|---|
| `/ws` | `server`, `target`, `cols`, `rows` | ターミナル接続 (デフォルトモード) |
| `/ws` | `mode=task-logs`, `taskId` | タスクログのリアルタイムストリーミング |
| `/ws` | `mode=events` | 通知ストリーム (NotificationBus) |
| `/ws/supervisor` | (Authorization ヘッダー) | tui-supervisor の接続受け口 |
| `/ws` (agent プロセス側) | `mode=file-tail`, `path` | リモートファイル末尾のストリーミング (ハブの `AgentPaneStream` が利用) |

## 5. 設定値・環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `3001` | サーバーリスンポート |
| `SSH_AUTH_SOCK` | (OS依存) | SSH エージェントソケット |
| `HOME` | (OS依存) | SSH 鍵・設定ファイルの検索パス |
| `AZITO_WEBHOOK_TOKEN` | (なし) | エージェント完了 Webhook の認証トークン (サーバーと Claude Code 設定で共有が必須) |

### 設定ファイル
| ファイル | 説明 |
|---|---|
| `packages/server/.env` | 開発時の環境変数 (git-ignored, `tsx watch --env-file-if-exists` で自動読み込み) |
| `~/.ssh/config` | SSH 接続先の解決 (HostName, Port, User, IdentityFile) |
| `~/.claude/settings.json` | azt-harness の `setup.sh` が azt-mcp (MCP サーバー) と Stop hook をマージ登録 |

### データベースファイル
- パス: プロジェクトルート直下の `data.db`
- モード: WAL (Write-Ahead Logging)
- 外部キー: 有効

## 6. 主要な処理フロー

### 6.1 ターミナル接続フロー

```
1. ブラウザ → WebSocket 接続 (/ws?server=xxx&target=yyy)
2. サーバー側でサーバー種別を判定
3a. ローカル: node-pty で tmux attach-session を起動
3b. リモート: SSH接続 → シェル起動 → tmux attach-session 実行
4. 双方向ストリーム確立 (入力→tmux、出力→ブラウザ)
5. リサイズイベントはJSON形式で送信
```

### 6.2 タスク自動実行フロー

```
1. POST /api/units/:id/execute { taskId }
2. Unit・Task・Server のバリデーション
3. tmux セッション・ウィンドウのセットアップ
4. 作業ディレクトリへ移動、Worker コマンド起動
5. 実行ループ開始 (非同期):
   a. Orchestrator (codex exec) が次のアクションを決定
   b. prompt → Worker にキー送信 → 出力をポーリング
   c. 確認プロンプト検出 → 自動承認 (y + Enter)
   d. done/error → タスクステータス更新、ループ終了
6. 実行中の全ステップを execution_log テーブルに記録
```

### 6.3 SSH 永続シェル

リモートサーバーへのコマンド実行は、永続的な SSH シェル接続をプールして再利用する。

```
1. ホストエイリアスでプールを検索
2. 既存接続があればそのまま使用
3. なければ新規 SSH 接続 → シェル起動 → プロンプト無効化
4. コマンド実行はマーカー文字列 (AGENTMGR_B/E) で出力を区切る
5. タイムアウト: 15秒
6. シェルが閉じたら自動でプールから除去
```

## 7. データベーススキーマ

| テーブル | 主な用途 |
|---|---|
| `servers` | サーバー登録 (name PK, type, host) |
| `projects` | プロジェクト管理 (icon, color, default_unit_id カラムを含む) |
| `project_repositories` | プロジェクトとリポジトリ URL の紐付け |
| `project_windows` | プロジェクトと tmux ウィンドウの紐付け |
| `project_servers` | プロジェクトとサーバーの紐付け |
| `llm_providers` | LLM プロバイダ設定 |
| `units` | Unit 定義 (system_prompt, self_review_max_attempts, サブエージェント委譲設定, phase_config, unit_type に加え、worker_type/worker_model/worker_extra_args の実行ランタイムも統合。旧 `operations` + `worker_profiles` の後継。`operations` テーブルは無い — Operation は実行時のメモリ上の状態のみ) |
| `tasks` | タスク管理 (unit_id, server_name, worktree_path, worktree_branch, base_branch, target_branch, summary, agent_session_id, skip_pr, branch, サブエージェント設定上書きカラムを含む) |
| `execution_log` | タスク/Unit の実行ログ (unit_id カラム) |
| `windows` / `task_windows` | tmux ウィンドウの追跡・タスクとの紐付け |
| `phase_prompts` | フェーズプロンプト定義 (フェーズごとのカスタムプロンプト。Sidekick パッケージへ移行中) |
| `storage_settings` | ファイルストレージ (MinIO) 設定 |
| `push_subscriptions` | PWA プッシュ通知サブスクリプション |
| `agent_turns` / `agent_turn_events` / `agent_watches` | エージェント活動シグナルの記録 |

## 8. 既知の前提・制約

### 実装から確認できた事実
- サーバーは tmux がインストールされていることが前提
- ローカルサーバーでのターミナル接続は node-pty 経由で tmux attach
- リモートサーバーへの SSH は `~/.ssh/config` を自動解析し、鍵認証・エージェント認証に対応
- LLM モードの Orchestrator は `codex` タイプのみ実装 (Codex CLI の `exec` コマンドに依存)。State Machine モードは `StateMachineOrchestrator` がフェーズ遷移を制御する
- Worker の完了判定は、State Machine モードではマーカー (シグナルファイル) 検出、LLM モードでは「出力が3回連続で変化しなかった」ヒューリスティックで行う
- 確認プロンプトの自動応答は正規表現パターンマッチで行う
- データベーススキーマの初期化・マイグレーションはアプリケーション起動時にマイグレーションファイル (`shared/db/migrations/`) を順次適用して行う
- 静的ファイル配信はルートの `public/` を参照する設定だが、リポジトリには含まれない (本番ビルド成果物の配置先)
- 新フロントエンド (React SPA) は別途 Vite devサーバーで開発する想定
- API キーはデータベースに平文で保存される (表示時のみマスク)

### 推測・未確定事項
- **認証・認可**: 実装されていない。ローカルネットワーク内での利用を想定していると推測
- **本番デプロイ方法**: 明示的な本番ビルド・デプロイ手順がない。React SPAのビルド成果物をFastifyで配信する構成は未整備
- **Orchestrator の拡張**: State Machine モード (フェーズベース) と LLM モード (直接 API 呼び出し) の2つが利用可能
- **Worker の起動コマンド**: Unit の `worker_type` / `worker_model` / `worker_extra_args` から `buildWorkerLaunchCommand` で導出される (レジストリ未登録の型は `extraArgs` をコマンドとして扱う)
- **エラーリカバリ**: 停滞検知 (5分間出力変化なし) とリトライ機構が実装済み。起動時の非終端タスク自動復旧 (`RecoverStuckTasksUseCase`) あり
- **ログのローテーション/削除**: execution_log テーブルの肥大化に対する対策は見当たらない
- **テスト**: vitest によるユニットテストが存在 (1000+ テスト、75 ファイル)
- **CI/CD**: CI/CD 設定がない
