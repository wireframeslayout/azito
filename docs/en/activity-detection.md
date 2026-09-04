# Activity Detection Tier Reference

The complete specification of how AZITO decides whether an agent window is running, blocked,
or idle. It covers the five observation sources and their priority order, stop reasons,
timing constants, how to read the diagnostics panel, the AskUserQuestion interaction
lifecycle, and what is supported per server type.

The core of the judgment is `packages/server/src/modules/operations/AgentActivityMonitor.ts`.
Every constant name below matches the implementation.

## 1. Overview -- the priority ladder

`AgentActivityMonitor` evaluates every window (key = `serverName::target`, pane suffix
normalized) **every 5 seconds**. Each key is asked top-down and **settles at the first tier
that reaches a verdict**, so a lower tier's `working` can never structurally overwrite a
higher tier's `idle`.

```
Tier 0  tui-supervisor (event-driven, highest priority)
        A PTY wrapper around the agent reports active / idle / exit directly over
        WebSocket. Latency ~1s. Lower tiers are bypassed entirely for a connected key
   |  if not connected / no frame received yet
   v
Tier 1  Claude Code hooks (event-driven)
        UserPromptSubmit sends "start", Stop sends "stop" via webhook. Latency: immediate.
        On a crash the state lapses when the foreground reverts to a bare shell
   |  if no signal
   v
Tier 2  Pane classification (polling, title/screen rules)
        Classified from the pane title glyph (◐◑◒◓ = working / ✳ = idle) and the screen
        tail ("esc to interrupt" = working, a permission prompt = blocked). Latency ~5s
   |  if unclassifiable (unknown)
   v
Tier 3  Activity heuristic (polling)
        tmux window_activity advanced within 30s AND the foreground command is not a bare
        shell. Start is debounced
   |  if still undecided
   v
Tier 4  Process liveness + session transcript (background probe)
        Finds claude/codex in the pane's process tree and classifies the tail of the
        session JSONL. The catch-all for hand-launched panes with neither a supervisor
        nor hooks. Additive, working-only verdict
```

### Three special cases

| Case | Behavior |
|---|---|
| Execution runs (task execution) | A run registered as in-flight counts as running with no detection at all (registered = running). If a supervisor is attached, its active/idle refines that |
| Supervisor-only entries | Even with no row in the `windows` table, a connected supervisor is itself grounds for appearing in the activity snapshot (e.g. a hand-launched `azs claude` pane) |
| Blocked refinement | Only for keys where Tier 0 reported `idle` (and keys whose idle title Tier 2 classified), the screen rules additionally check for a waiting-for-answer prompt (an AskUserQuestion picker, etc.); if matched, the state is refined to **blocked**. While blocked, no `completed` transition is emitted -- completion is only announced once the prompt clears. **It never promotes to `working`** (the ladder invariant holds) |

Blocked refinement exists because the supervisor can only see the title. Claude Code keeps
the idle glyph (`✳ `) in the title while an AskUserQuestion picker is open, so a
title-only observer reports idle.

## 2. Tier 0 -- supervisor (the real-time primary)

`tui-supervisor` launches the agent wrapped in a PTY and holds a persistent WebSocket to the
hub (`/ws/supervisor`) with a 10s heartbeat and unbounded exponential-backoff reconnection.

### Judgment inside the supervisor

| Detector | Behavior |
|---|---|
| Title tracking | Parses OSC 0/2 titles in the PTY output. Switches to title-authoritative mode **only after observing a recognized marker** (working `⠀-⣿ ◐◑◒◓ ✻✶✽✢∗` / idle `✳ ` / `Action Required`). All titles within one chunk are judged cumulatively (independent of chunk boundaries) |
| Byte-volume tracking | Decides active/idle from output volume in a 3s window. Stays in effect before title-authoritative mode (a generic TUI whose titles are never recognized) |
| Sending | An activity frame is sent **on transition**, plus a 15s keepalive resend while active. Child process exit is sent explicitly as `child_exit` |

### How the hub treats it

The state a connected supervisor reports is **authoritative for that key**; Tiers 1-4 are not
consulted. The state only disappears on `child_exit` or WS disconnect (never through
inference). Measured latency for a start is **about 1 second**.

For diagnostics, a Tier 0 verdict carries the time its signal was received (`evidenceAt`).
While a supervisor has reconnected but not yet sent a frame, the old connection's verdict is
not displayed as "Tier 0 alive" -- it degrades to undecided / awaiting frame.

### Re-exporting TMUX / TMUX_PANE to the child process

`PtyProxy` launches the child command through `$SHELL -lc` -- the login shell is required so
PATH resolves (nvm/nodenv/Homebrew). But login profile processing frequently drops `TMUX` and
`TMUX_PANE`, and every Claude Code hook (`azito-activity`, `azito-interaction`,
`azito-notify`, `azito-question`) exits early when `TMUX_PANE` is empty. The result was that
Tier 1 signals, the pending-answer banner, and completion notifications were silent in every
supervised window.

`buildLoginShellCommand()` (`packages/tui-supervisor/src/PtyProxy.ts`) now re-exports both
variables at the head of the command string, but only when they have a value. Because that
runs after profile evaluation, they are reliably restored. Nothing is injected when launched
outside tmux.

### Supervisor credential resolution (AZITO_PREFIX support)

The supervisor resolves `AZITO_URL` / `AZITO_WEBHOOK_TOKEN` via `resolveHubEnv()`
(`packages/tui-supervisor/src/env.ts`). Resolution order: process environment variables first,
then the env file.

When the hub runs in `--prefix` mode (`AZITO_HARNESS_PREFIX` is set), it embeds
`AZITO_PREFIX=<prefix>` as an env variable on the supervisor's launch command
(`SupervisorLaunch.wrapWithSupervisor()`). The supervisor reads `AZITO_PREFIX` and resolves
`~/.azito/azitoctl-<prefix>.env` to obtain the hub's `AZITO_WEBHOOK_TOKEN`. When no prefix is
set, it reads `~/.azito/azitoctl.env` as before.

This follows the same `AZITO_PREFIX` convention as Tier 1's "Atomic destination-profile
resolution" (§3 below). The env file written by `harness/setup.sh --prefix <name>` is selected
by both hooks and the supervisor using the same convention.

### Combined mode (hybrid detection)

Starting with Claude Code v2.1.236, pane titles under tmux are written only when the text
actually changes (CHANGELOG: "Fixed terminal tab titles jumping in tmux"). As a result, the
working spinner glyph (◐◑◒◓ etc.) no longer appears in the title, which stays fixed at
`✳ <topic>`.

`ActivityTracker` addresses this with two detection modes:

| Mode | Entry condition | Detection method |
|------|----------------|-----------------|
| **title-authoritative** | A `working` or `blocked` title observed at least once | Title only (byte volume disabled). Codex / Claude ≤2.1.234 enter this mode |
| **combined** | Otherwise (including initial state) | Byte-volume heuristic + title promotion. Claude ≥2.1.236 on tmux stays here |

In combined mode:

- The byte-volume heuristic determines idle/active
- Echo filtering: the threshold must be exceeded **with fresh output in that tick** for
  `ACTIVE_CONSECUTIVE_TICKS` (2) consecutive ticks before transitioning idle→active (a single
  keystroke echo burst does not trigger a transition)
- Observing a `working` / `blocked` title instantly promotes the tracker to
  title-authoritative mode
- Active frames emitted in combined mode carry no `status` (allowing the hub to distinguish
  byte-derived activity)

| Constant | Value | Description |
|----------|-------|-------------|
| `ACTIVE_CONSECUTIVE_TICKS` | 2 | Consecutive above-threshold ticks needed for idle→active (only ticks with fresh output count) |

### Registration snapshot frame

On receiving a `registered` message, `HubClient` sends the `ActivityTracker`'s current state
as a single activity frame (at the same point as the `ready` re-send). This ensures the hub
receives a known baseline even when activity transitions that occurred before registration
were dropped. This also fires on reconnect.

## 3. Tier 1 -- Claude Code hooks

| Element | Behavior |
|---|---|
| Signal | `UserPromptSubmit` hook → `start`, `Stop` hook → `stop`, posted to `POST /api/webhooks/agent-activity` (shared `AZITO_WEBHOOK_TOKEN`) |
| Key resolution | tmux `#{?session_grouped,#{session_group},#{session_name}}` -- so even a browser-tab linked session (`_azito_*`) matches the `windows` table under the canonical session name. Applied to **every matching window row** |
| Effect | Flips that key's state immediately, bypassing Tiers 2/3 |
| Lapse | Crash failsafe: cleared when the foreground pane reverts to a bare shell without a Stop signal. Also cleared when the window disappears |
| Prerequisite | Each server must be wired with `harness/setup.sh`. In an unwired environment the hooks never fire and the lower tiers take over |

### Atomic destination-profile resolution (the AZITO_PREFIX convention)

`AZITO_URL`, `AZITO_WEBHOOK_TOKEN` and `AZITO_SERVER_NAME` are **always resolved as one
profile**, never merged per variable.

| Rule | Condition | Action |
|---|---|---|
| 1 | All three present in the environment | Use that set untouched (the env file is not read) |
| 2 | Otherwise | Discard every partial value in the environment and take the whole set from the env file selected by `AZITO_PREFIX` (`~/.azito/azitoctl[-<prefix>].env`, mode 600) |

Rule 2 drops partial values rather than gap-filling them because the hub injects `AZITO_URL`
into every tmux session/window it creates, so "URL present, token absent" is the normal
ambient state. Adopting that partial profile would send **another hub's token** from the env
file to the injected URL -- an auth failure and a credential disclosure at once.

Switching destinations is therefore done with **`AZITO_PREFIX` alone**, never by overriding
individual variables. `harness/setup.sh --prefix <name> ...` writes that env file and embeds
only `AZITO_PREFIX` into the hook command in settings.json. The token reaches curl via
`--config -` (stdin) and never appears in argv.

After resolution, an empty `AZITO_WEBHOOK_TOKEN` or `AZITO_SERVER_NAME` makes the hook exit 0
without doing anything.

Scripts involved: `harness/hooks/azito-activity.sh`, `azito-interaction.sh`,
`azito-question.sh`.

## 4. Tier 2 -- pane classification (title/screen)

Every 5s poll classifies the pane title and screen tail with rules (`paneStateClassifier.ts`).
The rule lists are first-match-wins and use **the same glyph set** as the supervisor's title
tracking (by convention, changing one means updating `WORKING_SPINNER_RE` in
`packages/tui-supervisor/src/TitleStateTracker.ts` too).

| Agent | Rules (first match wins) |
|---|---|
| claude | Screen shows a select/confirm prompt ("enter to select" + "esc to cancel", "do you want to proceed?") → **blocked** / title starts with a working glyph → working / `✳ ` → idle / screen contains "esc to interrupt" → working / prompt box (`❯`) → idle |
| codex | Title contains "Action Required" → **blocked** / working glyph → working / screen shows a confirmation ("allow command?", "enter to submit", "[y/n]", etc.) → blocked / a non-empty title alone → idle |

Anything other than `claude` / `codex` (e.g. `generic`) always returns `unknown` and falls
through to Tier 3 (`CLASSIFIABLE_AGENT_TYPES`).

### The screen check is tri-state (blocked / not_blocked / unknown)

The answer of a screen check (`screenVerdict()`) has three values. `unknown` is **not** a
synonym for "not blocked" -- it means **"could not look"**.

| Answer | Condition |
|---|---|
| `blocked` | A screen rule matched blocked |
| `not_blocked` | The screen was read and was not blocked |
| `unknown` | `capture-pane` failed or exited non-zero, the tmux snapshot (`listSessions`) failed for that server, or the agent type has no classification rules |

On `unknown`, the key **keeps the status it published on the previous tick**
(`heldStatusOnUnknown()`). This is a **deferral, not a promotion** -- it retains the status it
already had (working or blocked) and never a better one -- and it is bounded: once the
failures have lasted **`UNKNOWN_HOLD_MS` (30s)**, the tier's own verdict stands again.
`unknownSince` records the **first** failure of a run and is not reset by later ones (any
success clears it).

### Suppressing re-captures, and concurrency

`capture-pane` is an expensive round trip, so these cache rules bound how often it runs:

- A repeat question within the same tick returns the cached value
- If the previous answer was `not_blocked` and `window_activity` has not advanced since that
  successful check, no re-capture happens (a pane that is not redrawing is not read again)
- A cached `blocked` is **never** reused -- noticing the moment the prompt clears is the whole
  point, and a pane that only redraws its input box cannot invalidate the cache through
  activity alone
- `unknown` is not reused either (re-read every tick)

Captures are prefetched in bulk before the ladder runs (`prefetchScreenVerdicts()`), with at
most **`SCREEN_CHECK_CONCURRENCY` (4) in flight per server**. Run one after another, a tick
would cost the sum of every pane's round trip and exceed the tick interval, causing the next
tick to be dropped. Servers run in parallel with each other.

## 5. Tier 3 -- the activity heuristic

| Condition | Behavior |
|---|---|
| Running | tmux `window_activity` advanced within **30 seconds** (`ACTIVITY_THRESHOLD_SEC`) AND the foreground pane's command is not a bare shell (excluded because keystroke echo in a shell also advances activity) |
| Start debounce | An unconfirmed key needs `START_CONFIRM_ADVANCES` (2) activity advances inside a trailing `START_WINDOW_TICKS` (4 ticks ≈ 20s) window before it is confirmed -- a single burst of output does not light it up (focusing a pane bumps `window_activity` exactly once) |
| Stop | Activity has not advanced for 30 seconds, or the foreground reverts to a bare shell |

The debounce counts advances in a sliding window rather than requiring N consecutive ticks so
that a burst-style agent, which only writes output every ~15s, is not missed.

## 6. Tier 4 -- process + transcript (the probe)

The catch-all for windows with no supervisor, no hooks, and where neither the title nor the
activity volume says anything. The snapshot is refreshed **in the background every 15
seconds**, and `collect()` only reads the cache (it never blocks a tick).

| Stage | Behavior |
|---|---|
| 1. Process liveness | Looks for claude/codex (by basename) among the pane's descendant processes, using a `list-panes`/`ps` snapshot taken once per server. If absent → offline |
| 2. Session resolution | The window's `agentSessionId` (when unlinked, the resolver's cwd matching is kicked off automatically at low frequency with backoff, and written back under an adoption guard) |
| 3. Tail scan | Scans the tail of the session JSONL with an escalating backward scan and classifies it as `in_progress` / `terminal_final` / `terminal_interrupted` / `terminal_local` / `unknown` (see below) |
| 4. Verdict | **It reports working only when** the tail is `in_progress` AND the timestamp of the last meaningful entry is within **120 seconds** (`SESSION_ACTIVITY_WINDOW_MS`). `terminal_*` and unknown are never grounds for working (file mtime is deliberately not used, so a housekeeping write on resume cannot light it up) |
| 5. Completion synthesis | On observing `terminal_final`, the probe carries a `completedAt`, and the server **synthesizes a `completed` transition** even for a turn so short that no tick ever saw it running (30s acceptance window, with double-emission protection) |

### The tail scan (escalating backward scan)

In real sessions the tail is routinely filled with housekeeping records -- attachments (several
KB each), `ai-title`, `file-history-snapshot`. A fixed single 16KB window never reached a
meaningful entry and returned `unknown`, which left Tier 4's working/completed verdict and the
chat's pending-answer gate silent for practically every real session (measured: a 25KB session
where a 627B user message was followed by five attachments totalling ~24KB).

`scanSessionTailState()`
(`packages/server/src/modules/transcripts/sources/entryHelpers.ts`) now widens the window in
stages.

| Item | Value |
|---|---|
| Scan window stages (`TAIL_STATE_SCAN_WINDOWS`) | 16KB → 64KB → 256KB |
| Escalation trigger | Only when that stage yielded no meaningful entry at all |
| Termination | A meaningful entry was found / the window reached the head of the file (`hasOlder === false`) / the largest window (256KB) was exhausted, giving `unknown` |
| Total read ceiling | **672KB** (= 2 × (16+64+256)KB). Each stage costs at most two passes over its window: a newline probe plus the actual read |

Each stage re-reads a larger window from EOF rather than paging further back from the previous
one. `readBeforeWindow` is called with `maxExpandWindows: 1`, which disables its oversize-line
window expansion (by default it reaches back up to 8× the requested size), so the backward
reach is strictly capped at 256KB from the end of the file -- without that cap a measured 1.7MB
synchronous read was possible. A single record larger than 256KB leaves no newline in any
stage and therefore ends as `unknown`.

### Safety mechanisms

1. Tier 4 is an **additive, working-only verdict** -- idle/offline fall through to Tier 3, so an
   unlinked window never silences the tiers above it
2. When the probe keeps failing, a snapshot older than **60 seconds since the last success**
   (`PROCESS_PROBE_MAX_AGE_MS`) is not acted on. A failure means "no fresh answer", not
   "nothing is running", but a stale answer must not keep a stopped agent lit forever
3. For a key whose execution run has just ended, Tier 4 is disabled until the probe observes it
   not running (so the stop transition is not swallowed)

## 7. Stop-transition reasons

Every running → stopped transition carries a **stop reason**. The UI's "finished" rows are
generated from `completed` only (interrupts, deletions and offline are not completions).

| reason | Origin | UI treatment |
|---|---|---|
| `completed` | supervisor active→idle / hook Stop / Tier 2 working→idle / Tier 4 observing `terminal_final` (including synthesized) | Creates a "finished" row (60min TTL; re-completion updates it and marks it unread). Sends a completion push notification |
| `interrupted` | The tail ends on an interrupt marker (stop button / Esc) | No finished row |
| `deleted` | The tmux window disappeared (once, on the live→gone edge) or the `windows` row was deleted | Any matching finished row is removed immediately |
| `offline` | The process vanished, the crash failsafe fired, or the supervisor sent `child_exit` / disconnected | No finished row |
| `unknown` | A stop with no terminal evidence (e.g. the activity heuristic simply going stale) | No finished row |

`completed` and `interrupted` are only adopted when the observation passes a freshness gate
(within `COMPLETION_SYNTHESIS_MAX_AGE_MS`).

## 8. Timing constants

| Constant | Value | Meaning |
|---|---|---|
| `POLL_INTERVAL_MS` | 5s | The monitor's evaluation tick (the granularity of Tiers 2/3) |
| `START_CONFIRM_ADVANCES` | 2 | Activity advances required to confirm a Tier 3 start |
| `START_WINDOW_TICKS` | 4 ticks (≈20s) | Width of the sliding window those advances are counted in |
| `UNKNOWN_HOLD_MS` | 30s | How long the previous status may be held while a screen check keeps answering `unknown` |
| `SCREEN_CHECK_CONCURRENCY` | 4 | Maximum `capture-pane` calls in flight per server |
| `PROCESS_PROBE_REFRESH_MS` | 15s | Background refresh interval of the Tier 4 snapshot |
| `PROCESS_PROBE_MAX_AGE_MS` | 60s | A cache older than this since the last successful probe is not used |
| `ACTIVITY_THRESHOLD_SEC` | 30s | Tier 3's activity freshness window (both for staying running and for stopping) |
| `SESSION_ACTIVITY_WINDOW_MS` | 120s | Tier 4's freshness window for the last meaningful entry |
| `COMPLETION_SYNTHESIS_MAX_AGE_MS` | 30s | Acceptance window for a synthesized `completed` transition |
| `OPERATION_ATTRIBUTION_TTL_MS` | 90s | Grace period for attributing a synthesized completion to a just-ended execution run |
| `LAST_TRANSITION_TTL_MS` | 30min | How long the "last transition" memo is kept for the diagnostics panel (never read by the judgment path) |
| supervisor keepalive | 15s | Activity frame resend while active (state recovery after a hub restart) |
| Finished row TTL | 60min | The frontend provider prunes uniformly on load, periodically, and on save |

In E2E, `AZITO_E2E_FAST_INTERVALS=1` shortens **observation periods only** (tick 1.5s, probe
3s, cache TTL 2s). Judgment thresholds (`PROCESS_PROBE_MAX_AGE_MS` 60s, `UNKNOWN_HOLD_MS` 30s,
`COMPLETION_SYNTHESIS_MAX_AGE_MS` 30s, `SESSION_ACTIVITY_WINDOW_MS` 120s) keep their
production values -- shortening them would make E2E exercise different semantics from
production.

## 9. Reading the diagnostics panel

Settings → System → **Activity detection diagnostics** (3s refresh, read-only; the API is
`GET /api/debug/activity`).

| Display | Meaning |
|---|---|
| `tier0_supervisor` | A frame from the *current* supervisor connection decides this state (evidence generation already checked) -- objective proof that the supervisor really is detecting it |
| Supervisor column "no frame received" | The connection is alive but no activity frame has arrived yet (an old supervisor build, or right after a reconnect). A lower tier is deciding in the meantime |
| `tier1_hook` … `tier4_probe` | That tier's fallback decided the state. A lot of `tier4_probe` rows means the supervisor / hook wiring is worth checking |
| `none` (while running) | Running by execution-run registration (registered = running; not a detection tier's verdict) |
| `refinedBy: tier2_title` | A marker that Tier 2's screen classification refined a Tier 0 `idle` row into `blocked`. `decidedBy` deliberately stays at the deciding tier -- read the row as "Tier 0 idle + Tier 2 blocked" |
| Last transition | The most recent transition and its reason (§7) -- the trail for "why did it disappear" |

Rows are sorted by state (working → blocked → idle → offline → none). A `tier0_supervisor` row
with no `evidenceAt`, or one older than the supervisor's `connectedAt`, is rewritten to
undecided on the frontend (`isStaleTier0`).

### Display-condition gate

The diagnostics panel is not always visible. It exposes developer-facing internals, so its UI
entry points only appear where this holds (`isDiagnosticsEnabled()`):

```
diagnosticsEnabled = (deployMode === 'source') || (updateChannel === 'rc')
```

That is, a **source checkout** or an **rc channel** environment. The result rides on the
update-status response as `diagnosticsEnabled`, and the frontend treats it **fail-closed**
(hidden while unfetched or on fetch failure). The API (`GET /api/debug/activity`) itself is
unconditional -- only the UI entry points are gated.

### Status bar entry point

Without navigating to Settings, the panel opens as a floating dropdown from the status bar's
"Activity" item (positioned between the Hub item and the focused-server item).

| Element | Behavior |
|---|---|
| Dot | No non-offline rows → off / any row decided by an event-driven tier (`tier0_supervisor` / `tier1_hook`) → accent / otherwise (fallback tiers only) → dimmed |
| Polling | 3s while open, 30s while closed |
| Contents | A compact view. Offline rows are hidden and only their count is shown in the footer; "show all →" links to the full table in Settings |
| Row click | Opens the corresponding task / terminal. It uses the notification center's navigation-aware opener, so it works from a global page outside the workspace as well (each row carries `projectId`) |

## 10. The interaction (question) lifecycle

When an agent blocks on AskUserQuestion, the chat view shows a question card and the user can
answer by tapping an option.

```
PermissionRequest hook (azito-question.sh)
   |  "open" signal WITH the question text
   |                              Notification hook (azito-interaction.sh)
   |                                 |  "open" signal WITHOUT the text (~1 min later)
   v                                 v
POST /api/webhooks/agent-interaction  ->  InteractionMonitor opens the pending state
   |
   +--> with text:    chat shows an answerable question card (options)
   +--> without text: chat shows the "waiting for an answer" banner
   |
   |  (meanwhile Tier 2's screen rules classify the same pane as blocked, so the activity
   |   display stays running-as-blocked and no completed transition is emitted)
   v
Option tap -> POST /api/transcripts/window-signal { action: 'answer', openedAt, paneId }
   |  If the generation / pane / question-shape checks pass (consumePendingAnswer),
   |  a single digit key is sent; otherwise 409 and nothing is sent (pending is kept)
   v
The sent card lingers on screen (spinner)
   |  a new transcript record arrives and closes the pending state
   v
Chat renders the canonical answered (✓ on the chosen option) / declined card
```

The chat view polls about every 2 seconds and derives this state from `pendingInteraction` /
`pendingQuestion` in the `GET /api/transcripts/:agent/:id` response.

### When a question card appears

`pendingQuestion` is nested strictly **inside** the `pendingInteraction` gate, so a card can
never appear under broader conditions than the banner.

| Gate | Condition |
|---|---|
| Worker type | If the `workerType` profile's `interactionSignal` is `none` (e.g. codex), the monitor is not consulted at all and `pendingInteraction` is false |
| Pending exists | `InteractionMonitor.isPending(windowId)` |
| Session tail | `getSessionTailState(sessionId).state === 'in_progress'` (uses the tail scan of §6 -- this gate was silent for practically every session while the window was a fixed 16KB) |
| Answerable shape | Exactly one question, `multiSelect: false`, and 1-9 options (`MAX_TAPPABLE_OPTIONS`). Anything else degrades to the banner |
| After a failed send | That generation (`openedAt`) degrades to the banner instead of the card |

### Preconditions and conventions per stage

| Stage | Behavior |
|---|---|
| PermissionRequest hook | `harness/hooks/azito-question.sh`. Fires the instant the AskUserQuestion picker opens (it fires even under `bypassPermissions`) and forwards the stdin payload's `tool_input` (`questions: [{question, header, multiSelect, options: [{label, description}]}]`) as is |
| Must remain a pure observer | A PermissionRequest hook can steer allow/deny through what it prints on stdout, so this hook writes **nothing** to stdout on any path and always exits 0. Every non-AskUserQuestion permission request returns immediately, before any work |
| Notification hook | `azito-interaction.sh`. It cannot obtain the question text and only reports *that* an answer is awaited, arriving about a minute later. Both signals open the same pending state, and `InteractionMonitor` keeps whichever carried content, regardless of arrival order |
| Nothing in argv | Neither the token nor the question text may appear in curl's argv (`ps` exposes it to every local user). The payload goes through stdin via `--data-binary @-`; the token through `--config <(...)` (process substitution). No temp file is left behind and the token is never another process's argument |
| TMUX_PANE precondition | Every hook exits 0 when `TMUX_PANE` is empty. Under a supervisor, the re-export of §2 satisfies this |
| Generation binding | The answer request carries `openedAt`, the generation id of the question that was on screen. It fails unless it equals the pending state's `openedAt`, so an answer to a stale card cannot leak into a newer question |
| Pane binding | The pending state records the `paneIndex` the signal fired from. The client-supplied `paneId` is never trusted directly; it is resolved to a tmux pane index first and then matched. In a multi-pane window the pane the client names is not necessarily the one holding the picker, and a digit sent elsewhere would contaminate whatever prompt is running there |
| Sendable keys | A single digit (`1`-`9`) matching the option order, and only for a single-select (`multiSelect: false`) AskUserQuestion with exactly one question |
| Atomic validation | Generation, pane and question shape are all validated in the same single step as the consumption (`consumePendingAnswer`); when it fails, the pending state is not cleared |
| Closing the pending state | (1) a newer transcript record arrived for the session (authoritative), (2) a `cancel` signal (reserved, no caller yet), (3) a 10-minute timeout, (4) the `windows` row disappeared. The state is in memory only and never persisted -- losing it on restart at worst misses a banner and can never leave a stale one |
| Sibling window rows | Several `windows` rows can point at the same tmux target (a project-owned row and a task-owned row). One signal opens the pending state on every matching row, and closing is symmetric across all of them |
| Content wins | A signal carrying the question text is never overwritten by a contentless one, regardless of arrival order (an answerable card never degrades to a banner) |
| 32KB guard | If the payload carrying the question text exceeds 32768 bytes, `content` is dropped and the signal is sent without it (the signal itself is never lost; it degrades to the banner) |
| declined | Not an API action. It is derived from the transcript -- an Esc rejection (`User rejected tool use`) or a free-text resolution in the CLI. The terminal-side action is canonical |
| Zero-answer results | A `tool_result` yielding zero usable string answers (`answers` empty, or every value non-string) is not treated as `answered`. The UI could show neither a ✓ nor a declined note, so it is rendered as a raw tool row rather than an interaction |

### Related APIs

| Purpose | Endpoint |
|---|---|
| Hook → server signal (with question text) | `POST /api/webhooks/agent-interaction` (Bearer is `AZITO_WEBHOOK_TOKEN`) |
| Question fetch (polling) | `GET /api/transcripts/:agent/:id?offset=&windowId=` → `{ ..., pendingInteraction, pendingQuestion? }` |
| Answer submit | `POST /api/transcripts/window-signal` body `{ windowId, paneId, action: 'answer', key: '1'..'9', openedAt }` |
| Decline | No dedicated endpoint (performed in the terminal and surfaced via the transcript) |

`window-signal` validation returns 400 (`Invalid windowId` / `Invalid paneId` /
`Invalid action` / `Invalid key` / `Invalid openedAt`), 404 (`Window not found` /
`Pane not found`) and 409 (`No pending question for this request`).

## 11. Support per server type

There are two server types, `local` and `agent` (`ssh` is legacy: migration 058 rewrites
existing rows to `ssh_disabled`).

| Feature | local | agent (remote) | Basis |
|---|---|---|---|
| Tier 0 supervisor | Yes | Yes | `shouldSupervise()` does not look at the server type at all (only `windowType === 'agent'`). Signals arrive over HTTP from the supervisor process |
| Tier 1 hooks | Yes | Yes | The hook scripts simply curl the hub; there is no server-type gate |
| Tier 2 pane classification | Yes | Yes | `TmuxClient.listSessions` / `capturePane` abstract the transport |
| Tier 3 activity heuristic | Yes | Yes | Same as above |
| Tier 4 probe | Yes | **No** | Needs local `ps` and direct reads of session JSONL under `~/.claude/projects`. `WindowActivityStatusService` narrows to local-server windows, and `WindowSessionResolver.getActivityStatus()` returns offline for non-local |
| Session resolution | Yes | **No** | Non-local skips the whole resolution ladder and returns `reason: 'unsupported_server'` |
| Transcript display | Yes | **No** | Transcripts are only scanned under the local `~/.claude/projects`, so the matching tmux pane is always local |
| Chat question card / answering | Yes | **Effectively no** | The path itself has no server-type gate (the hook curls any hub, and pane resolution reaches remote servers through `TmuxClient`). But the card's gate requires the session tail state, and reading that is local-only, so in practice it only works on a local server |

In short, **activity detection itself works on remote (agent-type) servers through Tiers 0-3**,
while Tier 4 and the chat features (transcript display, question cards, chat answering) are
local-only. On a remote agent-type server, how well the supervisor (Tier 0) and hooks (Tier 1)
are wired directly determines detection accuracy.

> Note: the "tier1 / tier2 / tier3" wording in `WindowSessionResolver`'s comments refers to
> *session-resolution* priorities (window link / task link / cwd match) and is a different
> numbering from the activity tiers in this document.

## 12. E2E coverage

`npm run e2e` (fully isolated harness, LLM-free fake agents, assertions through the real UI)
permanently locks in the following.

| Scenario | Property it protects |
|---|---|
| Tier 0 real-time | A working title lights it up within 3s; idle turns it off and produces a `completed` finished row |
| AskUserQuestion wait | A waiting-for-answer screen stays running as blocked and creates no finished row → once resolved, a `completed` finished row (blocked refinement) |
| Higher-tier idle is not overwritten | Keeping the transcript fresh after completion does not re-light it (the ladder guarantee) |
| Respawn does not light up | A session with only housekeeping produces neither a running nor a finished state |
| Interrupt is not completion | A tail ending on an interrupt marker creates no finished row (reason=`interrupted`) |
| Deletion prunes | Deleting a window removes the finished row immediately (reason=`deleted`) |
| Chat answering | Tapping an option in chat answers the AskUserQuestion |
| Smoke | Login → project creation → window registration → listing |

Corresponding specs: `e2e/specs/activity.spec.ts`, `e2e/specs/question-answer.spec.ts`,
`e2e/specs/smoke.spec.ts`.
