---
name: azt-test
description: AZITOタスクの testing フェーズを実行する。タスクIDを引数に取り、azito からプロンプトを取得してテストを行う。
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
user_invocable: true
argument-hint: [task_id]
---

<instructions>

# azt-test — AZITOタスク: テストフェーズ

## 引数

- `task_id`: AZITOのタスクID（数値）
- 環境変数 `AZITO_URL`: AZITOのベースURL（例: `http://localhost:3001`）

## Step 1: フェーズプロンプトを取得する

このフェーズのプロンプトは、タスクが属する Operation の `phase_config`（フェーズ→Sidekick
マッピング）が指す Sidekick パッケージ（既定は `harness/sidekicks/testing-default`）から
サーバー側で解決・レンダリングされる。Sidekick の実体を意識する必要はなく、以下のエンドポイントを
呼ぶだけでよい。

```bash
TASK_ID="$1"
curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO_URL}/api/phase-prompts/testing?render=skill&task_id=${TASK_ID}"
```

取得した JSON の `prompt` フィールドがこのフェーズの指示内容です。`nextPhase` フィールドが次フェーズのスキル名です。

## Step 2: プロンプトの指示に従って作業を実行する

取得した `prompt` の内容に従い、testing フェーズの作業（テスト実行・確認など）を行う。

質問がある場合はユーザーに直接質問する。完了したら次のステップへ進む。

## Step 3: 完了後のレコメンド

作業完了後、`nextPhase` に値がある場合は次のスキル（例: `/azt-push`）を実行するようユーザーに案内する。

</instructions>
