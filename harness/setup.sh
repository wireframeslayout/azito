#!/bin/bash
# AZITO Harness セットアップスクリプト
# ~/.claude/skills/ に azt-* スキルのシンボリックリンクを作成し、
# ~/.claude/settings.json に azt-mcp MCP サーバーを登録する

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
AZITO_URL="${AZITO_URL:-}"
AZITO_WEBHOOK_TOKEN="${AZITO_WEBHOOK_TOKEN:-}"
AZITO_UI_TOKEN="${AZITO_UI_TOKEN:-}"
AZITO_SERVER_NAME="${AZITO_SERVER_NAME:-}"
# --prefix は任意の文字列を受け付ける（charset 制限なし。ドットを含む値
# `--prefix prod.eu` も許可される）。生成される azitoctl*.env のファイル名は
# `azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env` （下記 azitoctl.env 節参照）。
# 読み出し側（packages/server/src/shared/azitoctlEnv.ts の
# findAzitoctlEnvFiles）はこの文法に合わせて `^azitoctl(?:-.+)?\.env$` で
# 発見する — 発見側の正規表現をここより狭めると、`azito auth doctor` が
# ドット付き prefix のファイルを見逃したまま "all checks passed" を返す
# （Phase C third-party review 指摘）。
AZITO_PREFIX="${AZITO_PREFIX:-}"
# Issue #29 review, Critical finding 3: --ui-token 省略時、setup.sh は
# operator.env / Claude settings.json の MCP env / Codex MCP 設定に残った
# 既存の AZITO_UI_TOKEN を意図的に温存する（再実行のたびにトークンが消えては
# 運用が壊れるため — 下の各節のコメント参照）。この「温存」は、サーバーを
# 後から isolation_intent=1 に切り替えたケースでは資格情報の残置になる:
# 隔離化しても、以前 setup.sh --ui-token で書き込んだ全権トークンは
# ここから掃除されない限り残り続ける。--purge-operator-token は、その残置分を
# 明示的に消し去るための独立モード。HarnessInstaller は isolationIntent=1の
# server へ runSetup する際、常にこのフラグを付ける（--ui-token は元々
# 省略される — HarnessInstaller.ts の isolationIntent 節参照）。
AZITO_PURGE_OPERATOR_TOKEN=0
# Set when --ui-token/--ui-token=... is explicitly passed on THIS invocation's
# argv — distinct from AZITO_UI_TOKEN merely being non-empty, which can also
# happen via inherited environment (line 11). Used below to reject
# --purge-operator-token + --ui-token together (Issue #29 review, Important
# finding 2) without also rejecting the common "AZITO_UI_TOKEN happens to be
# exported in the caller's shell" case.
AZITO_UI_TOKEN_ARG=0
# Issue #29 review, Important finding 1 (2nd pass): flipped to 1 whenever a
# codex mcp remove→add replacement fails and the script chooses to continue
# with the remaining setup steps (skills/AGENTS.md) rather than aborting
# mid-script. Checked once at the very end of the script so the process still
# exits non-zero — HarnessInstaller.install()/installLocal() key `success` off
# that exit code, and PUT /api/servers/:name's attemptIsolationCleanup()
# records `cleanup: 'failed'` only when `result.success` is false. Without
# this, a remove-succeeded/add-failed codex mcp replacement was silently
# swallowed (`|| true` / warning-only echo) and the whole run still reported
# exit 0, so a --purge-operator-token run that failed to actually purge the
# token got recorded as `cleanup: 'done'`.
SETUP_HAD_ERRORS=0

# ── 引数パース ──
usage_exit() {
  echo "Usage: $0 [--azito-url http://host:3001] [--webhook-token <token>] [--ui-token <token>] [--server-name <name>] [--prefix <prefix>] [--purge-operator-token]" >&2
  echo "" >&2
  echo "  --prefix <name>  この配線を独立したハブ用プロファイルとして扱う。設定は" >&2
  echo "                   ~/.azito/azitoctl-<name>.env に書き出され、hook コマンドには" >&2
  echo "                   AZITO_PREFIX=<name> が埋め込まれる。1台から複数のハブへ" >&2
  echo "                   シグナルを送る場合は、ハブごとに --prefix を変えて実行する" >&2
  echo "                   （URL・トークン・サーバー名はプロファイル単位でまとめて解決され、" >&2
  echo "                   変数単位の部分上書きはできない）。" >&2
  echo "  --purge-operator-token  operator.env / Claude settings.json の MCP env /" >&2
  echo "                   Codex MCP 設定から、AZITO が過去に書き込んだ" >&2
  echo "                   AZITO_UI_TOKEN をすべて除去する。--ui-token 省略時の" >&2
  echo "                   既定動作（既存トークンを温存する）を上書きする。" >&2
  echo "                   サーバーを isolation_intent=1 に切り替えた後の" >&2
  echo "                   資格情報掃除に使う。--ui-token と同時指定はエラー。" >&2
  echo "                   スタンドアロン動作: このフラグを付けた実行はトークン" >&2
  echo "                   除去のみを行う。Skills/Rules のリンク、MCP" >&2
  echo "                   サーバー登録・URL 更新、hooks 登録は一切行わない" >&2
  echo "                   （AZITO_UI_TOKEN を含まない azitoctl.env の書き出しは" >&2
  echo "                   隔離サーバーの稼働検出に必要なため対象外）。" >&2
  exit 1
}

# 値付きオプションの値が実際に続いているか確認する（set -u での unbound
# variable エラーと、後続オプションを値として飲み込む事故の両方を防ぐ）
require_value() {
  if [[ $# -lt 2 || "$2" == --* ]]; then
    echo "Option $1 requires a value" >&2
    usage_exit
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --azito-url)
      require_value "$@"
      AZITO_URL="$2"
      shift 2
      ;;
    --azito-url=*)
      AZITO_URL="${1#*=}"
      shift
      ;;
    --webhook-token)
      require_value "$@"
      AZITO_WEBHOOK_TOKEN="$2"
      shift 2
      ;;
    --webhook-token=*)
      AZITO_WEBHOOK_TOKEN="${1#*=}"
      shift
      ;;
    --ui-token)
      require_value "$@"
      AZITO_UI_TOKEN="$2"
      AZITO_UI_TOKEN_ARG=1
      shift 2
      ;;
    --ui-token=*)
      AZITO_UI_TOKEN="${1#*=}"
      AZITO_UI_TOKEN_ARG=1
      shift
      ;;
    --server-name)
      require_value "$@"
      AZITO_SERVER_NAME="$2"
      shift 2
      ;;
    --server-name=*)
      AZITO_SERVER_NAME="${1#*=}"
      shift
      ;;
    --prefix)
      require_value "$@"
      AZITO_PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      AZITO_PREFIX="${1#*=}"
      shift
      ;;
    --purge-operator-token)
      AZITO_PURGE_OPERATOR_TOKEN=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage_exit
      ;;
  esac
done

# Issue #29 review, Important finding 2: --purge-operator-token exists to
# guarantee a server ends this run with NO AZITO_UI_TOKEN anywhere it writes
# one. Two things could silently undo that:
#   1. --ui-token passed alongside it — the caller is explicitly asking to
#      both purge and (re)install the same token in one run, which is a
#      contradiction, not a "last write wins" case. Rejected outright rather
#      than picking a side.
#   2. AZITO_UI_TOKEN inherited from the parent shell's environment (line 11
#      seeds it from there) — the CLI parser above only ever OVERWRITES that
#      seed when --ui-token is given; it never clears it. Without this,
#      `AZITO_UI_TOKEN=xxx harness/setup.sh --purge-operator-token` (or any
#      caller — e.g. HarnessInstaller.runSetupLocal, a shell profile — that
#      happens to have the var exported) would purge existing tokens and then
#      immediately re-write operator.env / MCP configs with the inherited
#      value in the very same run.
# HarnessInstaller.ts's isolationIntent path never passes --ui-token when it
# passes --purge-operator-token (see that file's runSetup), so this is
# defense-in-depth against a caller that doesn't go through that path (a
# human running setup.sh directly, or a future call site).
if [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
  if [[ "$AZITO_UI_TOKEN_ARG" == "1" ]]; then
    echo "Error: --purge-operator-token と --ui-token は同時指定できません" >&2
    exit 1
  fi
  AZITO_UI_TOKEN=""
fi

echo "AZITO Harness セットアップ"
echo "ハーネス: $HARNESS_DIR"
if [[ -n "$AZITO_URL" ]]; then
  echo "AZITO URL: $AZITO_URL"
fi
if [[ -n "$AZITO_PREFIX" ]]; then
  echo "Prefix: $AZITO_PREFIX"
fi
echo ""

# ── link_skills 関数 ──
link_skills() {
  local dest_dir="$1"
  mkdir -p "$dest_dir"
  for skill_dir in "$HARNESS_DIR"/skills/azt-*/; do
    [[ -d "$skill_dir" ]] || continue
    name=$(basename "$skill_dir")
    target="$HARNESS_DIR/skills/$name"
    link="$dest_dir/$name"
    if [[ -L "$link" ]]; then
      current=$(readlink "$link")
      if [[ "$current" = "$target" ]]; then
        echo "  $name: OK (既にリンク済み)"
        continue
      fi
      echo "  $name: 更新 ($current → $target)"
      rm "$link"
    elif [[ -d "$link" ]]; then
      echo "  $name: スキップ (既存ディレクトリ: $link)"
      echo "    ハーネス版に置き換えるには: rm -rf $link && $0"
      continue
    else
      echo "  $name: 作成"
    fi
    ln -s "$target" "$link"
  done
}

# ── Skills (Claude Code) ──
echo "=== Skills ==="
# Issue #29 review (10th pass), Important finding 2: --purge-operator-token
# is documented as a standalone token-removal-only mode (see usage_exit) —
# skills linking touches no credential and is unrelated to the purge, so it
# must not run as a side effect of a purge invocation.
if [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
  echo "  スキップ (--purge-operator-token)"
elif [[ -z "$AZITO_PREFIX" ]]; then
  link_skills "$HOME/.claude/skills"
else
  echo "  スキップ (--prefix モード)"
fi

# ── Rules (prompt-modules → ~/.claude/rules/) ──
echo ""
echo "=== Rules (prompt-modules) ==="
if [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
  echo "  スキップ (--purge-operator-token)"
elif [[ -z "$AZITO_PREFIX" ]]; then
  mkdir -p ~/.claude/rules

  for module_file in "$HARNESS_DIR"/prompt-modules/*.md; do
    [[ -f "$module_file" ]] || continue
    name=$(basename "$module_file")
    target="$module_file"
    link="$HOME/.claude/rules/$name"

    if [[ -L "$link" ]]; then
      current=$(readlink "$link")
      if [[ "$current" = "$target" ]]; then
        echo "  $name: OK (既にリンク済み)"
        continue
      fi
      echo "  $name: 更新 ($current → $target)"
      rm "$link"
    elif [[ -e "$link" ]]; then
      echo "  $name: スキップ (既存ファイル: $link)"
      echo "    ハーネス版に置き換えるには: rm $link && $0"
      continue
    else
      echo "  $name: 作成"
    fi

    ln -s "$target" "$link"
  done
else
  echo "  スキップ (--prefix モード)"
fi

# ── settings.json マージ (MCP Server + Hooks) ──
echo ""
echo "=== Settings (settings.json) ==="
SETTINGS="$HOME/.claude/settings.json"
MCP_ENTRY_KEY="azt-mcp"
MCP_SERVER_PATH="$HARNESS_DIR/skills/azt-mcp/mcp-server/index.js"
NOTIFY_HOOK_SCRIPT="$HARNESS_DIR/hooks/azito-notify.sh"
ACTIVITY_HOOK_SCRIPT="$HARNESS_DIR/hooks/azito-activity.sh"
INTERACTION_HOOK_SCRIPT="$HARNESS_DIR/hooks/azito-interaction.sh"
QUESTION_HOOK_SCRIPT="$HARNESS_DIR/hooks/azito-question.sh"
if [ -z "${AZITO_URL:-}" ]; then
  echo "WARNING: --azito-url が未指定のため http://localhost:3001 を使用します。" >&2
  echo "リモートサーバーでは必ず --azito-url で hub の URL を指定してください。" >&2
fi
AZITO_URL_VALUE="${AZITO_URL:-http://localhost:3001}"

# hook command に環境変数をインラインで埋め込む。値はスペース等を含みうる
# （例: サーバー名 "The Mirano"）ため printf %q で必ずシェルクォートする。
ENV_PREFIX=""
[[ -n "$AZITO_URL" ]] && ENV_PREFIX="${ENV_PREFIX}AZITO_URL=$(printf '%q' "$AZITO_URL") "
[[ -n "$AZITO_SERVER_NAME" ]] && ENV_PREFIX="${ENV_PREFIX}AZITO_SERVER_NAME=$(printf '%q' "$AZITO_SERVER_NAME") "

NOTIFY_HOOK_CMD="${ENV_PREFIX}bash $NOTIFY_HOOK_SCRIPT"

# activity / interaction hook は宛先（URL・Webhook トークン・サーバー名）を必ず
# 「単一のプロファイル」からまとめて解決する（変数単位の部分上書きは禁止 —
# hooks/azito-activity.sh の "Destination profile resolution" 参照）。URL や
# サーバー名だけを埋め込むとトークンだけが別プロファイル由来になり得るため、
# ここで埋め込むのはプロファイルの選択子である AZITO_PREFIX だけにする。値一式は
# azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env（下の "azitoctl.env" 節が
# --azito-url / --webhook-token / --server-name から書き出すファイル）から読む。
# 1台から複数ハブへ配線する場合は、ハブごとに
#   setup.sh --prefix <name> --azito-url <url> --webhook-token <t> --server-name <n>
# を実行してプロファイルを作り分ける（トークンは env ファイル側にのみ置かれ、
# hook コマンドの argv には載らない）。
PROFILE_PREFIX=""
[[ -n "$AZITO_PREFIX" ]] && PROFILE_PREFIX="AZITO_PREFIX=$(printf '%q' "$AZITO_PREFIX") "

ACTIVITY_START_CMD="${PROFILE_PREFIX}bash $ACTIVITY_HOOK_SCRIPT start"
ACTIVITY_STOP_CMD="${PROFILE_PREFIX}bash $ACTIVITY_HOOK_SCRIPT stop"
INTERACTION_CMD="${PROFILE_PREFIX}bash $INTERACTION_HOOK_SCRIPT"
QUESTION_CMD="${PROFILE_PREFIX}bash $QUESTION_HOOK_SCRIPT"

if [[ -f "$NOTIFY_HOOK_SCRIPT" ]]; then
  chmod +x "$NOTIFY_HOOK_SCRIPT"
fi
if [[ -f "$ACTIVITY_HOOK_SCRIPT" ]]; then
  chmod +x "$ACTIVITY_HOOK_SCRIPT"
fi
if [[ -f "$INTERACTION_HOOK_SCRIPT" ]]; then
  chmod +x "$INTERACTION_HOOK_SCRIPT"
fi
if [[ -f "$QUESTION_HOOK_SCRIPT" ]]; then
  chmod +x "$QUESTION_HOOK_SCRIPT"
fi

# tar 展開等で実行権が落ちるケースに備え、azitoctl / azs の実行権を明示的に保証する
AZITOCTL_SCRIPT="$HARNESS_DIR/bin/azitoctl"
if [[ -f "$AZITOCTL_SCRIPT" ]]; then
  chmod +x "$AZITOCTL_SCRIPT"
fi
AZS_SCRIPT="$HARNESS_DIR/bin/azs"
if [[ -f "$AZS_SCRIPT" ]]; then
  chmod +x "$AZS_SCRIPT"
fi

# ── azitoctl.env (agent-signal / azs 用の永続設定) ──
# --azito-url / --webhook-token が渡されたときのみ書き出す。activity hook と
# 違い azitoctl は env 未設定を no-op にできない（シグナルは必須データ）ため、
# hook command への埋め込みとは別に、agent プロセス起動時にも参照できる
# ファイルとして残しておく。
# AZITO_SERVER_NAME / AZITO_SUPERVISOR_PATH は azs (harness/bin/azs) が同じ
# ファイルを source して使う。
#
# NOTE (Issue #28 Phase B): このファイルには AZITO_UI_TOKEN を書かない。
# azitoctl / azs は task principal（AZITO_TASK_TOKEN）文脈で動くプロセスから
# source されるため、全権トークンをここに置くと配布経路の穴になる。
# --ui-token が指定された場合の書き込み先は operator.env（下記）のみ。
# 全体を都度 `>` で書き直すため、--azito-url / --webhook-token が両方揃った
# 実行では過去バージョンの setup.sh が残した AZITO_UI_TOKEN 行も自動的に消える。
# 一方 webhook トークン省略時（下の else 節）は書き直し自体をスキップするため、
# 過去に書かれた AZITO_UI_TOKEN 行が残り続けてしまう（Phase C 残件1）。
# そのため掃除は書き直し条件と独立に、常に先に行う。
echo ""
echo "=== azitoctl.env ==="
AZITOCTL_ENV_DIR="$HOME/.azito"
AZITOCTL_ENV_FILE="$AZITOCTL_ENV_DIR/azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env"
# 既存ファイルに AZITO_UI_TOKEN 行が残っていれば、書き直し条件に関わらず
# 除去する（冪等: 該当行が無ければ何もしない）。umask 077 + アトミック置換は
# 下の書き直し節と同じ作法。
if [[ -f "$AZITOCTL_ENV_FILE" ]] && grep -q '^AZITO_UI_TOKEN=' "$AZITOCTL_ENV_FILE" 2>/dev/null; then
  AZITOCTL_ENV_CLEAN_TMP="$(mktemp "$AZITOCTL_ENV_DIR/.azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env.XXXXXX")"
  (
    umask 077
    # `grep -v` はマッチ行を除いた結果が0行になる場合（＝除去対象の
    # AZITO_UI_TOKEN 行のみのファイル）に exit 1 を返し、set -e でセット
    # アップ全体を中止させてしまう（third-party review Important finding、
    # 実再現あり）。awk の `!/pattern/` は該当0件でも常に exit 0 なので
    # 同じ用途に置き換える（真の read エラー時は awk 自身が非ゼロで落ちる
    # ため、その場合はここも失敗する＝挙動は保たれる）。
    awk '!/^AZITO_UI_TOKEN=/' "$AZITOCTL_ENV_FILE" > "$AZITOCTL_ENV_CLEAN_TMP"
  )
  chmod 600 "$AZITOCTL_ENV_CLEAN_TMP"
  mv -f "$AZITOCTL_ENV_CLEAN_TMP" "$AZITOCTL_ENV_FILE"
  echo "  $AZITOCTL_ENV_FILE: 旧 AZITO_UI_TOKEN 行を除去しました"
fi
if [[ -n "$AZITO_URL" && -n "$AZITO_WEBHOOK_TOKEN" ]]; then
  mkdir -p "$AZITOCTL_ENV_DIR"
  # AZITO_WEBHOOK_TOKEN を含むため、書き込み中も world-readable にならないよう
  # umask 077 のサブシェルで隣接一時ファイルに書き、chmod 600 確定後に mv で
  # アトミックに置換する（operator.env と同じ対策、third-party review Important
  # finding）。同一ディレクトリ内の mktemp なので mv はリネームのみで済む。
  AZITOCTL_ENV_TMP="$(mktemp "$AZITOCTL_ENV_DIR/.azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env.XXXXXX")"
  (
    umask 077
    # azitoctl / azs がこのファイルを source するため、値は printf %q で必ず
    # シェルクォートする（生値だと空白・引用符で壊れ、$() は任意コマンド
    # 実行になる）。hook コマンドの ENV_PREFIX 埋め込みと同じ流儀。
    {
      printf 'AZITO_URL=%q\n' "$AZITO_URL"
      printf 'AZITO_WEBHOOK_TOKEN=%q\n' "$AZITO_WEBHOOK_TOKEN"
      if [[ -n "$AZITO_SERVER_NAME" ]]; then
        printf 'AZITO_SERVER_NAME=%q\n' "$AZITO_SERVER_NAME"
      fi
      # AZITO_SUPERVISOR_PATH: azs が実行する supervisor バンドルの絶対パス
      # （実行ファイルのパスのみ。ランナーは azs 側の AZITO_SUPERVISOR_RUNNER で
      # 固定的に前置され、既定は node）。azs はこの値を eval せず 1 引数として
      # 扱うため、$(...) 等が混入しても実行されない。
      # setup.sh 単体では local/agent/ssh のどの種別に対して実行されているか
      # 判別できないため、agent サーバーの既定パス
      # (~/.azito/agent/current/azito-supervisor.cjs、AgentInstaller.ts が
      # デプロイする場所、SupervisorPath.ts の AGENT_SUPERVISOR_PATH と同じ)
      # を書いておく。$HOME はここでは展開せず、azs 側が source した時点の
      # 実行時ユーザーの $HOME で展開されるようにする（%q は使わない — %q だと
      # $ がエスケープされ展開自体が止まる。パスに空白は無いので単純代入で安全）。
      # local チェックアウトではこのパスが存在しないため、azs 側の探索順 b
      # （スクリプト位置から repo dist を解決、存在チェック）へフォールバックする。
      printf 'AZITO_SUPERVISOR_PATH=$HOME/.azito/agent/current/azito-supervisor.cjs\n'
    } > "$AZITOCTL_ENV_TMP"
  )
  chmod 600 "$AZITOCTL_ENV_TMP"
  mv -f "$AZITOCTL_ENV_TMP" "$AZITOCTL_ENV_FILE"
  echo "  $AZITOCTL_ENV_FILE: 書き出しました（AZITO_UI_TOKEN は含みません）"
else
  echo "  スキップ (--azito-url と --webhook-token の両方が必要)"
fi

# ── operator.env (人間が明示的に source する運用者用資格情報) ──
# --ui-token が渡されたときのみ書き出す。azitoctl.env とは別ファイルにする
# ことで、「タスク実行プロセスが自動的に読む設定」と「人間が明示的に有効化する
# 全権クレデンシャル」を混在させない（設計 §9）。setup.sh 自身はこのファイルを
# 一切 source しない。
echo ""
echo "=== operator.env ==="
if [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
  OPERATOR_ENV_FILE="$HOME/.azito/operator.env"
  # operator.env はこの2行（AZITO_URL/AZITO_UI_TOKEN）専用のファイル
  # （上の節コメント参照）なので、行単位の除去ではなくファイルごと削除する
  # ——トークンを抜いた「空の資格情報ファイル」を残す理由がない。存在しな
  # ければ何もしない（冪等）。
  #
  # Issue #29 review, Important finding 2: `rm -f` on a symlink only removes
  # the link itself — dotfiles managers (chezmoi/stow/etc.) commonly replace
  # this path with a symlink into a version-controlled repo. The token would
  # then keep living in the link target, untouched, while this step reports
  # success. Fail closed instead: never resolve/edit the link target (that
  # would be an unpredictable write into a repo this script doesn't own),
  # just surface the target path and require a manual purge there.
  if [[ -L "$OPERATOR_ENV_FILE" ]]; then
    echo "  エラー: $OPERATOR_ENV_FILE はシンボリックリンクです（リンク先: $(readlink "$OPERATOR_ENV_FILE")）。dotfiles 管理等の可能性があるため自動削除しません。リンク先のファイルを手動で確認し、AZITO_UI_TOKEN を除去してください" >&2
    SETUP_HAD_ERRORS=1
  elif [[ -f "$OPERATOR_ENV_FILE" ]]; then
    rm -f "$OPERATOR_ENV_FILE"
    echo "  $OPERATOR_ENV_FILE: --purge-operator-token により削除しました"
  else
    echo "  $OPERATOR_ENV_FILE: 存在しないためスキップ (--purge-operator-token)"
  fi
fi
if [[ -n "$AZITO_UI_TOKEN" ]]; then
  OPERATOR_ENV_DIR="$HOME/.azito"
  OPERATOR_ENV_FILE="$OPERATOR_ENV_DIR/operator.env"
  mkdir -p "$OPERATOR_ENV_DIR"
  # AZITO_UI_TOKEN（全権トークン）を含むため、書き込み中も world-readable に
  # ならないよう umask 077 のサブシェルで隣接一時ファイルに書き、chmod 600
  # 確定後に mv でアトミックに置換する。umask 022 環境で `>` 直書き＋事後
  # chmod だと、書き込みが始まった瞬間から chmod が効くまでの間 0644 で
  # トークンが露出する窓ができていた（third-party review Important finding）。
  OPERATOR_ENV_TMP="$(mktemp "$OPERATOR_ENV_DIR/.operator.env.XXXXXX")"
  (
    umask 077
    {
      echo "# AZITO operator credentials"
      echo "#"
      echo "# このファイルは人間が明示的に \`source ~/.azito/operator.env\` して使う"
      echo "# ためのものです。setup.sh を含むいかなるスクリプトからも自動 source"
      echo "# してはいけません。source した時点でそのシェルはオペレーター権限"
      echo "# （全権）で動作します。"
      printf 'AZITO_URL=%q\n' "$AZITO_URL_VALUE"
      printf 'AZITO_UI_TOKEN=%q\n' "$AZITO_UI_TOKEN"
    } > "$OPERATOR_ENV_TMP"
  )
  chmod 600 "$OPERATOR_ENV_TMP"
  mv -f "$OPERATOR_ENV_TMP" "$OPERATOR_ENV_FILE"
  echo "  $OPERATOR_ENV_FILE: 書き出しました（使うには: source $OPERATOR_ENV_FILE）"
else
  echo "  スキップ (--ui-token が未指定)"
fi

# node が使えれば自動マージ、なければ手動案内にフォールバック
# Issue #29 review, Important finding 2: purge モードで $SETTINGS が symlink
# の場合（dotfiles 管理等）、下の node 処理は fs.writeFileSync でリンク先
# ファイルへ直接書き込むため技術的には動くが、このスクリプトが把握していない
# 別リポジトリのファイルを黙って書き換える副作用は operator.env / config.toml
# と同じ理由で許容しない。fail closed: 自動編集せずリンク先を提示し、手動対応
# を要求する（非 purge モードの通常登録フローには影響しない）。
if [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" && -L "$SETTINGS" ]]; then
  echo "  エラー: $SETTINGS はシンボリックリンクです（リンク先: $(readlink "$SETTINGS")）。dotfiles 管理等の可能性があるため自動編集しません。リンク先のファイルを手動で確認し、MCP env の AZITO_UI_TOKEN を除去してください" >&2
  SETUP_HAD_ERRORS=1
elif command -v node >/dev/null 2>&1; then
  mkdir -p ~/.claude
  # Issue #29 review (8th pass), Important finding 2: previously a bare
  # (unwrapped) command — under `set -e` a purge-mode read/parse failure
  # (process.exit(1) added above) would hard-abort the whole script right
  # here, skipping every later step (skills, AGENTS.md, etc.) with no
  # SETUP_HAD_ERRORS bookkeeping, unlike every other failure path in this
  # script (codex_mcp_replace, Codex config.toml purge) which continues and
  # lets SETUP_HAD_ERRORS drive the final exit code. Wrapping in `if ! ...`
  # matches that convention: the run continues, and still exits non-zero.
  if ! node -e "
    const fs = require('fs');
    const settingsPath = process.argv[1];
    const mcpKey = process.argv[2];
    const mcpServerPath = process.argv[3];
    const azitoUrl = process.argv[4];
    const notifyHookCmd = process.argv[5];
    const activityStartCmd = process.argv[6];
    const activityStopCmd = process.argv[7];
    const mcpServerExists = process.argv[8] === 'true';
    const notifyHookExists = process.argv[9] === 'true';
    const activityHookExists = process.argv[10] === 'true';
    const notifyHookPath = process.argv[11];
    const activityHookPath = process.argv[12];
    const azitoUiToken = process.argv[13];
    const interactionCmd = process.argv[14];
    const interactionHookExists = process.argv[15] === 'true';
    const interactionHookPath = process.argv[16];
    const questionCmd = process.argv[17];
    const questionHookExists = process.argv[18] === 'true';
    const questionHookPath = process.argv[19];
    const purgeOperatorToken = process.argv[20] === 'true';

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      // Issue #29 review (8th pass), Important finding 2: this used to
      // collapse EVERY read/parse failure (missing file, permission error,
      // truncated/invalid JSON) into the same 'no existing settings' case,
      // silently proceeding with settings = {}. In normal (non-purge) mode
      // that's the intended first-run behavior. But in --purge-operator-token
      // mode it means a settings.json that exists and genuinely still holds
      // AZITO_UI_TOKEN — just unreadable/unparsable right now — gets reported
      // as 'nothing to purge (removal not needed)' instead of an error, and
      // the isolationIntent false->true cleanup gate (attemptIsolationCleanup)
      // would record the purge as 'done' despite never having inspected the
      // file. Only a missing file (ENOENT) is a legitimate 'nothing to purge'
      // in purge mode; any other read/parse error must fail the whole setup.sh
      // run non-zero so the caller cannot mistake it for success.
      if (purgeOperatorToken && err.code !== 'ENOENT') {
        console.error('  エラー: --purge-operator-token は ' + settingsPath + ' の読み込みに失敗しました（' + err.message + '）。ファイルの内容を確認し、AZITO_UI_TOKEN の除去が必要か手動で確認してください。');
        process.exit(1);
      }
    }

    let changed = false;
    const messages = [];

    // MCP Server
    // Issue #29 review (10th pass), Important finding 2: purge mode is
    // standalone token-removal only — it must never fall through into the
    // normal upsert branch below, which unconditionally writes AZITO_URL
    // (and would create a brand-new mcpServers entry stamped with
    // whatever azitoUrl this particular invocation happened to resolve,
    // e.g. its http://localhost:3001 default when --azito-url was
    // omitted — see setup.sh's matching Codex-side fix for the identical
    // shape of this bug). The ONLY thing this branch is allowed to do is
    // delete AZITO_UI_TOKEN, and it does so regardless of mcpServerExists/
    // --prefix (token removal must reach an already-registered azt-mcp
    // entry no matter which run originally created it — see the comment
    // this replaced).
    if (purgeOperatorToken) {
      if (settings.mcpServers && settings.mcpServers[mcpKey] && settings.mcpServers[mcpKey].env && ('AZITO_UI_TOKEN' in settings.mcpServers[mcpKey].env)) {
        delete settings.mcpServers[mcpKey].env.AZITO_UI_TOKEN;
        changed = true;
        messages.push('  azt-mcp: --purge-operator-token により AZITO_UI_TOKEN を除去しました（登録/更新はスキップ）');
      } else {
        messages.push('  azt-mcp: 除去対象の AZITO_UI_TOKEN はありません');
      }
    } else if (mcpServerExists) {
      if (!settings.mcpServers) settings.mcpServers = {};
      if (settings.mcpServers[mcpKey]) {
        if (!settings.mcpServers[mcpKey].env) settings.mcpServers[mcpKey].env = {};
        let mcpChanged = false;
        if (settings.mcpServers[mcpKey].env.AZITO_URL !== azitoUrl) {
          settings.mcpServers[mcpKey].env.AZITO_URL = azitoUrl;
          changed = true;
          mcpChanged = true;
        }
        // azitoUiToken が空のときは既存値を触らない（未指定の再実行で消えないように）
        if (azitoUiToken && settings.mcpServers[mcpKey].env.AZITO_UI_TOKEN !== azitoUiToken) {
          settings.mcpServers[mcpKey].env.AZITO_UI_TOKEN = azitoUiToken;
          changed = true;
          mcpChanged = true;
        }
        messages.push(mcpChanged ? '  azt-mcp: 設定を更新しました' : '  azt-mcp: OK (設定済み)');
      } else {
        const env = { AZITO_URL: azitoUrl };
        if (azitoUiToken) env.AZITO_UI_TOKEN = azitoUiToken;
        settings.mcpServers[mcpKey] = {
          command: 'node',
          args: [mcpServerPath],
          env
        };
        changed = true;
        messages.push('  azt-mcp: 追加しました');
      }
      // 登録自体は現行どおり行う（AZITO が作成したペイン内では pane env から
      // トークンが継承され動作するため、失敗にはしない）が、認証情報なしで
      // 登録されたことに気づけるよう警告だけ出す。
      if (!azitoUiToken && !settings.mcpServers[mcpKey].env.AZITO_UI_TOKEN) {
        messages.push('  警告: azt-mcp に AZITO_UI_TOKEN が設定されていません。--ui-token を付けて再実行してください');
      }
    } else {
      messages.push('  azt-mcp: スキップ (MCP サーバーが見つかりません、または --prefix モード)');
    }

    // Upsert a single hook entry within settings.hooks[eventName], matched by
    // the script's full path within the command string. Unlike a plain
    // add-if-missing check, this also refreshes the command string when it
    // already exists but differs (e.g. token/URL/server-name changed on a
    // later setup.sh run) — otherwise re-running setup.sh after rotating the
    // token would silently keep serving the stale one.
    function upsertHook(eventName, scriptMatch, command, label) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
      const entries = settings.hooks[eventName];

      for (const entry of entries) {
        if (!entry.hooks) continue;
        const hook = entry.hooks.find(h => h.command && h.command.includes(scriptMatch));
        if (hook) {
          if (hook.command === command) {
            messages.push('  ' + label + ': OK (設定済み)');
          } else {
            hook.command = command;
            changed = true;
            messages.push('  ' + label + ': 更新しました');
          }
          return;
        }
      }

      entries.push({ hooks: [{ type: 'command', command }] });
      changed = true;
      messages.push('  ' + label + ': 追加しました');
    }

    // Issue #29 review (10th pass), Important finding 2: hook upsert is
    // part of the same normal-registration-flow purge mode must not run
    // — skip all four hook upserts wholesale when purging, same reasoning
    // as the MCP Server branch above (standalone token-removal only).
    if (!purgeOperatorToken) {
      // Stop hook (agent-done notification)
      if (notifyHookExists) {
        upsertHook('Stop', notifyHookPath, notifyHookCmd, 'Stop hook (通知)');
      } else {
        messages.push('  Stop hook (通知): スキップ (hook スクリプトが見つかりません)');
      }

      // Activity hooks (Tier 1 event-driven detection)
      if (activityHookExists) {
        upsertHook('UserPromptSubmit', activityHookPath, activityStartCmd, 'UserPromptSubmit hook (稼働検出開始)');
        upsertHook('Stop', activityHookPath, activityStopCmd, 'Stop hook (稼働検出終了)');
      } else {
        messages.push('  稼働検出フック: スキップ (hook スクリプトが見つかりません)');
      }

      // Notification hook (Phase B リアルタイム未回答検出): AskUserQuestion 等で
      // Claude Code が入力待ちになった瞬間に発火し、agent-interaction webhook 経由で
      // チャットビューのバナー表示を駆動する。
      if (interactionHookExists) {
        upsertHook('Notification', interactionHookPath, interactionCmd, 'Notification hook (未回答検出)');
      } else {
        messages.push('  未回答検出フック: スキップ (hook スクリプトが見つかりません)');
      }

      // PermissionRequest hook (Issue #338 チャット内回答): AskUserQuestion がピッカーを
      // 開いた瞬間に発火し、質問文と選択肢そのものを agent-interaction webhook へ送る。
      // これによりチャットビューがバナーではなく回答可能な質問カードを出せる。
      // AskUserQuestion 以外の PermissionRequest には一切干渉しない（hook スクリプト冒頭の
      // 注記を参照 — 許可判断に影響し得る stdout を出さず即 exit 0 する）。
      if (questionHookExists) {
        upsertHook('PermissionRequest', questionHookPath, questionCmd, 'PermissionRequest hook (質問内容取得)');
      } else {
        messages.push('  質問内容取得フック: スキップ (hook スクリプトが見つかりません)');
      }
    } else {
      messages.push('  hooks: スキップ (--purge-operator-token)');
    }

    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }

    messages.forEach(m => console.log(m));
  " "$SETTINGS" "$MCP_ENTRY_KEY" "$MCP_SERVER_PATH" "$AZITO_URL_VALUE" "$NOTIFY_HOOK_CMD" "$ACTIVITY_START_CMD" "$ACTIVITY_STOP_CMD" \
    "$([[ -f "$MCP_SERVER_PATH" ]] && [[ -z "$AZITO_PREFIX" ]] && echo true || echo false)" \
    "$([[ -f "$NOTIFY_HOOK_SCRIPT" ]] && echo true || echo false)" \
    "$([[ -f "$ACTIVITY_HOOK_SCRIPT" ]] && echo true || echo false)" \
    "$NOTIFY_HOOK_SCRIPT" \
    "$ACTIVITY_HOOK_SCRIPT" \
    "$AZITO_UI_TOKEN" \
    "$INTERACTION_CMD" \
    "$([[ -f "$INTERACTION_HOOK_SCRIPT" ]] && echo true || echo false)" \
    "$INTERACTION_HOOK_SCRIPT" \
    "$QUESTION_CMD" \
    "$([[ -f "$QUESTION_HOOK_SCRIPT" ]] && echo true || echo false)" \
    "$QUESTION_HOOK_SCRIPT" \
    "$([[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]] && echo true || echo false)"; then
    SETUP_HAD_ERRORS=1
  fi

  if [[ -n "$AZITO_WEBHOOK_TOKEN" ]]; then
    echo "  AZITO_WEBHOOK_TOKEN: 設定済み（hook command に埋め込み）"
  else
    echo "  AZITO_WEBHOOK_TOKEN: 未設定（通知・稼働検出には --webhook-token が必要）"
  fi
  if [[ -n "$AZITO_SERVER_NAME" ]]; then
    echo "  AZITO_SERVER_NAME: 設定済み（稼働検出フックに埋め込み）"
  else
    echo "  AZITO_SERVER_NAME: 未設定（稼働検出には --server-name が必要）"
  fi
else
  # node が無い場合のフォールバック（手動案内）
  echo "  警告: node が見つかりません。settings.json を手動で設定してください:"
  echo ""
  # Issue #29 review (3rd pass), Critical finding 1: --purge-operator-token
  # が要求する Claude settings.json の掃除（MCP env の AZITO_UI_TOKEN 削除）は
  # node 経由の JSON 編集でしか行えない。node が無いこの分岐は案内表示のみで
  # 実際には何も消していないので、purge モードではこれを成功として扱わず
  # fail closed にする — でなければ isolationIntent 切替の
  # attemptIsolationCleanup() が「掃除済み」と誤記録してしまう。
  if [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
    echo "  エラー: --purge-operator-token は node が無い環境では settings.json を掃除できません（上記の手動案内に従い、AZITO_UI_TOKEN を手動で削除してください）" >&2
    SETUP_HAD_ERRORS=1
  fi
  if [[ -f "$MCP_SERVER_PATH" ]] && [[ -z "$AZITO_PREFIX" ]]; then
    echo '  "mcpServers": {'
    echo "    \"$MCP_ENTRY_KEY\": {"
    echo '      "command": "node",'
    echo "      \"args\": [\"$MCP_SERVER_PATH\"],"
    if [[ -n "$AZITO_UI_TOKEN" ]]; then
      echo "      \"env\": { \"AZITO_URL\": \"$AZITO_URL_VALUE\", \"AZITO_UI_TOKEN\": \"$AZITO_UI_TOKEN\" }"
    else
      echo "      \"env\": { \"AZITO_URL\": \"$AZITO_URL_VALUE\" }"
    fi
    echo '    }'
    echo '  }'
    echo ""
  fi
  if [[ -f "$NOTIFY_HOOK_SCRIPT" || -f "$ACTIVITY_HOOK_SCRIPT" ]]; then
    STOP_ENTRIES=()
    [[ -f "$NOTIFY_HOOK_SCRIPT" ]] && STOP_ENTRIES+=("      { \"hooks\": [{ \"type\": \"command\", \"command\": \"$NOTIFY_HOOK_CMD\" }] }")
    [[ -f "$ACTIVITY_HOOK_SCRIPT" ]] && STOP_ENTRIES+=("      { \"hooks\": [{ \"type\": \"command\", \"command\": \"$ACTIVITY_STOP_CMD\" }] }")

    echo '  "hooks": {'
    echo '    "Stop": ['
    for i in "${!STOP_ENTRIES[@]}"; do
      if [[ "$i" -lt $((${#STOP_ENTRIES[@]} - 1)) ]]; then
        echo "${STOP_ENTRIES[$i]},"
      else
        echo "${STOP_ENTRIES[$i]}"
      fi
    done
    if [[ -f "$ACTIVITY_HOOK_SCRIPT" ]]; then
      echo '    ],'
      echo '    "UserPromptSubmit": ['
      echo "      { \"hooks\": [{ \"type\": \"command\", \"command\": \"$ACTIVITY_START_CMD\" }] }"
      echo '    ]'
    else
      echo '    ]'
    fi
    if [[ -f "$INTERACTION_HOOK_SCRIPT" ]]; then
      echo '    ,'
      echo '    "Notification": ['
      echo "      { \"hooks\": [{ \"type\": \"command\", \"command\": \"$INTERACTION_CMD\" }] }"
      echo '    ]'
    fi
    if [[ -f "$QUESTION_HOOK_SCRIPT" ]]; then
      echo '    ,'
      echo '    "PermissionRequest": ['
      echo "      { \"hooks\": [{ \"type\": \"command\", \"command\": \"$QUESTION_CMD\" }] }"
      echo '    ]'
    fi
    echo '  }'
    echo ""
  fi
fi

# Issue #29 review, Important finding 1 (2nd pass): replaces the azt-mcp
# Codex MCP registration atomically from the caller's perspective — a bare
# `codex mcp remove` + `codex mcp add` left a "removed but never re-added"
# window on add failure that was previously only warned about (exit 0, entry
# gone).
#
# Issue #29 review (14th pass), Important finding 3: restore used to
# reconstruct a `codex mcp add` call from `codex mcp get azt-mcp --json`
# (command/args/env only, via a now-removed `codex_mcp_reconstruct_add_args`
# helper) — but `codex mcp add --help` (checked directly against the
# installed codex-cli, not assumed from docs) exposes no flags for
# `cwd`/`enabled`/`enabled_tools`/`disabled_tools`/`startup_timeout_sec`/
# `tool_timeout_sec`, so a reconstruct-add restore silently dropped every one
# of those properties even on a "restore succeeded" outcome. This now backs
# up `config.toml` in full BEFORE `codex mcp remove` runs, and restores that
# exact file byte-for-byte if the re-add fails — every property survives,
# because nothing about the file other than the remove/add pair ever
# changes. `enabled_tools`/`disabled_tools`/... — the same fields
# strip_codex_ui_token's own doc comment above it names — round-trip
# correctly under this approach precisely because it never depends on `codex
# mcp add` being able to re-express them.
#   $1.. = new `codex mcp add azt-mcp` args to attempt
# Returns 0 on a clean replacement, 1 otherwise (registration may be the new
# one, the restored old one, or entirely gone — see the echoed messages).
# On every failure path, config.toml ends up either fully restored or
# untouched — never partially edited — and the backup file is always removed
# before returning, except when the restore copy itself fails (kept then so
# the caller has something to recover from).
codex_mcp_replace() {
  local new_args=("$@")
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local codex_config="$codex_home/config.toml"

  local backup=""
  if [[ -f "$codex_config" ]]; then
    backup="$(mktemp "$codex_config.bak.XXXXXX")"
    if ! cp -p "$codex_config" "$backup"; then
      echo "  azt-mcp (Codex): config.toml のバックアップに失敗しました。登録の置き換えを中止します" >&2
      rm -f "$backup"
      SETUP_HAD_ERRORS=1
      return 1
    fi
  fi

  codex mcp remove azt-mcp >/dev/null 2>&1 || true
  if codex mcp add azt-mcp "${new_args[@]}" >/dev/null 2>&1; then
    rm -f "$backup"
    return 0
  fi

  SETUP_HAD_ERRORS=1

  if [[ -z "$backup" ]]; then
    # No config.toml existed before remove (azt-mcp was never registered on
    # this host) — nothing to restore, just surface that the add failed.
    echo "  azt-mcp (Codex): 登録に失敗しました（元々登録は存在しませんでした。'codex mcp add azt-mcp ...' を手動で再設定してください）" >&2
    return 1
  fi

  echo "  azt-mcp (Codex): 再登録に失敗しました。config.toml をバックアップから復元します..." >&2
  if cp -p "$backup" "$codex_config"; then
    rm -f "$backup"
    # Restoring the file is still a FAILURE outcome for this call — the
    # intended replacement (new_args) never took effect, only reverted.
    # SETUP_HAD_ERRORS is already set above; this always returns 1.
    echo "  azt-mcp (Codex): 元の config.toml を復元しました（意図した変更は未適用です。手動確認してください）" >&2
    return 1
  fi

  echo "  azt-mcp (Codex): config.toml の復元にも失敗しました。バックアップ: $backup を手動で $codex_config に上書きしてください" >&2
  return 1
}

# Issue #29 review, Important finding 3: --prefix mode skips the whole Codex
# CLI block below (skills, AGENTS.md, azt-mcp registration) because a prefix
# profile shares the single non-prefixed `azt-mcp` Codex MCP entry with the
# primary hub — re-registering it here on every prefix profile's setup.sh run
# would clobber that shared entry. But a --purge-operator-token run must
# still be able to remove a leftover AZITO_UI_TOKEN from that shared entry
# even when invoked with --prefix (this is the exact scenario the finding
# names — "この環境は AZITO_HARNESS_PREFIX 運用なので実害が出る構成").
#
# Issue #29 review (3rd pass), Important finding 3: this used to strip the
# token via `codex mcp remove azt-mcp` + `codex mcp add azt-mcp ...`,
# reconstructed only from `command`/`args`/`env` (a `codex mcp get --json`
# reconstruction, the same shape codex_mcp_replace() above used to restore
# a failed re-add with before Issue #29 review 14th pass replaced it with a
# whole-file config.toml backup/restore) — silently dropping every other
# property `codex mcp get --json` can report (`cwd`, `enabled`,
# `enabled_tools`/`disabled_tools`, `startup_timeout_sec`, `tool_timeout_sec`).
# Extending that reconstruction to cover those fields is not actually
# possible: `codex mcp add --help` (checked directly against the installed
# codex-cli, not assumed from docs) exposes no flags to set any of them, so
# a remove+add can never round-trip a registration that uses them, no matter
# how much of `--json`'s output the reconstruction reads back.
#
# Instead this edits Codex's own config file directly: `codex mcp add`
# writes `azt-mcp`'s env vars as a `[mcp_servers.azt-mcp.env]` TOML table in
# `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`; verified against
# the actual file on this host, not inferred from source) — deleting just the
# `AZITO_UI_TOKEN = "..."` line inside that table removes the token and
# touches nothing else in the file, so `cwd`/`enabled`/timeouts and every
# other MCP server's config survive untouched. If that exact TOML shape
# isn't found (a future codex-cli version changing the on-disk format, a
# hand-edited config, etc.), this fails closed (SETUP_HAD_ERRORS=1) rather
# than silently doing nothing or falling back to the lossy remove+add.
# Issue #29 review, Important finding 2 (4th pass): the previous version
# gated the whole purge on `codex` CLI presence (`command -v codex` /
# `codex mcp get azt-mcp`) and treated its absence/failure as "nothing to
# purge" (return 0 = success). But config.toml is edited directly, not via
# the CLI — a machine with codex uninstalled (or a `codex mcp get` that
# fails for any transient reason) can still have a live AZITO_UI_TOKEN
# sitting in config.toml from a prior install, and that token would then
# never be cleaned up while the caller is told the purge succeeded. This
# version inspects/edits $CODEX_HOME/config.toml directly, independent of
# whether the `codex` binary is even present: file-absent is the only case
# treated as "nothing to clean up" (success); a present-but-unparseable
# file, or a present file this script cannot confirm is token-free, fails
# closed (SETUP_HAD_ERRORS=1).
strip_codex_ui_token() {
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local codex_config="$codex_home/config.toml"

  # No config.toml at all means azt-mcp was never registered via `codex mcp
  # add` on this host (or Codex itself was never set up) — genuinely nothing
  # to purge, independent of whether the `codex` binary happens to be on
  # PATH right now.
  if [[ ! -f "$codex_config" ]]; then
    return 0
  fi

  # Issue #29 review, Important finding 2: the write-back below
  # (`mv -f "$tmp" "$codex_config"`) replaces whatever inode currently sits
  # at $codex_config — if that's a symlink (dotfiles managers commonly
  # replace config.toml with one), `mv` overwrites the LINK ITSELF with a
  # plain file, silently detaching it from the link target. The token stays
  # untouched in the (now orphaned) target file, while this step reports
  # "removed" success. Fail closed instead: never resolve/edit the link
  # target (an unpredictable write into a repo this script doesn't own),
  # just surface the target path and require a manual purge there.
  if [[ -L "$codex_config" ]]; then
    echo "  エラー: azt-mcp (Codex): $codex_config はシンボリックリンクです（リンク先: $(readlink "$codex_config")）。dotfiles 管理等の可能性があるため自動編集しません。リンク先のファイルを手動で確認し、AZITO_UI_TOKEN を除去してください" >&2
    SETUP_HAD_ERRORS=1
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "  azt-mcp (Codex): AZITO_UI_TOKEN 除去に node が必要です。$codex_config を手動確認してください" >&2
    # config.toml exists but cannot be inspected/edited without node, so a
    # leftover AZITO_UI_TOKEN cannot be confirmed absent — fail closed
    # rather than returning 0 (which the caller would read as "purged").
    SETUP_HAD_ERRORS=1
    return 1
  fi

  # Preserve the file's existing mode (config.toml holds other MCP servers'
  # secrets too) across the atomic replace below. GNU `stat -c%a` first,
  # BSD/macOS `stat -f%Lp` fallback (matches the pattern used elsewhere in
  # this codebase, e.g. FileBrowseService.ts).
  local orig_mode
  orig_mode="$(stat -c%a "$codex_config" 2>/dev/null || stat -f%Lp "$codex_config" 2>/dev/null || echo 600)"

  # Issue #29 review (7th pass), Important finding 3: the previous version
  # matched the section header and the token key by exact string equality
  # (`trimmed === "[mcp_servers.azt-mcp.env]"`, `/^AZITO_UI_TOKEN\s*=/`) —
  # a quoted table/key segment (`[mcp_servers."azt-mcp".env]`,
  # `"AZITO_UI_TOKEN" = "..."`) or an inline-table form
  # (`env = { AZITO_UI_TOKEN = "..." }` on the `[mcp_servers.azt-mcp]` table
  # itself, no separate `.env` sub-table) is legal TOML that `codex mcp add`
  # (or a hand edit) can plausibly emit, and none of it matched — the purge
  # reported "no-section"/"clean" (success) while the token was still
  # sitting in the file untouched.
  #
  # This version (a) tolerates quote/whitespace variation in both the header
  # and the key, and (b) — since a TOML-shape purge can never enumerate every
  # legal variant a future codex-cli version might emit — treats its own
  # removal as advisory only: after building the candidate output, it
  # re-scans that text for the bare string "AZITO_UI_TOKEN" anywhere at all
  # (not scoped to the azt-mcp section — the conservative reading: this
  # codebase has no other reason to ever write that name into config.toml)
  # and refuses to write the file ("unverified", handled as a failure below)
  # unless that scan comes back clean. A successful "removed"/"clean"/
  # "no-section" result is therefore actually proven token-free, not just
  # believed to be from one specific shape matching.
  #
  # Issue #29 review (9th pass), Important finding 3: an inline-table `env =
  # { ... }` on the [mcp_servers.azt-mcp] table itself is handled by
  # DETECTION only, never by rewriting. An earlier version rebuilt the
  # inline table by splitting its contents on "," and dropping whichever
  # part's key was AZITO_UI_TOKEN — but a fellow entry's own value can
  # legally contain a comma (`env = { OTHER = "a,b", AZITO_UI_TOKEN = "..."
  # }`), which that split corrupted (wrong entries rejoined) while still
  # reporting "removed" success, because the re-scan below only checks for
  # the literal string "AZITO_UI_TOKEN" — a corrupted-but-token-free file
  # passes it. Splitting a TOML value correctly requires an actual TOML
  # parser, which this script deliberately does not depend on (it is run
  # standalone on arbitrary remote hosts via SSH bootstrap — see this
  # file's own header — so every dependency has to be justified against
  # that, and a full TOML parser is not, for what is otherwise a
  # best-effort advisory purge). So instead: an inline-table AZITO_UI_TOKEN
  # is only ever DETECTED, never edited — detection doesn't need to
  # correctly split the table, only to notice the key is present — and
  # detecting it fails the whole purge closed ("manual-removal", handled
  # below) with the offending line shown, rather than risk writing back a
  # silently-corrupted config.toml. The standard sub-table form
  # ([mcp_servers.azt-mcp.env], one key per line) is unaffected — it never
  # had a comma-splitting step, since dropping an entire line needs no
  # value-level parsing at all.
  local tmp result node_status=0
  tmp="$(mktemp "$codex_config.XXXXXX")"
  result="$(node -e '
    const fs = require("fs");
    const [inPath, outPath] = process.argv.slice(1);
    const lines = fs.readFileSync(inPath, "utf8").split("\n");
    const Q = String.fromCharCode(39);
    const DQ = String.fromCharCode(34);

    function stripQuotesAndSpace(s) {
      let out = "";
      for (const ch of s) {
        if (ch === " " || ch === "\t" || ch === Q || ch === DQ) continue;
        out += ch;
      }
      return out;
    }

    // Issue #29 review, 14th pass, Important finding 3: stripQuotesAndSpace
    // strips quote characters but never DECODES a basic (double-quoted)
    // TOML strings backslash escapes (\", \\, \uXXXX, \t, ...) — it just
    // leaves the backslash and whatever follows it in the output as-is. A
    // key legally written with such an escape (e.g. a double-quoted
    // AZITO_UI_TOKEN containing a backslash escape, which TOML decodes to
    // the literal key AZITO_UI_TOKEN) therefore normalizes to something
    // other than the bare string AZITO_UI_TOKEN here — never equal to what
    // every matcher below compares against — so the key silently fails to
    // match ANY of them: not isTokenKeyLine, not hasInlineTokenKey, not
    // isDottedEnvTokenKey, and not the residual re-scan that reuses the
    // same three matchers. The purge reports clean/no-section/removed as if
    // the file were token-free while a live, semantically-identical
    // AZITO_UI_TOKEN key sits in it untouched — exactly the false-negative
    // class of bug the residual re-scan exists to catch, just reached
    // through a decoding gap instead of an unrecognized TOML shape.
    //
    // Correctly decoding every basic-string escape sequence needs a real
    // TOML/JSON-string-literal parser, which this script deliberately does
    // not depend on (see the doc comment on the purge routine above). So
    // instead: a QUOTED key segment containing so much as one backslash is
    // treated as un-decodable, full stop, and fails the whole purge closed
    // (manual-removal) rather than risk comparing an undecoded string and
    // silently missing (or, in principle, wrongly matching) the real key.
    // A single-quoted (literal) TOML string never supports escapes at all —
    // a literal backslash inside a literal string is just a literal
    // backslash, not the start of an escape sequence — so only a
    // double-quoted segment is ever in scope here, matching the actual
    // ambiguity TOML defines.
    //
    // Implemented as a single whole-line scan for a double-quoted,
    // backslash-containing segment sitting directly in KEY position —
    // immediately followed (after only whitespace) by "=" — rather than as
    // a per-matcher helper, because one pattern already covers every shape
    // the matchers below need to worry about on a single line: the standard
    // sub-table form (a double-quoted AZITO_UI_TOKEN key), the inline-table
    // form (env = { ... } — the match fires on the segment INSIDE the
    // braces, not just the outer env key), and the last segment of the
    // dotted form (env."AZITO_UI_TOKEN..." = ... or
    // mcp_servers.azt-mcp.env."AZITO_UI_TOKEN..." = ..., where the escaped
    // segment is always the one immediately preceding "="). It does not
    // catch an escape on a NON-final dotted segment (an escaped env segment
    // rather than an escaped AZITO_UI_TOKEN segment) — an intentionally
    // accepted gap for a shape codex mcp add has never been observed to
    // emit and a hand-editor has essentially no reason to produce, versus
    // the realistic one this exists for.
    function hasEscapedQuotedKeyAssignment(line) {
      return /"[^"]*\\[^"]*"\s*=/.test(line);
    }

    // Issue #29 review, Important finding 2: every matcher below
    // (section-header detection, isTokenKeyLine, hasInlineTokenKey,
    // isDottedEnvTokenKey) is line-oriented — it has no concept of a TOML
    // multi-line string (triple-double-quote or triple-single-quote
    // delimited), which can span many lines and legally contain, as pure
    // string CONTENT, text that reads exactly like a section header
    // (`[mcp_servers.azt-mcp.env]`) or a key=value assignment
    // (`AZITO_UI_TOKEN = "..."`). Feeding such a line to those matchers
    // would treat string content as real TOML structure — at best a false
    // "sawSection"/"removed", at worst dropping or rewriting a line that
    // was never a live key in the first place, corrupting the file while
    // still reporting success. Correctly tracking open/close state for a
    // multi-line string needs a real TOML parser, which this script
    // deliberately does not depend on (see the doc comment above this
    // whole purge routine). So instead: the mere PRESENCE of a
    // triple-double-quote or triple-single-quote marker anywhere in the
    // file — open or close marker, it does not matter which — is enough to
    // fail the whole purge closed ("manual-removal") before any line is
    // rewritten. A false positive here just costs an occasional manual
    // check; treating one as ordinary TOML risks silently corrupting
    // config.toml.
    const TRIPLE_DQ = DQ + DQ + DQ;
    const TRIPLE_SQ = Q + Q + Q;
    const multilineMarkerLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(TRIPLE_DQ) || lines[i].includes(TRIPLE_SQ)) {
        multilineMarkerLines.push((i + 1) + ": " + lines[i]);
      }
    }
    if (multilineMarkerLines.length > 0) {
      process.stdout.write("manual-removal\n" + multilineMarkerLines.join("\n"));
      process.exit(0);
    }

    // Issue #29 review, 14th pass, Important finding 3: same fail-closed
    // treatment as the multiline-marker scan just above, for the same
    // reason — this has to run BEFORE any line is inspected by the
    // key-matching functions below (isTokenKeyLine / hasInlineTokenKey /
    // isDottedEnvTokenKey), all of which compare against stripQuotesAndSpace
    // output that never decodes a quoted keys backslash escapes (see the
    // hasEscapedQuotedKeyAssignment doc comment above). A false "clean"/
    // "no-section"/"removed" verdict reached by silently failing to
    // recognize an escaped AZITO_UI_TOKEN key is worse than the alternative
    // here (an occasional unnecessary manual check on an escape sequence
    // that turns out to belong to some other, unrelated key).
    const escapedKeyLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (hasEscapedQuotedKeyAssignment(lines[i])) {
        escapedKeyLines.push((i + 1) + ": " + lines[i]);
      }
    }
    if (escapedKeyLines.length > 0) {
      process.stdout.write("manual-removal\n" + escapedKeyLines.join("\n"));
      process.exit(0);
    }

    const ENV_SECTION = stripQuotesAndSpace("[mcp_servers.azt-mcp.env]");
    const OWN_TABLE = stripQuotesAndSpace("[mcp_servers.azt-mcp]");

    // True when the assignment key of a line (the text before the first
    // `=`) normalizes, via stripQuotesAndSpace, to exactly `keyName` — the
    // ONE place key-name comparison happens, so env/"env"/(quote) and
    // likewise AZITO_UI_TOKEN are all recognized identically. Issue #29
    // review (13th pass), Important finding 2: hasInlineTokenKey used to
    // match the env key via a regex anchored on the bare literal
    // (/^\s*env\s*=\s*\{/) with NO call through stripQuotesAndSpace at
    // all — a quoted "env" = { "AZITO_UI_TOKEN" = ... } line (legal TOML)
    // matched neither hasInlineTokenKey nor isTokenKeyLine, so the whole
    // line fell through untouched and the purge reported success
    // (no-section/clean) with the token still sitting in the file.
    function assignmentKeyIs(line, keyName) {
      const eq = line.indexOf("=");
      if (eq === -1) return false;
      return stripQuotesAndSpace(line.slice(0, eq)) === keyName;
    }

    function isTokenKeyLine(trimmed) {
      return assignmentKeyIs(trimmed, "AZITO_UI_TOKEN");
    }

    // Detects (never rewrites — see the doc comment above this whole
    // `node -e` block) an `AZITO_UI_TOKEN` key inside an inline-table
    // `env = { ... }` value on the [mcp_servers.azt-mcp] table itself (as
    // opposed to a separate [mcp_servers.azt-mcp.env] table). A TOML key
    // inside `{ ... }` always starts either right after the opening brace
    // or right after a "," — so anchoring on that, after stripping quotes
    // and whitespace (same helper used everywhere else in this script), is
    // enough to notice the key is present without needing to correctly
    // split the inline table into its comma-separated entries — a bare
    // comma split cannot do that once an entry value itself contains a
    // comma.
    function hasInlineTokenKey(line) {
      if (!assignmentKeyIs(line, "env")) return false;
      const m = line.match(/=\s*\{(.*)\}/);
      if (!m) return false;
      return /(^|,)AZITO_UI_TOKEN=/.test(stripQuotesAndSpace(m[1]));
    }

    // Issue #29 review (14th pass), Important finding 1: TOML also allows a
    // DOTTED key assignment — `env.AZITO_UI_TOKEN = "..."` (table-relative,
    // legal anywhere inside `[mcp_servers.azt-mcp]` itself) and
    // `mcp_servers.azt-mcp.env.AZITO_UI_TOKEN = "..."` (fully qualified,
    // legal regardless of the current table context, most naturally written
    // at the top level before any `[...]` header) — that `codex mcp add` has
    // never been observed to emit but a hand edit or a future codex-cli
    // version plausibly could. Neither shape matched isTokenKeyLine (which
    // only recognizes a bare, undotted `AZITO_UI_TOKEN` key) nor
    // hasInlineTokenKey (which only recognizes the `env = { ... }`
    // inline-table form) — both slipped through every check and the
    // residual re-scan below undetected, so the purge reported success
    // while a live AZITO_UI_TOKEN sat in the file untouched.
    //
    // This splits the assignment key on "." and strips quotes/whitespace
    // from each segment (reusing stripQuotesAndSpace, same as every other
    // key comparison in this script), so `env . AZITO_UI_TOKEN`,
    // `"env".AZITO_UI_TOKEN`, `env."AZITO_UI_TOKEN"`, etc. are all
    // recognized identically. It is detection-only, exactly like
    // hasInlineTokenKey: dropping a dotted-key line correctly (vs. an
    // adjacent dotted key on the same table that happens to share a prefix)
    // would need real TOML parsing, which this script deliberately does not
    // depend on (see the doc comment on hasInlineTokenKey above) — so any match fails
    // the whole purge closed (manual-removal) rather than risk an incorrect
    // edit.
    function isDottedEnvTokenKey(line, currentlyInOwnTable) {
      const eq = line.indexOf("=");
      if (eq === -1) return false;
      const keyText = line.slice(0, eq);
      if (!keyText.includes(".")) return false; // undotted keys are handled elsewhere
      const segs = keyText.split(".").map(stripQuotesAndSpace).filter((s) => s.length > 0);
      if (segs.length < 2) return false;
      const tail = segs.slice(-2);
      if (tail[0] !== "env" || tail[1] !== "AZITO_UI_TOKEN") return false;
      if (segs.length === 2) {
        // Table-relative form: resolves against whatever table is
        // currently open, so it only means the azt-mcp env table when we
        // are actually inside [mcp_servers.azt-mcp] right now.
        return currentlyInOwnTable;
      }
      // Fully-qualified form: valid from anywhere, so the current table
      // context does not matter — only the exact segment sequence does.
      return segs.length === 4 && segs[0] === "mcp_servers" && segs[1] === "azt-mcp";
    }

    let inEnvSection = false;
    let inOwnTable = false;
    let sawSection = false;
    let removed = false;
    let manualRemovalNeeded = false;
    const manualRemovalLines = [];
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        const norm = stripQuotesAndSpace(trimmed);
        inEnvSection = norm === ENV_SECTION;
        inOwnTable = norm === OWN_TABLE;
        if (inEnvSection) sawSection = true;
        out.push(line);
        continue;
      }
      if (inEnvSection && isTokenKeyLine(trimmed)) {
        removed = true;
        continue; // drop only this line
      }
      if (inOwnTable && hasInlineTokenKey(line)) {
        // Fail closed rather than rewrite — see the doc comment on
        // hasInlineTokenKey above. Leave the line untouched in `out`
        // (irrelevant either way, since a manual-removal result is never
        // written to disk) and keep scanning so every offending line can
        // be reported at once.
        manualRemovalNeeded = true;
        manualRemovalLines.push(`${i + 1}: ${line}`);
        out.push(line);
        continue;
      }
      if (isDottedEnvTokenKey(line, inOwnTable)) {
        // Fail closed — see the doc comment on isDottedEnvTokenKey above.
        manualRemovalNeeded = true;
        manualRemovalLines.push(`${i + 1}: ${line}`);
        out.push(line);
        continue;
      }
      out.push(line);
    }

    if (manualRemovalNeeded) {
      process.stdout.write("manual-removal\n" + manualRemovalLines.join("\n"));
      process.exit(0);
    }

    // Issue #29 review (11th pass), Important finding 2: the previous
    // version checked `finalText.includes("AZITO_UI_TOKEN")` — a bare
    // substring match over the WHOLE file text. Any unrelated occurrence of
    // that string (a comment left behind by a human, a value like
    // `description = "uses AZITO_UI_TOKEN internally"`, ...) tripped this,
    // and since "unverified" means "refuse to write, fail closed" (see
    // below), the candidate output — which DID correctly remove the real
    // key — was discarded and the ACTUAL token was left sitting in the
    // untouched original file. A residual check whose false positives make
    // the file LESS safe defeats its own purpose.
    //
    // This re-scans line by line for the string appearing specifically as a
    // KEY — reusing the exact same `isTokenKeyLine`/`hasInlineTokenKey`
    // helpers the removal/detection logic above already applies (so the
    // notion of "is this a key" can never drift between removing/detecting
    // and verifying), plus an explicit whole-line-comment (`#...`) skip so a
    // commented-out assignment never counts. Still fails closed on anything
    // it cannot positively rule out: a key-assignment match on ANY line —
    // not just inside the azt-mcp env table — still trips it.
    const finalText = out.join("\n");
    function isFullLineComment(line) {
      return line.trim().startsWith("#");
    }
    // Issue #29 review (14th pass), Important finding 1: also re-checks the
    // dotted-key forms via isDottedEnvTokenKey — as a defense-in-depth
    // safety net (the main loop above already fails every such line closed
    // as soon as it is found, so this should never actually fire in
    // practice), passing `true` unconditionally for the table-relative
    // branch since this scan has no per-line table-context tracking of its
    // own: being overly cautious here (a false positive just fails closed)
    // is safe, unlike in the main loop where table context has to be exact
    // to decide what a relative dotted key even means.
    const stillPresent = out.some((line) => {
      if (isFullLineComment(line)) return false;
      // Issue #29 review, 14th pass, Important finding 3: also re-checks
      // hasEscapedQuotedKeyAssignment — defense-in-depth, same reasoning as
      // the dotted-key re-check above (the pre-loop scan already fails
      // every such line closed before `out` is even built, so this should
      // never actually fire in practice).
      return isTokenKeyLine(line.trim()) || hasInlineTokenKey(line) || isDottedEnvTokenKey(line, true) || hasEscapedQuotedKeyAssignment(line);
    });
    if (stillPresent) {
      // Removal logic believes it handled every AZITO_UI_TOKEN key
      // occurrence it recognized, but a line still carries the key —
      // an unrecognized TOML shape. Refuse to write; caller fails closed.
      process.stdout.write("unverified");
      process.exit(0);
    }
    // Issue #29 review, Important finding 2: same defense-in-depth pattern
    // as the dotted-key re-check above — the multiline-string guard earlier
    // in this script already exits before `out` is even built whenever the
    // ORIGINAL file contains a triple-double-quote or triple-single-quote
    // marker, so this should never actually fire. It exists so that this
    // candidate output is never written as "verified safe" if a multi-line
    // marker is present in it by any path this scripts author did not
    // anticipate.
    const stillHasMultilineMarker = out.some((line) => line.includes(TRIPLE_DQ) || line.includes(TRIPLE_SQ));
    if (stillHasMultilineMarker) {
      process.stdout.write("unverified");
      process.exit(0);
    }
    if (!sawSection && !removed) {
      // azt-mcp has no [mcp_servers.azt-mcp.env] table and no inline `env =`
      // entry on [mcp_servers.azt-mcp] at all (never registered with env
      // vars, or registered without one) — confidently nothing to purge.
      process.stdout.write("no-section");
      process.exit(0);
    }
    if (!removed) {
      // The env table (or azt-mcp table) exists but already has no
      // AZITO_UI_TOKEN entry — already clean.
      process.stdout.write("clean");
      process.exit(0);
    }
    fs.writeFileSync(outPath, finalText);
    process.stdout.write("removed");
  ' "$codex_config" "$tmp")" || node_status=$?

  if [[ "$node_status" -ne 0 ]]; then
    rm -f "$tmp"
    echo "  azt-mcp (Codex): $codex_config の解析に失敗しました。手動確認してください" >&2
    SETUP_HAD_ERRORS=1
    return 1
  fi

  # `result`'s first line is the status token; a "manual-removal" status
  # carries the offending line(s) (1-based line number + source text) on
  # the lines that follow — see the node script's doc comment above for why
  # those lines are reported rather than auto-edited.
  local result_status result_detail
  result_status="$(printf '%s\n' "$result" | head -n1)"
  result_detail="$(printf '%s\n' "$result" | tail -n +2)"

  case "$result_status" in
    removed)
      chmod "$orig_mode" "$tmp"
      mv -f "$tmp" "$codex_config"
      echo "  azt-mcp (Codex): --purge-operator-token により config.toml から AZITO_UI_TOKEN を除去しました"
      ;;
    no-section|clean)
      rm -f "$tmp"
      ;;
    manual-removal)
      rm -f "$tmp"
      echo "  エラー: azt-mcp (Codex): $codex_config のインラインテーブル (env = { ... })・ドット区切りキー (env.AZITO_UI_TOKEN = ... 等)・複数行文字列 (\"\"\"...\"\"\" / '''...''') のいずれかが見つかりましたが、標準のサブテーブル形式ではないため自動編集は行いません。以下の行を手動で確認・除去してください:" >&2
      echo "$result_detail" >&2
      SETUP_HAD_ERRORS=1
      return 1
      ;;
    unverified)
      rm -f "$tmp"
      echo "  エラー: azt-mcp (Codex): $codex_config から AZITO_UI_TOKEN を確実に除去できませんでした（既知の除去処理を適用した後も、ファイル内に AZITO_UI_TOKEN という文字列が残っています）。手動で確認・削除してください" >&2
      SETUP_HAD_ERRORS=1
      return 1
      ;;
    *)
      rm -f "$tmp"
      echo "  azt-mcp (Codex): $codex_config の解析結果を判定できませんでした。手動確認してください" >&2
      SETUP_HAD_ERRORS=1
      return 1
      ;;
  esac
}

# ── Codex CLI ──
echo ""
echo "=== Codex CLI ==="
# Issue #29 review (5th pass), Critical finding 2: --purge-operator-token
# must strip a leftover AZITO_UI_TOKEN from $CODEX_HOME/config.toml
# unconditionally — run BEFORE the prefix / codex-CLI-presence / ~/.codex
# directory-presence branching below, not nested inside only the --prefix
# arm. The normal (non-prefix) arm below only proceeds past its `elif`
# guard when `codex` is on PATH or `$HOME/.codex` exists; a host that had
# Codex CLI uninstalled (or never had `$HOME/.codex`) but still has a
# config.toml under a custom `$CODEX_HOME` previously fell straight to the
# final `else` ("スキップ (codex 未検出)") and never called
# strip_codex_ui_token at all, silently leaving that token in place despite
# the caller being told the purge ran. strip_codex_ui_token itself already
# respects `$CODEX_HOME` (falling back to `~/.codex`, see its doc comment)
# and treats a missing config.toml as "nothing to purge" (return 0), so
# calling it unconditionally here is safe on every host shape — it is a
# pure no-op when there is genuinely nothing to strip.
if [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
  strip_codex_ui_token
fi
if [[ -n "$AZITO_PREFIX" ]]; then
  echo "  スキップ (--prefix モード)"
elif [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
  # Issue #29 review (10th pass), Important finding 2: purge mode is
  # standalone token-removal only — strip_codex_ui_token above already did
  # the ONLY thing this run is supposed to do to Codex's config. Falling
  # through into the normal remove/add flow below (codex_mcp_replace)
  # would rebuild the whole azt-mcp entry from CODEX_MCP_ADD_ARGS
  # (`AZITO_URL=$AZITO_URL_VALUE`, which defaults to
  # http://localhost:3001 when --azito-url is omitted — see the matching
  # Claude-side fix above for the identical shape of this bug), silently
  # overwriting the URL and dropping any other properties
  # (cwd/startup_timeout_ms/...) the existing entry had. Also skips the
  # Codex skills symlinks/AGENTS.md write below — neither touches a
  # token, but both are part of the same "normal registration flow"
  # purge mode is documented (see usage_exit's --purge-operator-token
  # help text) to run standalone from.
  echo "  スキップ (--purge-operator-token — トークン除去のみ実施済み)"
elif command -v codex >/dev/null 2>&1 || [[ -d "$HOME/.codex" ]]; then
  # Skills
  link_skills "$HOME/.codex/skills"

  # MCP
  if command -v codex >/dev/null 2>&1; then
    # --ui-token 未指定での再実行時、remove/add により既存の env トークンが
    # 失われないよう、remove する前に既存の AZITO_UI_TOKEN を退避しておく。
    # --purge-operator-token 指定時はこの退避自体を行わない（Issue #29
    # review, Critical finding 3）——退避すれば直後の EFFECTIVE_AZT_MCP_UI_TOKEN
    # 計算で復元されてしまい、掃除にならない。
    EXISTING_AZT_MCP_UI_TOKEN=""
    if [[ -z "$AZITO_UI_TOKEN" && "$AZITO_PURGE_OPERATOR_TOKEN" != "1" ]] && command -v node >/dev/null 2>&1 && codex mcp get azt-mcp >/dev/null 2>&1; then
      EXISTING_AZT_MCP_UI_TOKEN="$(codex mcp get azt-mcp --json 2>/dev/null | node -e '
        let data = "";
        process.stdin.on("data", (c) => { data += c; });
        process.stdin.on("end", () => {
          try {
            const json = JSON.parse(data);
            const token = json?.transport?.env?.AZITO_UI_TOKEN;
            if (typeof token === "string" && token) process.stdout.write(token);
          } catch { /* JSON解析失敗時は空のまま */ }
        });
      ' 2>/dev/null || true)"
    fi

    # Issue #29 review, Important finding 1 (2nd pass): a failed re-add is
    # now recovered via codex_mcp_replace()'s own whole-file config.toml
    # backup/restore (Issue #29 review, 14th pass, Important finding 3) —
    # taken from INSIDE that function, immediately before `codex mcp
    # remove` runs, so no separate `codex mcp get --json` snapshot needs to
    # be captured here beforehand.
    CODEX_MCP_ADD_ARGS=(--env "AZITO_URL=$AZITO_URL_VALUE")
    EFFECTIVE_AZT_MCP_UI_TOKEN="${AZITO_UI_TOKEN:-$EXISTING_AZT_MCP_UI_TOKEN}"
    if [[ -n "$EFFECTIVE_AZT_MCP_UI_TOKEN" ]]; then
      CODEX_MCP_ADD_ARGS+=(--env "AZITO_UI_TOKEN=$EFFECTIVE_AZT_MCP_UI_TOKEN")
    elif [[ "$AZITO_PURGE_OPERATOR_TOKEN" == "1" ]]; then
      echo "  azt-mcp (Codex): --purge-operator-token により AZITO_UI_TOKEN を除去しました"
    else
      echo "  警告: AZITO_UI_TOKEN が設定されていません。--ui-token を付けて再実行してください"
    fi
    if codex_mcp_replace "${CODEX_MCP_ADD_ARGS[@]}" -- node "$MCP_SERVER_PATH"; then
      echo "  azt-mcp: 登録しました"
    else
      echo "  azt-mcp: 登録に失敗しました（codex mcp add エラー）"
    fi
  else
    echo "  azt-mcp: スキップ (codex コマンドが見つかりません)"
  fi

  # Rules -> ~/.codex/AGENTS.md マーカー管理ブロック
  CODEX_AGENTS_MD="$HOME/.codex/AGENTS.md"
  if command -v node >/dev/null 2>&1; then
    mkdir -p "$HOME/.codex"
    node -e "
      const fs = require('fs');
      const path = require('path');
      const agentsPath = process.argv[1];
      const modulesDir = process.argv[2];

      const BEGIN = '<!-- AZITO-HARNESS:BEGIN (managed by harness/setup.sh) -->';
      const END = '<!-- AZITO-HARNESS:END -->';

      const files = fs.readdirSync(modulesDir)
        .filter(f => f.endsWith('.md'))
        .sort();
      const content = files.map(f => fs.readFileSync(path.join(modulesDir, f), 'utf8').trimEnd()).join('\n\n');
      const block = BEGIN + '\n' + content + '\n' + END;

      let existing = '';
      try { existing = fs.readFileSync(agentsPath, 'utf8'); } catch {}

      const beginIdx = existing.indexOf(BEGIN);
      const endIdx = existing.indexOf(END);

      let result;
      if (beginIdx !== -1 && endIdx !== -1) {
        result = existing.substring(0, beginIdx) + block + existing.substring(endIdx + END.length);
      } else {
        result = existing ? existing.trimEnd() + '\n\n' + block + '\n' : block + '\n';
      }

      fs.writeFileSync(agentsPath, result);
      console.log('  AGENTS.md: 更新しました (' + files.length + ' モジュール)');
    " "$CODEX_AGENTS_MD" "$HARNESS_DIR/prompt-modules"
  else
    echo "  AGENTS.md: スキップ (node が見つかりません)"
  fi
else
  echo "  スキップ (codex 未検出)"
fi

echo ""
echo "セットアップ完了"
if [[ -n "$AZITO_WEBHOOK_TOKEN" ]]; then
  echo ""
  echo "注意: AZITO サーバーも同じトークンで起動してください（通知・稼働検出 Webhook 共通）:"
  echo "  AZITO_WEBHOOK_TOKEN=$AZITO_WEBHOOK_TOKEN npm run dev"
fi

# Issue #29 review, Important finding 1 (2nd pass): a codex mcp
# remove→add replacement failure (see codex_mcp_replace()) no longer
# silently exits 0 — it sets SETUP_HAD_ERRORS=1 above but lets the rest of
# setup (skills/AGENTS.md) run to completion first. Checked last so
# HarnessInstaller.install()/installLocal() (which key `result.success` off
# this process's exit code) and, transitively,
# PUT /api/servers/:name's attemptIsolationCleanup() record `cleanup:
# 'failed'` instead of `'done'` when the intended MCP registration change
# did not actually happen.
if [[ "$SETUP_HAD_ERRORS" == "1" ]]; then
  echo ""
  echo "警告: 一部の手順が失敗しました（上記ログを確認してください）" >&2
  exit 1
fi
