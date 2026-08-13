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
AZITO_PREFIX="${AZITO_PREFIX:-}"

# ── 引数パース ──
usage_exit() {
  echo "Usage: $0 [--azito-url http://host:3001] [--webhook-token <token>] [--ui-token <token>] [--server-name <name>] [--prefix <prefix>]" >&2
  echo "" >&2
  echo "  --prefix <name>  この配線を独立したハブ用プロファイルとして扱う。設定は" >&2
  echo "                   ~/.azito/azitoctl-<name>.env に書き出され、hook コマンドには" >&2
  echo "                   AZITO_PREFIX=<name> が埋め込まれる。1台から複数のハブへ" >&2
  echo "                   シグナルを送る場合は、ハブごとに --prefix を変えて実行する" >&2
  echo "                   （URL・トークン・サーバー名はプロファイル単位でまとめて解決され、" >&2
  echo "                   変数単位の部分上書きはできない）。" >&2
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
      shift 2
      ;;
    --ui-token=*)
      AZITO_UI_TOKEN="${1#*=}"
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
    *)
      echo "Unknown option: $1" >&2
      usage_exit
      ;;
  esac
done

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
if [[ -z "$AZITO_PREFIX" ]]; then
  link_skills "$HOME/.claude/skills"
else
  echo "  スキップ (--prefix モード)"
fi

# ── Rules (prompt-modules → ~/.claude/rules/) ──
echo ""
echo "=== Rules (prompt-modules) ==="
if [[ -z "$AZITO_PREFIX" ]]; then
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

if [[ -f "$NOTIFY_HOOK_SCRIPT" ]]; then
  chmod +x "$NOTIFY_HOOK_SCRIPT"
fi
if [[ -f "$ACTIVITY_HOOK_SCRIPT" ]]; then
  chmod +x "$ACTIVITY_HOOK_SCRIPT"
fi
if [[ -f "$INTERACTION_HOOK_SCRIPT" ]]; then
  chmod +x "$INTERACTION_HOOK_SCRIPT"
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
echo ""
echo "=== azitoctl.env ==="
if [[ -n "$AZITO_URL" && -n "$AZITO_WEBHOOK_TOKEN" ]]; then
  AZITOCTL_ENV_DIR="$HOME/.azito"
  AZITOCTL_ENV_FILE="$AZITOCTL_ENV_DIR/azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env"
  mkdir -p "$AZITOCTL_ENV_DIR"
  # azitoctl / azs がこのファイルを source するため、値は printf %q で必ず
  # シェルクォートする（生値だと空白・引用符で壊れ、$() は任意コマンド
  # 実行になる）。hook コマンドの ENV_PREFIX 埋め込みと同じ流儀。
  {
    printf 'AZITO_URL=%q\n' "$AZITO_URL"
    printf 'AZITO_WEBHOOK_TOKEN=%q\n' "$AZITO_WEBHOOK_TOKEN"
    if [[ -n "$AZITO_UI_TOKEN" ]]; then
      printf 'AZITO_UI_TOKEN=%q\n' "$AZITO_UI_TOKEN"
    fi
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
  } > "$AZITOCTL_ENV_FILE"
  chmod 600 "$AZITOCTL_ENV_FILE"
  echo "  $AZITOCTL_ENV_FILE: 書き出しました"
else
  echo "  スキップ (--azito-url と --webhook-token の両方が必要)"
fi

# node が使えれば自動マージ、なければ手動案内にフォールバック
if command -v node >/dev/null 2>&1; then
  mkdir -p ~/.claude
  node -e "
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

    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

    let changed = false;
    const messages = [];

    // MCP Server
    if (mcpServerExists) {
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
      messages.push('  azt-mcp: スキップ (MCP サーバーが見つかりません)');
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
    "$INTERACTION_HOOK_SCRIPT"

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
    echo '  }'
    echo ""
  fi
fi

# ── Codex CLI ──
echo ""
echo "=== Codex CLI ==="
if [[ -n "$AZITO_PREFIX" ]]; then
  echo "  スキップ (--prefix モード)"
elif command -v codex >/dev/null 2>&1 || [[ -d "$HOME/.codex" ]]; then
  # Skills
  link_skills "$HOME/.codex/skills"

  # MCP
  if command -v codex >/dev/null 2>&1; then
    # --ui-token 未指定での再実行時、remove/add により既存の env トークンが
    # 失われないよう、remove する前に既存の AZITO_UI_TOKEN を退避しておく。
    EXISTING_AZT_MCP_UI_TOKEN=""
    if [[ -z "$AZITO_UI_TOKEN" ]] && command -v node >/dev/null 2>&1 && codex mcp get azt-mcp >/dev/null 2>&1; then
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

    if codex mcp get azt-mcp >/dev/null 2>&1; then
      codex mcp remove azt-mcp >/dev/null 2>&1 || true
    fi
    CODEX_MCP_ADD_ARGS=(--env "AZITO_URL=$AZITO_URL_VALUE")
    EFFECTIVE_AZT_MCP_UI_TOKEN="${AZITO_UI_TOKEN:-$EXISTING_AZT_MCP_UI_TOKEN}"
    if [[ -n "$EFFECTIVE_AZT_MCP_UI_TOKEN" ]]; then
      CODEX_MCP_ADD_ARGS+=(--env "AZITO_UI_TOKEN=$EFFECTIVE_AZT_MCP_UI_TOKEN")
    else
      echo "  警告: AZITO_UI_TOKEN が設定されていません。--ui-token を付けて再実行してください"
    fi
    if codex mcp add azt-mcp "${CODEX_MCP_ADD_ARGS[@]}" -- node "$MCP_SERVER_PATH" >/dev/null 2>&1; then
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
