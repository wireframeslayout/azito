---
name: pushing-default
description: commit/push/PR作成をスクリプト実行で行う
tags: pushing
isDefault: true
---
<task>
{{task.pushTaskDescription}}
</task>

<rules>
- Base branch: {{project.defaultBranch}}
{{task.targetBranch}}
{{task.pushRules}}

{{project.sidekickPrompt}}
</rules>

<execution>
このフェーズは `{{sidekick.dir}}/scripts/push.sh` を実行して行う。あなた自身が git/gh コマンドを
直接組み立てる必要はない。次の環境変数を設定してスクリプトを実行し、その標準出力を確認すること:

- `AZITO_GIT_PROVIDER`: `{{task.gitProvider}}`（プロジェクト設定から自動設定。`github` または `gitlab`）
- `AZITO_COMMIT_MESSAGE`（必須）: Conventional Commits 形式のコミットメッセージ（このタスクでの変更内容を要約する）
- `AZITO_PR_BASE`（任意）: PR の base ブランチ。上記 <rules> に「PR target branch: X」の行があれば
  その X を設定する。無ければ設定しない（gh がリポジトリのデフォルトブランチを base にする）
- `AZITO_PR_BASE_FROM`（任意）: 上記「PR target branch:」行に「create it from Y」とある場合、その Y を
  設定する（base ブランチがリモートに存在しないときの作成元になる）
- `AZITO_SKIP_PR`: 上記 <task> が「Pull Request を作成しない」指示であれば `1`、それ以外は未設定（`0`）
- `AZITO_PR_TITLE`: PR を作成する場合のタイトル（簡潔にタスク内容を要約する）
- `AZITO_PR_BODY`（任意）: PR 本文（変更の要約とテスト結果を含める）。未指定ならコミットメッセージが使われる

push されるのは worktree の**現在の作業ブランチ**（スクリプトが `git rev-parse --abbrev-ref HEAD` で
自動取得する）。作業ブランチを環境変数で渡す必要はなく、スクリプトは checkout を一切行わない。
実行前に正しい作業ブランチにいることだけ確認すること。

実行例:
```bash
AZITO_GIT_PROVIDER="{{task.gitProvider}}" \
AZITO_COMMIT_MESSAGE="<message>" \
AZITO_PR_BASE="<base branch (only if specified in rules)>" \
AZITO_SKIP_PR="0" \
AZITO_PR_TITLE="<title>" \
{{sidekick.dir}}/scripts/push.sh
```

スクリプトは変更を conventional commit でコミットし、現在の作業ブランチを push する。
PR/MR の作成は AZITO サーバー側が保証する（push 完了を検知した時点で、既存 PR が無ければ自動作成
する）。スクリプト自身の PR 作成（`gh`/`glab` CLI、`AZITO_GIT_PROVIDER` に応じて自動選択）は
ベストエフォートのオプションに過ぎない: CLI が無い場合や作成に失敗した場合もスクリプトは正常終了する
（`PR_URL: (deferred to server; ...)` を出力するだけ）。CLI で作成・検出できた場合はそのまま
PR URL を出力する（サーバー側は作成前に必ず既存 PR を確認するため、ここで作成済みでも二重作成されない）。
ブランチ名・コミット SHA と（CLI 側で作成/検出できた場合は）PR URL を標準出力に出力する。
</execution>

<output>
{{task.pushOutput}}
</output>
