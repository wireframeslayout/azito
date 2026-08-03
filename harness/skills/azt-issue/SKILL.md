---
name: azt-issue
description: イシューを作成する。ユーザーとの対話で要件を明確化し、sonnet級エージェントが実装可能な詳細度で GitHub Issue または azito タスクに登録する。
allowed-tools: Bash, Read, AskUserQuestion
user_invocable: true
argument-hint: [issue description (optional)]
---

<instructions>

# azt-issue -- イシュー作成スキル（ラッパー）

イシュー作成の実装手順は Sidekick パッケージ `issue-default`
（`harness/sidekicks/issue-default`）に集約されている。このスキルは薄いラッパーであり、
`issue-default` のレンダリング済み本文を取得し、その指示にそのまま従う。

## 引数

- 引数（任意）: イシューの概要テキスト。省略時はユーザーに対話でヒアリングする。

## Step 1: issue-default の内容を取得する

```bash
curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/sidekicks/issue-default?render=1"
```

- HTTP 404/500 等のエラー: レスポンスの `error` フィールドの内容をそのままユーザーに提示して終了する
- 成功時: レスポンス JSON の `prompt` フィールドがこのスキルの実行指示内容

## Step 2: 取得した指示に従って実行する

`prompt` の内容を実行指示として扱い、そのまま実行する。ユーザーから引数（イシュー概要）が
与えられている場合は、`issue-default` の要件ヒアリングステップへの入力として渡す。

質問がある場合はユーザーに直接質問する（AskUserQuestion ツールが利用可能ならそれを使う）。

</instructions>
