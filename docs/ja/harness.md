# azt-harness ガイド

## azt-harness とは

azt-harness（AZITO Harness）は、AZITO の Sidekick モードを **Claude Code のネイティブなスキル**として実行するためのハーネスです。`harness/` ディレクトリにまとまっており、`setup.sh` 一発で Claude Code 環境（`~/.claude/`）へ組み込めます。

従来の Sidekick モードは、AZITO サーバーが tmux ペインへワーカーを起動し、`AZITO_DONE` / `QUESTIONS_JSON` などのマーカーをペイン出力から検知してフェーズを進めていました。azt-harness はこの仕組みを置き換え、**Claude Code 自身がスキルとしてフェーズを実行**します。マーカーに依存せず、Claude Code がユーザーと自然に対話しながらタスクを進められるのが最大の特長です。

azt-harness は次の4つの要素で構成されます。

| 要素 | 配置 | 役割 |
|---|---|---|
| `/azt-*` スキル | `harness/skills/azt-*` | タスクの各フェーズ（plan/implement/review/test/push）の実行、任意 Sidekick の実行（azt-sidekick）・作成/編集（azt-summon）、イシュー作成（azt-issue）、複数タスクのバッチ自動実行（azt-mission） |
| azt-mcp | `harness/skills/azt-mcp` | AZITO の REST API を MCP ツールとして公開（プロジェクト・タスク・Unit・Operation・Sidekick 操作） |
| prompt-modules | `harness/prompt-modules/` | コーディング規約・設計原則・レビュー観点・UI 原則のルールファイル |
| Stop hook | `harness/hooks/azito-notify.sh` | エージェント完了時に AZITO へ Webhook 通知を送る |

## `/azt-*` スキル

各スキルは AZITO の API（`GET /api/phase-prompts/:phase?render=skill&task_id=<id>`）からフェーズ固有のプロンプトを取得し、その指示に従って作業を実行します。応答 JSON の `nextPhase` フィールドが次フェーズのスキル名を示し、フェーズ完了後に次のスキルが案内されます。

| スキル | フェーズ | 内容 |
|---|---|---|
| `/azt-plan <task_id>` | planning | タスクの実行計画を策定 |
| `/azt-implement <task_id>` | implementing | コード変更を実装 |
| `/azt-review <task_id>` | reviewing | 実装結果をレビュー |
| `/azt-test <task_id>` | testing | テストを実行・確認 |
| `/azt-push <task_id>` | pushing | 変更を push し PR を作成（最終フェーズ） |
| `/azt-sidekick <name...> [task_id]` | 任意 | 任意の Sidekick パッケージを1つ以上、名前指定で順に実行（`GET /api/sidekicks/:name?render=1`。名前省略時は一覧を提示） |
| `/azt-summon` | - | 会話中の作業を Sidekick パッケージとしてユーザー層に作成・編集（新規: `POST /api/sidekicks`、既存の更新: `PUT /api/sidekicks/:name`）。ペルソナ名（robin/falcon 等）を推奨 |
| `/azt-issue [description]` | (phase タグなし) | イシュー作成。実体は Sidekick `issue-default` にあり、本スキルはそれを取得して従う薄いラッパー |
| `/azt-mission [--parallel] <taskId\|#issue>...` | - | 複数の azito タスク/GitHub Issue を1つの「ミッション」として直列（または並列）に自動実行。ミッション統合ブランチ作成→各タスクの実行監視（計画承認・質問回答・異常復旧）→各 PR のレビュー・マージ→最終のミッション→ベース PR 作成までを一括で行う |
| `/azt-link <task_id> <issue_url>` | - | タスクに GitHub/GitLab イシューをリンク（`source` / `source_ref` を設定） |
| `/azt-prepare <task_id>` | - | タスクの作業環境を準備。作業ディレクトリ・ブランチを確認し、worktree を作成して移動、作業スタンバイまで行う |

フェーズのプロンプトは、タスクが属する Unit（フェーズ→Sidekick マッピングと実行ランタイムを持つワークフロー定義）の `phase_config` が指す Sidekick パッケージ（既定は phase タグに対応する `isDefault` の Sidekick、通常は `harness/sidekicks/<phase>-default`）からサーバー側で解決・レンダリングされます。

### 使い方

```
/azt-plan <task_id>
```

各スキルは `task_id`（数値）を引数に取ります。AZITO のベース URL は環境変数 `AZITO_URL` から解決します。フェーズが完了すると、`nextPhase` に従って次のフェーズスキルが案内されるため、順に実行していくことで plan → implement → review → test → push の一連のフローを Claude Code 上で完結できます。

## azt-mcp（MCP サーバー）

azt-mcp は、Claude Code から AZITO の REST API を MCP ツールとして直接操作できるようにする MCP サーバーです。スキルでタスクを実行する前に、プロジェクトやタスクの作成・一覧取得を会話の中から行えます。

| ツール | HTTP | 説明 |
|---|---|---|
| `azt_list_projects` | `GET /api/projects` | プロジェクト一覧を取得 |
| `azt_create_project` | `POST /api/projects` | プロジェクトを新規作成（name 必須） |
| `azt_list_tasks` | `GET /api/tasks` | タスク一覧を取得（project_id/status/unit_id でフィルタ可） |
| `azt_create_task` | `POST /api/tasks` | タスクを新規作成（project_id, title 必須。ワークフローを自動実行するタスクでは unit_id の指定を推奨） |
| `azt_list_units` | `GET /api/units` | Unit（フェーズ→Sidekick マッピング＋実行ランタイムを持つワークフロー定義）一覧を取得 |
| `azt_list_operations` | `GET /api/operations` | 現在実行中の Operation（Unit の実行ラン）一覧を取得 |
| `azt_list_sidekicks` | `GET /api/sidekicks` | Sidekick（SKILL.md + scripts/ のスキルパッケージ）一覧を取得 |
| `azt_render_sidekick` | `GET /api/sidekicks/:name?render=1` | 指定 Sidekick のテンプレート展開済み本文を取得（task_id 任意） |
| `azt_get_phase_prompt` | `GET /api/phase-prompts/:phase` | フェーズプロンプトを取得（互換API） |

## prompt-modules（ルールファイル）

`harness/prompt-modules/` は、サブエージェントに渡す実装ルールをファイルとして管理します。フォールバック濫用や配線忘れといった AI アンチパターンを防ぎ、プロジェクトの規約に沿った成果物を担保します。

- `rules/common.md` -- 構造・命名・エラー処理・設計原則の共通ルール
- `rules/typescript.md` -- TypeScript / React のルール
- `rules/php.md` -- PHP / Laravel のルール
- `rules/ai-antipattern.md` -- AI アンチパターン（フォールバック濫用・スコープクリープ・配線忘れ・デッドコード）の回避
- `software-design-principles.md` -- ソフトウェア設計原則
- `review-perspectives.md` -- レビュー観点
- `ui-design-principles.md` -- UI デザイン原則

`setup.sh` はこれらを `~/.claude/rules/` へリンクし、Claude Code のサブエージェントプロンプトへ注入できる状態にします。

## Stop hook（完了通知）

`harness/hooks/azito-notify.sh` は Claude Code の Stop hook として登録され、エージェントの作業が完了したタイミングで AZITO へ Webhook 通知（`POST /api/webhooks/agent-done`）を送ります。通知には共有シークレット `AZITO_WEBHOOK_TOKEN` が必要で、トークンが未設定の場合は何もせず終了します。

> **注意:** Webhook 通知を有効にするには、AZITO サーバーと hook の双方で同じ `AZITO_WEBHOOK_TOKEN` を共有する必要があります。

## セットアップ

`harness/setup.sh` は、スキル・ルール・MCP サーバー・hook を Claude Code 環境（`~/.claude/`）へ一括で組み込みます。

```bash
cd harness
./setup.sh --azito-url http://localhost:3001 --webhook-token <token> --ui-token <token>
```

setup.sh は次の処理を行います。

1. **Skills** -- `harness/skills/azt-*` を `~/.claude/skills/` へシンボリックリンク
2. **Rules** -- `harness/prompt-modules/*.md` を `~/.claude/rules/` へシンボリックリンク
3. **Settings** -- `~/.claude/settings.json` に azt-mcp（MCP サーバー）と Stop hook をマージ登録

`AZITO_URL`（既定値 `http://localhost:3001`）と `AZITO_WEBHOOK_TOKEN` は環境変数からも解決します。既存のリンク・設定がある場合はスキップまたは更新され、安全に再実行できます。ただし `--ui-token`（`AZITO_UI_TOKEN`）は azt-mcp の認証に必須で、省略はできません。

Codex CLI がインストールされている環境（`codex` コマンドまたは `~/.codex` が存在）では、同じ skills / rules を `~/.codex/` 配下にも配置し、`codex mcp add` で azt-mcp を登録します。Claude Code と Codex の両方から同じハーネスを利用できます。

### azt-mcp の初回準備

azt-mcp を利用するには、MCP サーバーの依存パッケージをインストールしておきます。

```bash
cd ~/.claude/skills/azt-mcp/mcp-server
npm install
```

`setup.sh` が `~/.claude/settings.json` の `mcpServers` に azt-mcp を登録します。認証は必須で、`setup.sh` に `--ui-token` を渡すと `AZITO_UI_TOKEN` が env に自動登録され、`Authorization: Bearer <token>` ヘッダーとして送信されます。

## インストール状況の確認

AZITO のサーバー詳細パネルは、各サーバーの依存（tmux / Node.js / **harness** / Tailscale 等）のインストール状況を可視化します。harness が未インストールの場合は「azt-harness not installed」と表示され、導入導線が示されます。
