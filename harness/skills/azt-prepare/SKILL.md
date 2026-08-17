---
name: azt-prepare
description: azito タスクの作業環境を準備する。作業ディレクトリ・ブランチを確認し、worktree を作成して移動、作業スタンバイまで行う。
allowed-tools: Bash, Read, AskUserQuestion
user_invocable: true
argument-hint: [task_id]
---

<instructions>

# azt-prepare — タスクの作業環境を準備する

> **オペレーター専用**（UI トークンが必要）。タスクペインで実行すると operator_required になる。

## 引数

- `task_id`: AZITOのタスクID（数値）
- 環境変数 `AZITO_URL`: AZITOのベースURL（未設定時は `http://localhost:3001`）

引数が不足している場合はエラーを提示して終了する。

## Step 1: タスク情報を取得する

```bash
AZITO="${AZITO_URL:-http://localhost:3001}"
TASK=$(curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO}/api/tasks/<task_id>")
```

HTTP エラー（404 等）の場合はエラー内容を提示して終了する。

レスポンス JSON から以下のフィールドを取得する:
- `projectId` — プロジェクトID
- `workingDirectory` — 作業ディレクトリ（null の場合あり）
- `baseBranch` — ベースブランチ（null の場合あり）
- `branch` — 作業ブランチ名（null の場合あり）
- `worktreePath` — 既存の worktree パス（null の場合あり）
- `worktreeBranch` — 既存の worktree ブランチ（null の場合あり）
- `title` — タスクタイトル（ブランチ名生成用）

## Step 2: プロジェクト・サーバー情報を取得する

```bash
PROJECT=$(curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO}/api/projects/<projectId>")
SERVERS=$(curl -sf -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO}/api/projects/<projectId>/servers")
```

`SERVERS` 配列の先頭エントリからプロジェクトサーバーのデフォルト値を取得する:
- `workingDirectory` — デフォルト作業ディレクトリ
- `branch` — プロジェクトサーバーのデフォルトブランチ

`PROJECT` から:
- `defaultBranch` — プロジェクトのデフォルトブランチ

## Step 3: 未設定項目を解決する

### 3a: workingDirectory

タスクの `workingDirectory` が null の場合:
- プロジェクトサーバーの `workingDirectory` を候補として AskUserQuestion で提示する
- プロジェクトサーバーにも値がない場合は AskUserQuestion でパスを入力してもらう

### 3b: baseBranch

タスクの `baseBranch` が null の場合、以下の優先順位で候補を決定し AskUserQuestion で確認する:
1. プロジェクトサーバーの `branch`
2. プロジェクトの `defaultBranch`
3. `main`

### 3c: branch（作業ブランチ名）

タスクの `branch` が null の場合:
- タスクタイトルから簡易 slug を生成する（英数字とハイフンのみ、30文字以内）
- `task/<task_id>-<slug>` 形式でブランチ名を提案し、AskUserQuestion で確認する
- 確定前にブランチ名が `^[a-zA-Z0-9._/-]+$` に一致することを確認する。一致しない場合は再入力を求める

### 3d: 確定値を書き戻す

Step 3a〜3c で確定した値を PUT でタスクに書き戻す:

```bash
curl -sf -X PUT -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO}/api/tasks/<task_id>" \
  -H "Content-Type: application/json" \
  -d '{"working_directory": "<確定値>", "base_branch": "<確定値>", "branch": "<確定値>"}'
```

## Step 4: worktree の存在チェック

タスクの `worktreePath` が設定済みかつそのディレクトリが実在する場合:
- worktree 作成をスキップし、Step 6 へ進む

## Step 5: worktree を作成する

### 5a: ディレクトリ準備

```bash
WORKTREE_PATH="<workingDirectory>/.worktrees/task-<task_id>"
mkdir -p "$(dirname "$WORKTREE_PATH")"
```

### 5b: ブランチの存在確認と worktree 作成

既存ブランチがあるか確認する:

```bash
git -C <workingDirectory> rev-parse --verify <branch> 2>/dev/null || \
git -C <workingDirectory> rev-parse --verify origin/<branch> 2>/dev/null
```

- 既存ブランチあり: `git -C <workingDirectory> worktree add <WORKTREE_PATH> <branch>`
- なし: `git -C <workingDirectory> worktree add -b <branch> <WORKTREE_PATH> <baseBranch>`

失敗時はエラー内容を提示して終了する（フォールバックしない）。

### 5c: worktree 情報を書き戻す

```bash
curl -sf -X PUT -H "Authorization: Bearer ${AZITO_UI_TOKEN}" "${AZITO}/api/tasks/<task_id>" \
  -H "Content-Type: application/json" \
  -d '{"worktree_path": "<WORKTREE_PATH>", "worktree_branch": "<branch>"}'
```

## Step 6: 移動と報告

worktree ディレクトリへ `cd` する:

```bash
cd <WORKTREE_PATH>
```

以下を表示して「作業スタンバイ完了」を報告する:
- worktree パス
- ブランチ名
- `git status` の出力
- タスクタイトル

次のステップとして `/azt-plan <task_id>` の実行を案内する。

</instructions>
