#!/usr/bin/env bash
# pushing-default sidekick script.
#
# 契約（AZITO のブランチ意味論）:
#   - push するのは worktree の「現在の作業ブランチ」。checkout は一切しない。
#     PushVerifier は `git ls-remote --heads origin <作業ブランチ>` と
#     GitProviderService の findPullRequestByBranch（gh/glab CLI 非依存）で
#     検証するため、この契約を崩してはならない。
#   - PR の base ブランチは AZITO_PR_BASE で受ける（作業ブランチとは別物）。
#
# PR/MR 作成はサーバー側（PullRequestCreator）が保証する（Issue: git provider
# 抽象化 Phase 4-A）。このスクリプトの PR 作成はベストエフォートのオプション
# 扱い: gh/glab CLI が無い、または作成に失敗しても、スクリプト自体は失敗させ
# ない（commit+push が本質で、PR 作成はサーバー側の責務のため二重作成の心配
# もない — サーバー側は作成前に必ず findPullRequestByBranch で既存確認する）。
#
# 環境変数（引数ではなく env で受ける規約。呼び出し元 SKILL.md 参照）:
#   AZITO_GIT_PROVIDER    (optional) "github"（デフォルト）または "gitlab"。PR/MR操作に使うCLIを切り替える
#   AZITO_COMMIT_MESSAGE  (required) コミットメッセージ（Conventional Commits）
#   AZITO_PR_BASE         (optional) PR の base ブランチ。未指定なら gh のリポジトリデフォルトに任せる
#   AZITO_PR_BASE_FROM    (optional) AZITO_PR_BASE がリモートに存在しない場合の作成元ブランチ
#   AZITO_SKIP_PR         (optional) "1" なら PR を作成しない。デフォルトは作成する
#   AZITO_PR_TITLE        (optional) PR タイトル。未指定なら AZITO_COMMIT_MESSAGE を使う
#   AZITO_PR_BODY         (optional) PR 本文。未指定なら AZITO_COMMIT_MESSAGE を使う
#
# 標準出力に BRANCH / COMMIT_SHA / PR_URL（CLI で作成・検出できた場合のみ。
# できなくても "(deferred to server)" を出して正常終了する）を出力する。
set -euo pipefail

: "${AZITO_COMMIT_MESSAGE:?AZITO_COMMIT_MESSAGE is required}"

PROVIDER="${AZITO_GIT_PROVIDER:-github}"
SKIP_PR="${AZITO_SKIP_PR:-0}"
PR_TITLE="${AZITO_PR_TITLE:-$AZITO_COMMIT_MESSAGE}"
PR_BODY="${AZITO_PR_BODY:-$AZITO_COMMIT_MESSAGE}"
PR_BASE="${AZITO_PR_BASE:-}"
PR_BASE_FROM="${AZITO_PR_BASE_FROM:-}"

# ─── 現在の作業ブランチを特定（detached HEAD は fail、checkout はしない） ───

WORK_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$WORK_BRANCH" = "HEAD" ]; then
  echo "ERROR: detached HEAD; cannot determine the work branch to push." >&2
  exit 1
fi

# ─── ブランチ名の ref 検証 ───

git check-ref-format --branch "$WORK_BRANCH" > /dev/null
if [ -n "$PR_BASE" ]; then
  git check-ref-format --branch "$PR_BASE" > /dev/null
fi
if [ -n "$PR_BASE_FROM" ]; then
  git check-ref-format --branch "$PR_BASE_FROM" > /dev/null
fi

# ─── commit ───

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$AZITO_COMMIT_MESSAGE"
else
  echo "No changes to commit."
fi

# ─── push（作業ブランチをそのまま push） ───

if [ "${AZITO_HUB_PUSH:-}" = "1" ]; then
  COMMIT_SHA="$(git rev-parse HEAD)"
  echo "BRANCH: $WORK_BRANCH"
  echo "COMMIT_SHA: $COMMIT_SHA"
  echo "=== Hub-proxied push mode ==="
  echo "Commit completed. Push will be handled by the hub."
  exit 0
fi

git push -u origin "$WORK_BRANCH"

COMMIT_SHA="$(git rev-parse HEAD)"
echo "BRANCH: $WORK_BRANCH"
echo "COMMIT_SHA: $COMMIT_SHA"

if [ "$SKIP_PR" = "1" ]; then
  echo "Skipping PR creation (AZITO_SKIP_PR=1)."
  exit 0
fi

# ─── PR base がリモートに無ければ作成（AZITO_PR_BASE_FROM から。checkout はしない） ───

if [ -n "$PR_BASE" ]; then
  if [ -z "$(git ls-remote --heads origin "$PR_BASE")" ]; then
    if [ -z "$PR_BASE_FROM" ]; then
      echo "ERROR: PR base branch '$PR_BASE' does not exist on origin and AZITO_PR_BASE_FROM is not set." >&2
      exit 1
    fi
    git fetch origin
    git push origin "refs/remotes/origin/${PR_BASE_FROM}:refs/heads/${PR_BASE}"
    echo "Created PR base branch '$PR_BASE' from 'origin/$PR_BASE_FROM'."
  fi
fi

# ─── PR（ベストエフォート。サーバー側 PullRequestCreator が最終的な保証元） ───
#
# gh/glab CLI が無い、または権限等で作成に失敗しても、それはこのスクリプトの
# 失敗ではない — サーバー側が push 完了検知時に findPullRequestByBranch で
# 既存確認した上で createPullRequest する（Phase 4-A）。ここでの成功は単に
# 早期に PR_URL を報告できるだけの付加価値。

CLI_BIN="gh"
if [ "$PROVIDER" = "gitlab" ]; then
  CLI_BIN="glab"
fi

if ! command -v "$CLI_BIN" > /dev/null 2>&1; then
  echo "PR_URL: (deferred to server; $CLI_BIN CLI not found)"
  exit 0
fi

if [ "$PROVIDER" = "gitlab" ]; then
  EXISTING_PR_URL="$(glab api "projects/:fullpath/merge_requests?state=opened&source_branch=$WORK_BRANCH&per_page=1" 2>/dev/null \
    | node -e "process.stdin.on('data',d=>{try{const r=JSON.parse(d);if(r[0])console.log(r[0].web_url)}catch{}})" 2>/dev/null || true)"
else
  EXISTING_PR_URL="$(gh pr list --head "$WORK_BRANCH" --json url --jq '.[0].url' 2>/dev/null || true)"
fi
if [ -n "$EXISTING_PR_URL" ]; then
  echo "PR_URL: $EXISTING_PR_URL (already exists)"
  exit 0
fi

if [ "$PROVIDER" = "gitlab" ]; then
  PR_URL="$(glab mr create --source-branch "$WORK_BRANCH" \
    ${PR_BASE:+--target-branch "$PR_BASE"} \
    --title "$PR_TITLE" --description "$PR_BODY" \
    --no-editor --yes 2>/dev/null | grep -oP 'https://\S+' || true)"
else
  PR_URL="$(gh pr create --head "$WORK_BRANCH" \
    ${PR_BASE:+--base "$PR_BASE"} --title "$PR_TITLE" --body "$PR_BODY" 2>/dev/null || true)"
fi

if [ -n "$PR_URL" ]; then
  echo "PR_URL: $PR_URL"
else
  echo "PR_URL: (deferred to server; $CLI_BIN pr create failed)"
fi
exit 0
