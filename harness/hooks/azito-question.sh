#!/bin/bash
# Claude Code PermissionRequest hook — forward an *open* AskUserQuestion, question text and
# all, to AZITO so the chat view can render an answerable question card instead of the bare
# "waiting for an answer" banner. Sibling script to azito-interaction.sh: same destination
# profile resolution, same fire-and-forget curl, same POST /api/webhooks/agent-interaction
# with event "open" — the only difference is that this one can also fill in `content`.
#
# Why this event: PermissionRequest fires the instant AskUserQuestion opens its picker (it
# fires even under bypassPermissions) and its stdin payload carries the complete `tool_input`
# (`questions: [{question, header, multiSelect, options: [{label, description}]}]`). The
# Notification hook, by contrast, only reports *that* input is being waited on and only about
# a minute later. Both signals open the same pending state; InteractionMonitor keeps whichever
# one carried content, regardless of arrival order.
#
# ── This hook MUST NOT influence the permission decision ──
# A PermissionRequest hook can steer Claude Code's allow/deny by what it prints on stdout.
# This hook is a pure observer: it writes NOTHING to stdout on any path (the curl runs in the
# background with stdout redirected to /dev/null; the JSON helper's output is captured into a
# shell variable, never echoed) and always exits 0. Every non-AskUserQuestion permission
# request returns immediately, before any work — no output, no delay, no side effects.
set -euo pipefail

# Read stdin once, up front: every exit path below must consume it (a hook that leaves the
# payload unread can make the caller's write block).
STDIN_JSON="$(cat 2>/dev/null || true)"

# No jq dependency (matches azito-activity.sh / azito-interaction.sh): pull tool_name out with
# a defensive grep -o that cannot fail fatally under `set -e` when the field is missing.
TOOL_NAME="$(grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' <<< "$STDIN_JSON" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true)"

# Everything that is not an AskUserQuestion is none of this hook's business — see the
# "MUST NOT influence the permission decision" note above.
if [[ "$TOOL_NAME" != "AskUserQuestion" ]]; then
  exit 0
fi

# ── Destination profile resolution (keep in sync with azito-activity.sh) ──
# AZITO_URL / AZITO_WEBHOOK_TOKEN / AZITO_SERVER_NAME are always resolved as ONE profile,
# never merged per-variable. Overriding just the URL inline while the token still comes from
# the env file would send another hub's token to that inline endpoint — an auth failure *and*
# a credential disclosure to a hub that has no business seeing it.
#
# Resolution rules:
#   1. all three present in the environment → use that set as is (env file not read)
#   2. otherwise → drop whatever partial values are in the environment and take the whole set
#      from the env file selected by AZITO_PREFIX (mode 600, so the token never has to appear
#      in argv)
#
# Rule 2 drops partial values rather than filling the gaps from the file, and it is the common
# path: the hub injects AZITO_URL into every tmux session/window it creates, so "URL only, no
# token" is the normal ambient state. Treating that as a partial profile is exactly the unsafe
# merge. Switching destinations is therefore done with AZITO_PREFIX
# (`~/.azito/azitoctl-<prefix>.env`), never by overriding individual variables.
if [[ -n "${AZITO_URL:-}" && -n "${AZITO_WEBHOOK_TOKEN:-}" && -n "${AZITO_SERVER_NAME:-}" ]]; then
  : # complete profile supplied by the caller — use it untouched
else
  AZITO_URL=""
  AZITO_WEBHOOK_TOKEN=""
  AZITO_SERVER_NAME=""
  AZITOCTL_ENV="$HOME/.azito/azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env"
  if [[ -f "$AZITOCTL_ENV" ]]; then
    set +u
    . "$AZITOCTL_ENV"
    set -u
  fi
fi

AZITO_URL="${AZITO_URL:-http://localhost:3001}"
AZITO_WEBHOOK_TOKEN="${AZITO_WEBHOOK_TOKEN:-}"
AZITO_SERVER_NAME="${AZITO_SERVER_NAME:-}"

if [[ -z "$AZITO_WEBHOOK_TOKEN" || -z "$AZITO_SERVER_NAME" ]]; then
  exit 0
fi

if [[ -z "${TMUX_PANE:-}" ]] || ! command -v tmux >/dev/null 2>&1; then
  exit 0
fi

# AZITO creates a per-tab tmux *linked session* (`tmux new-session -t <src> -s
# _azito_<src>_<ts>`, sharing the same window group). For a pane reached via a linked session,
# #{session_name} resolves to that throwaway `_azito_*` name, not the canonical session the
# `windows` table keys on — so the lookup would silently miss and the signal gets dropped.
# #{session_group} resolves to the *original* session name in both linked and unlinked cases,
# so prefer it whenever the pane's session is grouped.
IDENT="$(tmux display-message -p -t "$TMUX_PANE" '#{?session_grouped,#{session_group},#{session_name}}|#{window_index}|#{window_name}|#{pane_index}' 2>/dev/null)" || exit 0
[[ -n "$IDENT" ]] || exit 0

IFS='|' read -r SESSION_NAME WINDOW_INDEX WINDOW_NAME PANE_INDEX <<< "$IDENT"

# A window name containing `|` would shift the IFS split above and corrupt the numeric fields —
# verify both indices are pure digits before sending.
if [[ ! "$WINDOW_INDEX" =~ ^[0-9]+$ || ! "$PANE_INDEX" =~ ^[0-9]+$ ]]; then
  exit 0
fi

# NOTE (v1): session/window names containing JSON-special characters (`"`, `\`) are a
# theoretical gap — AZITO-generated tmux names never contain them, so this is intentionally out
# of scope for now. As a minimal safety guard, skip sending rather than emit malformed JSON.
for value in "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_NAME"; do
  if [[ "$value" == *'"'* || "$value" == *'\'* ]]; then
    exit 0
  fi
done

PAYLOAD=$(printf '{"serverName":"%s","sessionName":"%s","windowIndex":%s,"windowName":"%s","paneIndex":%s,"event":"open","muxPaneRef":"%s"}' \
  "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_INDEX" "$WINDOW_NAME" "$PANE_INDEX" "${TMUX_PANE:-}")

# ── content（任意）──
# 質問文・選択肢は自由文字列（改行・引用符・非 ASCII を含みうる）なので、bash の文字列操作で
# JSON を組み立てるのは安全に行えない。ここだけは node に委ね、node が無い環境では content
# なしで送る（＝チャットはバナー表示に退化するが、シグナル自体は失わない）。標準入力経由で
# 渡すのは、質問文が argv に載って `ps` から読めるのを避けるため。
CONTENT_JSON=""
if command -v node >/dev/null 2>&1; then
  CONTENT_JSON="$(printf '%s' "$STDIN_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(raw);
        const questions = payload && payload.tool_input && payload.tool_input.questions;
        if (!Array.isArray(questions) || questions.length === 0) return;
        const normalized = questions.map((q) => ({
          question: String((q && q.question) || ""),
          header: q && q.header != null ? String(q.header) : undefined,
          multiSelect: !!(q && q.multiSelect),
          options: (q && Array.isArray(q.options) ? q.options : []).map((o) => ({
            label: String((o && o.label) || ""),
            description: o && o.description != null ? String(o.description) : undefined,
          })),
        }));
        process.stdout.write(JSON.stringify({ toolName: String(payload.tool_name), questions: normalized }));
      } catch {
        /* 壊れた/想定外のペイロードは content なしで送る（サーバー側も不正 content を捨てて受理する） */
      }
    });
  ' 2>/dev/null || true)"
fi

# 32KB 上限ガード: 巨大な質問（長い description 等）でハブ側のボディ上限や余計な転送コストに
# 当たるくらいなら、content を落としてバナーに退化させる方が確実に届く。
if [[ -n "$CONTENT_JSON" ]]; then
  CANDIDATE=$(printf '{"serverName":"%s","sessionName":"%s","windowIndex":%s,"windowName":"%s","paneIndex":%s,"event":"open","muxPaneRef":"%s","content":%s}' \
    "$AZITO_SERVER_NAME" "$SESSION_NAME" "$WINDOW_INDEX" "$WINDOW_NAME" "$PANE_INDEX" "${TMUX_PANE:-}" "$CONTENT_JSON")
  if [[ ${#CANDIDATE} -le 32768 ]]; then
    PAYLOAD="$CANDIDATE"
  fi
fi

# Fire-and-forget in the background so this never blocks Claude's turn.
#
# Neither the token nor the question text may appear in curl's argv (`ps` exposes it to every
# local user), and the payload here is not a fixed shape like the sibling hooks' — it carries
# whatever the agent asked about, which can be as sensitive as the conversation itself. Both
# therefore reach curl out of band, and since only one of them can use stdin:
#   - payload → stdin, via `--data-binary @-` (a pipe, so no size limit and no shell quoting)
#   - token   → `--config <(...)`, i.e. a process substitution curl reads as a file. The
#               substitution runs bash's *builtin* printf in a subshell, so the token is never
#               a separate process's argument either, and no file is left behind on disk
#               (contrast a temp file, which would need mode 600 and cleanup on every exit path).
# This keeps the same "token never in argv" guarantee as azito-activity.sh's `--config -`.
( printf '%s' "$PAYLOAD" | curl -sf \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$AZITO_WEBHOOK_TOKEN") \
    -X POST "${AZITO_URL}/api/webhooks/agent-interaction" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    --max-time 3 \
    >/dev/null 2>&1 || true
) &

exit 0
