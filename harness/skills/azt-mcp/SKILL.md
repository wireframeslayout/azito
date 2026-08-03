---
name: azt-mcp
description: Claude Code から azito の API を操作（プロジェクト追加・タスク登録・サイドキック一覧など）できる MCP サーバーを提供するスキル。
allowed-tools: mcp__azt-mcp__azt_list_projects, mcp__azt-mcp__azt_create_project, mcp__azt-mcp__azt_list_tasks, mcp__azt-mcp__azt_create_task, mcp__azt-mcp__azt_list_units, mcp__azt-mcp__azt_list_operations, mcp__azt-mcp__azt_list_sidekicks, mcp__azt-mcp__azt_render_sidekick, mcp__azt-mcp__azt_get_phase_prompt
---

## 概要

azito API に対して読み書き操作を行う MCP ツール群を提供します。
プロジェクト・タスク・Unit（ワークフロー定義＋実行ランタイム）・Sidekick（スキルパッケージ）の一覧取得と
作成、フェーズプロンプト・Sidekick 本文の取得ができます。Operation は Unit がタスクを遂行する
1回の実行ラン（実行中インスタンス）を指します。

## 提供ツール

| ツール | 説明 |
|--------|------|
| `azt_list_projects` | プロジェクト一覧を取得 |
| `azt_create_project` | プロジェクトを新規作成（name 必須） |
| `azt_list_tasks` | タスク一覧を取得（project_id/status/unit_id でフィルタ可） |
| `azt_create_task` | タスクを新規作成（project_id, title 必須。unit_id はワークフロー自動実行時に推奨） |
| `azt_list_units` | Unit（フェーズ→Sidekick マッピング＋実行ランタイムを持つワークフロー定義）一覧を取得 |
| `azt_list_operations` | 現在実行中の Operation（Unit の実行ラン）一覧を取得 |
| `azt_list_sidekicks` | Sidekick（SKILL.md + scripts/ のスキルパッケージ）一覧を取得 |
| `azt_render_sidekick` | 指定 Sidekick のテンプレート展開済み本文を取得（name 必須、task_id 任意） |
| `azt_get_phase_prompt` | フェーズプロンプトを取得（互換API。task_id 指定でタスク固有プロンプト） |

## セットアップ

初回利用前に以下が必要です:

```bash
# 1. MCPサーバーの依存パッケージをインストール
cd ~/.claude/skills/azt-mcp/mcp-server
npm install

# 2. 環境変数を設定（~/.claude/settings.json の mcpServers 内で env として渡す）
```

`~/.claude/settings.json` の `mcpServers` に以下を追加:

```json
{
  "mcpServers": {
    "azt-mcp": {
      "command": "node",
      "args": ["/home/youruser/.claude/skills/azt-mcp/mcp-server/index.js"],
      "env": {
        "AZITO_URL": "http://your-hub-host:3001"
      }
    }
  }
}
```

> リモートサーバーでは `localhost` ではなく、hub に到達可能なホスト名または IP を指定します。`harness/setup.sh` 経由でインストールすると自動設定されます。

詳細は `README.md` を参照してください。
