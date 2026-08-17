---
name: azt-push
description: AZITOタスクの pushing フェーズを実行する。タスクIDを引数に取り、azito からプロンプトを取得してプッシュ・PR作成を行う。
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
user_invocable: true
argument-hint: [task_id]
---

<instructions>

# azt-push — AZITOタスク: プッシュフェーズ

## 引数

- `task_id`: AZITOのタスクID（数値）
- 環境変数 `AZITO_URL`: AZITOのベースURL（例: `http://localhost:3001`）

## Step 1: フェーズプロンプトを取得する

このフェーズのプロンプトは、タスクが属する Operation の `phase_config`（フェーズ→Sidekick
マッピング）が指す Sidekick パッケージ（既定は `harness/sidekicks/pushing-default`。
git 操作は `{{sidekick.dir}}/scripts/push.sh` に委譲される）から サーバー側で解決・
レンダリングされる。Sidekick の実体を意識する必要はなく、以下のエンドポイントを呼ぶだけでよい。

```bash
TASK_ID="$1"
curl -sf -H "Authorization: Bearer ${AZITO_TASK_TOKEN:-$AZITO_UI_TOKEN}" "${AZITO_URL}/api/phase-prompts/pushing?render=skill&task_id=${TASK_ID}"
```

取得した JSON の `prompt` フィールドがこのフェーズの指示内容です。`nextPhase` フィールドが次フェーズのスキル名（最終フェーズの場合は null）です。

## Step 2: プロンプトの指示に従って作業を実行する

取得した `prompt` の内容に従い、pushing フェーズの作業（git push・PR作成など）を行う。

質問がある場合はユーザーに直接質問する。完了したら作業結果を報告する。

## Step 3: 完了後

pushing は最終フェーズです。すべての作業が完了したことをユーザーに報告する。

</instructions>
