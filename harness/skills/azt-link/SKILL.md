---
name: azt-link
description: azito タスクに GitHub/GitLab イシューをリンクする。タスクIDとイシューURLを引数に取り、source/source_ref を設定する。
allowed-tools: Bash, AskUserQuestion
user_invocable: true
argument-hint: [task_id] [issue_url]
---

<instructions>

# azt-link — azitoタスクへのイシューリンク

## 引数

- `task_id`: azito のタスクID（数値）
- `issue_url`: GitHub または GitLab のイシューURL

## Step 1: 引数パース

第1引数を `task_id`、第2引数を `issue_url` として取得する。

```bash
TASK_ID="$1"
ISSUE_URL="$2"
```

どちらかが不足している場合は、エラーを提示して終了する。

## Step 2: タスク存在確認

以下でタスクを GET する。失敗した場合は、エラーを提示して終了する。

```bash
TASK_JSON="$(curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/tasks/${TASK_ID}")"
```

## Step 3: URL パース

bash の正規表現で `ISSUE_URL` を判定する。

- GitHub: `^https://github\.com/([^/]+/[^/]+)/issues/([0-9]+)` に一致する場合、`source=github`、`source_ref=<match1>#<match2>`
- GitLab: `^https://[^/]+/(.+)/-/issues/([0-9]+)` に一致する場合、`source=gitlab`、`source_ref=<match1>#<match2>`

いずれにも一致しない場合は、「GitHub または GitLab のイシューURLを指定してください」とエラーを提示して終了する。

## Step 4: 既存 sourceRef チェック

GET レスポンスの `sourceRef` フィールドが `null` でない場合、AskUserQuestion で次を確認する。

```text
既にリンク済み（現在: <sourceRef>）。上書きしますか？
```

「いいえ」が選択された場合は中断する。

## Step 5: PUT でタスク更新

```bash
curl -sf -X PUT -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL:-http://localhost:3001}/api/tasks/${TASK_ID}" \
  -H "Content-Type: application/json" \
  -d '{"source": "<SOURCE>", "source_ref": "<SOURCE_REF>"}'
```

## Step 6: 結果報告

リンク成功を報告し、タスクID、`source`、`source_ref` を表示する。

</instructions>
