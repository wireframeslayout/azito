# azt-mcp — azito API MCP サーバー

Claude Code から azito の REST API を MCP ツールとして操作できるスキル。

## 提供ツール

| ツール | HTTP | 説明 |
|--------|------|------|
| `azt_list_projects` | `GET /api/projects` | プロジェクト一覧 |
| `azt_create_project` | `POST /api/projects` | プロジェクト新規作成 |
| `azt_list_tasks` | `GET /api/tasks` | タスク一覧（フィルタ可） |
| `azt_create_task` | `POST /api/tasks` | タスク新規作成 |
| `azt_list_units` | `GET /api/units` | Unit（フェーズ→Sidekick マッピング＋実行ランタイムを持つワークフロー定義）一覧 |
| `azt_list_operations` | `GET /api/operations` | 現在実行中の Operation（Unit の実行ラン）一覧 |
| `azt_list_sidekicks` | `GET /api/sidekicks` | Sidekick（SKILL.md + scripts/ のスキルパッケージ）一覧 |
| `azt_render_sidekick` | `GET /api/sidekicks/:name?render=1` | Sidekick のテンプレート展開済み本文を取得 |
| `azt_get_phase_prompt` | `GET /api/phase-prompts/:phase` | フェーズプロンプト取得（互換API） |

## セットアップ

### 1. 依存パッケージのインストール

```bash
cd ~/.claude/skills/azt-mcp/mcp-server
npm install
```

### 2. 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `AZITO_URL` | 必須 | azito サーバーのベースURL（例: `http://localhost:3001`） |
| `AZITO_UI_TOKEN` | 必須 | API 認証に必須。`Authorization: Bearer <token>` ヘッダーとして送信される |

> **リモートサーバーでの設定**: `http://localhost:3001` ではなく、hub の Tailscale DNS 名や IP アドレスベースの URL（例: `http://hub-machine.tailnet-xxxx.ts.net:3001`）を指定してください。AZITO の UI からハーネスをインストールすると自動設定されます。

### 3. Claude Code への登録

`~/.claude/settings.json` の `mcpServers` に以下を追加してください。
`~` はそのまま使わず、フルパスで記述してください。

```json
{
  "mcpServers": {
    "azt-mcp": {
      "command": "node",
      "args": ["/home/youruser/.claude/skills/azt-mcp/mcp-server/index.js"],
      "env": {
        "AZITO_URL": "http://localhost:3001",
        "AZITO_UI_TOKEN": "your-token-here"
      }
    }
  }
}
```

## ツール詳細

### `azt_list_projects`

azito のプロジェクト一覧を返します。

引数: なし

### `azt_create_project`

azito に新しいプロジェクトを作成します。

| 引数 | 型 | 必須 | 説明 |
|------|----|------|------|
| `name` | string | 必須 | プロジェクト名 |
| `slug` | string | 任意 | URLスラッグ（省略時は name から自動生成） |
| `description` | string | 任意 | プロジェクトの説明 |
| `sidekick_prompt` | string | 任意 | プロジェクト固有のサイドキックプロンプト |

### `azt_list_tasks`

タスク一覧を返します。フィルタは1つのみ指定可能（複数指定時は project_id が優先）。

| 引数 | 型 | 必須 | 説明 |
|------|----|------|------|
| `project_id` | number | 任意 | プロジェクトIDでフィルタ |
| `status` | string | 任意 | ステータスでフィルタ（open / in_progress / done 等） |
| `unit_id` | number | 任意 | UnitIDでフィルタ |

### `azt_create_task`

新しいタスクを作成します。

| 引数 | 型 | 必須 | 説明 |
|------|----|------|------|
| `project_id` | number | 必須 | プロジェクトID |
| `unit_id` | number | 任意 | UnitID（ワークフロー定義＋実行ランタイム。`azt_list_units` で取得。ワークフローを自動実行するタスクでは指定を推奨） |
| `title` | string | 必須 | タスクタイトル |
| `description` | string | 任意 | タスクの詳細説明 |
| `priority` | number | 任意 | 優先度（数値が小さいほど高優先） |

### `azt_list_units`

Unit（フェーズ→Sidekick マッピング＋実行ランタイムを持つワークフロー定義）一覧を返します。
`azt_create_task` の `unit_id` を選ぶ際に使います。

引数: なし

### `azt_list_operations`

現在実行中の Operation（ある Unit がタスクを遂行している実行ラン）一覧を返します。
各要素は `unitId` / `taskId` / `target`（tmux ターゲット）を含みます。

引数: なし

### `azt_list_sidekicks`

Sidekick（`SKILL.md` + 任意の `scripts/` からなるスキルパッケージ）一覧を返します。
各要素は `name` / `description` / `tags` / `isDefault` / `layer` などを含みます（本文は含まない。
`tags` のうち planning/implementing/reviewing/testing/pushing は phase タグとして特別扱い）。

引数: なし

### `azt_render_sidekick`

指定した Sidekick のテンプレート変数展開済み本文を取得します。

| 引数 | 型 | 必須 | 説明 |
|------|----|------|------|
| `name` | string | 必須 | Sidekick 名 |
| `task_id` | number | 任意 | タスクID。指定すると `{{task.*}}`/`{{project.*}}` がそのタスクの文脈で展開される。未指定時は `{{sidekick.*}}` のみ展開される |

### `azt_get_phase_prompt`

フェーズプロンプトを取得します（互換API）。`task_id` を指定するとタスク固有の内容（テンプレート変数を展開済み）が返ります。
内部的には、タスクが属する Unit の `phase_config` が指す Sidekick から解決されます。

| 引数 | 型 | 必須 | 説明 |
|------|----|------|------|
| `phase` | string | 必須 | フェーズ名（planning / implementing / reviewing 等） |
| `task_id` | number | 任意 | タスクID。指定するとタスク固有プロンプトを返す |

## エラー処理

- `AZITO_URL` が未設定の場合、ツール呼び出し時にエラーメッセージを返します（起動時クラッシュなし）
- azito API が非2xxを返した場合、HTTPステータスとエラーメッセージを含むエラーを返します
- ネットワークエラーは握りつぶさず、呼び出し元に伝わります
