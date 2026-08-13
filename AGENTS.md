# AZITO - Agent Development Workspace

## Project Overview
AZITO is a browser-based tmux session manager that enables autonomous agent development through "Sidekick Mode". It manages multiple coding agents (Claude Code, Codex) across local, SSH, and agent servers, driving them through a UnitType-defined phase loop.

## Quick Start

```bash
# From the repository root:
# UI token is auto-generated on first start (saved to data/ui-token).
# To set a fixed token: echo "AZITO_UI_TOKEN=$(openssl rand -hex 32)" >> packages/server/.env && chmod 600 packages/server/.env
# Start backend (Fastify, :3001) + frontend (Vite, :5173) together, with hot reload
npm run dev
# Runs dev:server (PORT=3001 tsx watch packages/server/src/main.ts) + dev:web (vite) in parallel.
# tsx watch auto-reloads the server on file changes — usually no manual restart is needed.
# NOTE: tsx watch does NOT type-check (esbuild transpile only); run `tsc --noEmit` to catch type errors.
# Do NOT also launch a standalone `npx tsx src/main.ts` — it competes for :3001 (EADDRINUSE).

# Access at http://localhost:5173 (dev) or via Tailscale
```

`packages/server/.env` (git-ignored) is auto-loaded via `tsx watch --env-file-if-exists=.env`.

| Variable | Required | Notes |
|---|---|---|
| `AZITO_UI_TOKEN` | no | API/WS auth token. Resolution: env -> `$AZITO_DATA_DIR/ui-token` -> auto-generate. Use `azito token show/rotate` to manage |
| `AZITO_DATA_DIR` | no | Persistent data directory. Consolidates `data.db`, `master.key`, `vapid-keys.json`, `ui-token`, `browser-profile/`, `sidekicks/` under one path (mode 700). Default: repo root (`data.db` + `data/`) |
| `AZITO_BIND` | no | Listen address, default `127.0.0.1`. `0.0.0.0`/`::` are rejected — use a Tailscale IP for remote access |
| `AZITO_PUBLIC_URL` | no | URL that supervisors / remote agents use to reach the hub. Required when using `tailscale serve` (set to `https://<MagicDNS>`). Auto-detected from Tailscale IP if unset, but unreachable when bind is `127.0.0.1` |
| `AZITO_ALLOWED_ORIGINS` | no | CORS + WS Origin allowlist, default `http://localhost:5173,http://localhost:3001` |
| `AZITO_WEBHOOK_TOKEN` | no | hook/agent-signal/supervisor shared token; set to persist a fixed value across restarts |
| `AZITO_MASTER_KEY` | no | DB secret-column encryption key; falls back to auto-generated `$AZITO_DATA_DIR/master.key` (back it up) |
| `AZITO_BROWSER_UA` | no | CDP ブラウザの User-Agent 文字列を上書き。未設定時は Chrome 130 相当の既定値 |

MinIO credentials (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) live in the **repo-root** `.env` — that is
`docker compose`'s env file, not the server's. Both are required when running `docker compose up`.

After changing `AZITO_UI_TOKEN` (or running `azito token rotate`), re-run `harness/setup.sh --azito-url <url> --webhook-token <t> --ui-token <t>
--server-name <name>` on every server, or `/azt-*` skills get 401. `azito token rotate` auto-updates
`~/.azito/azitoctl*.env` on the local server. Full procedures (migration, new environment,
Tailscale, troubleshooting): `docs/ja/security-setup.md` / `docs/en/security-setup.md`.

### Production (Daemon)

```bash
./deploy/daemon-install.sh              # Build + install systemd user unit + start
# Access at http://localhost:3001 or http://<tailscale-host>:3001

systemctl --user status azito           # Status
systemctl --user restart azito          # Restart
systemctl --user stop azito             # Stop
journalctl --user -u azito -f           # Logs

# Rebuild after code changes:
npm run build && systemctl --user restart azito

# Dev coexistence: daemon uses :3001, so stop it before `npm run dev`:
#   systemctl --user stop azito
# After dev, restart with:
#   systemctl --user start azito

./deploy/daemon-uninstall.sh            # Uninstall
```

### Release Build (distribution)

The published artifact is a self-contained tarball: an esbuild bundle + a downloaded Node binary,
so an end user needs neither npm nor a checkout.

```bash
# Build one platform's tarball into packages/server/dist-hub/
npx -w packages/server tsx scripts/build-hub.ts --version v0.3.0 --platform linux --arch x64
```

- `scripts/build-hub.ts` stages `azito-hub.cjs`, `azito-supervisor.cjs`, the Node binary, `public/`,
  `harness/`, `deploy/` templates and the native `node_modules`, then validates the stage
  (`assertStageContents`) before tarring. Native modules are `external` in the bundle and copied in.
- `scripts/run-hub.sh` becomes `run.sh` in the bundle. It resolves the host PATH (nvm/nodenv/Homebrew)
  and a UTF-8 locale, because systemd/launchd hand the service a minimal environment.
- Releases are cut by tagging `v*`; `.github/workflows/release.yml` builds linux-x64/arm64 and
  darwin-arm64 and publishes them with `SHA256SUMS` and `install.sh`. Tags containing a hyphen
  (`v0.3.0-rc1`) are published as pre-releases.
- Installed layout: `~/.azito/hub/<version>/` with a `current` symlink, `~/.azito/hub/.env`
  (config, outside the versioned dir) and `~/.azito/data/` (DB, keys, token).
- In-app update: Settings → System. Works under systemd and launchd; not for a source checkout, and
  not for pre-releases (GitHub's `releases/latest` returns stable releases only).

## Architecture

```
packages/
  server/                          # Fastify + TypeScript (feature-first)
    src/
      main.ts                      # Composition root: wires repositories/services, registers routes, starts Fastify
      agent/                       # Lightweight agent entry point (deployed to remote servers)
        main.ts, routes.ts         # Agent process HTTP/WS surface
      modules/                     # Feature modules (1 module = 1 responsibility; routes+service+repository together)
        tmux/                      # [base] TmuxClient, PaneOutputStream/PaneStream(Factory), TmuxHookManager
          routes/, ws/             # HTTP routes (sessions, hooks) + WS handlers (terminal, agent-terminal)
        servers/                  # [base] Server entity, SqliteServerRepository, install status parsing
          transport/               # ServerTransport interface + Local/Ssh/Agent implementations, AgentPaneStream/EventStream
          ssh/                     # SshClient (persistent shell pool, marker-based exec)
          auth/                    # Token-based auth for agent connections
          agent-deploy/            # AgentBundler, AgentInstaller, AgentUpdater, HarnessInstaller
        agents/                   # [mid] Worker (Claude/Codex/Generic), SessionStrategy(Factory), IAgentProvider registry, LaunchCommand
        git/                      # [mid] IWorktreeService, Local/RemoteWorktreeService(Factory), GitDiffService, DiffParser
          providers/               # GitProviderService (GitHub/GitLab provider abstraction)
        llm/                      # [mid] LlmClient, Provider, CodexExecClient, PaneClassifier, LlmContentExtractor
        prompt/                   # [mid] PhasePrompt, PhasePromptRenderer, PromptModuleLoader, RenderSkillPromptUseCase
        sidekicks/                # [mid] SidekickPackage (Claude Skill型パッケージ: SKILL.md+scripts/+references/),
                                  #       SidekickPackageLoader (builtin/user 2層マージ), SidekickPackageService, renderSidekickBody
        tasks/                    # [upper] Task, TaskStatus, ExecutionLog, SqliteTaskRepository
          execution/               # ExecuteTaskUseCase, WorkerWaiter, PromptExpander, GitInfoCollector, PushVerifier
          recovery/                # RecoverStuckTasksUseCase (startup stuck-task recovery)
          ws/                      # taskLogHandler
        windows/                  # [upper] Window, SqliteWindowRepository, WindowRespawnService
        units/                    # [upper] Unit (behavior + runtime, merged Operation+WorkerProfile), SqliteUnitRepository
        operations/               # [upper] running-execution-runs API only (GET /api/operations); no operations table
        projects/                 # [upper] Project, ProjectServer, SqliteProjectRepository/SqliteProjectServerRepository
        files/                    # [upper] FileBrowseService, SqliteStorageSettingsRepository
          storage/, ws/            # MinioStorageClient + file-tail WS handler
        usage/                    # [upper] UsageService, Claude/CodexUsageCollector (token usage aggregation)
        notifications/            # [upper] NotificationBus, webhooks (agent-done), push subscriptions
          push/, ws/               # PushNotificationService, VapidKeyManager + notificationHandler
        browser/                  # [upper] CDP browser (shared server-side browser, tab snapshots, agent ops)
        supervisors/              # [base] SupervisorRegistry/Launch/Path — tui-supervisor process management
        system/                   # [upper] SystemUpdateService, DeployModeDetector, UpdateChannelResolver,
                                  #         updateScript (out-of-process self-update), serviceControl
        health/                   # [upper] GET /api/health
      shared/
        db/                       # Database.ts (SQLite/WAL) + migrations/ (001-054)
  frontend/                        # React 19 + Vite + TypeScript
    src/
      components/                  # Layout, Terminal, Modal, FileExplorer, TaskLogView, etc.
        ui/                        # TabBar, TabGroup, IconButton, etc.
        workspace/                 # GlobalSettingsPanel, GlobalTasksPanel, ServersSidebar, etc.
      pages/                       # Workspace (unified), Tasks, Units, etc.
      hooks/                       # useTabPersistence, useTabGroups, useTmuxTouchScroll, useLongPress, useApi, useWebSocket
```

### Module Structure Rules
- 1機能 = 1モジュール（`modules/<name>/` 配下に routes・service・repository を同居させる）。
- 依存方向: `shared` → `tmux`/`servers`（基盤層） → `agents`/`git`/`llm`/`prompt`/`sidekicks`（中間層） → 上位モジュール
  （`tasks`/`windows`/`units`/`operations`/`projects`/`files`/`usage`/`notifications`） → `main.ts`。
  循環依存は禁止（`npm run depcruise` で検証。ルールと現状の例外は `.dependency-cruiser.cjs` を参照）。
- インターフェース（`I〜`）は実装が2つ以上ある場合のみ定義する（例: `IWorktreeService` は Local/Remote の2実装）。
- `routes.ts` は薄く保つ。リクエスト/レスポンスの変換とサービス呼び出しに徹し、ビジネスロジックは service/use case 側に置く。

## Key Technical Decisions

### Server Transport Abstraction
- Three transport types: `local`, `ssh`, `agent`
- `ServerTransport` interface abstracts command execution, file operations, tmux management
- `LocalTransport`: direct `execFile` + local tmux
- `SshTransport`: SSH shell pool with marker-based execution
- `AgentTransport`: HTTP/WebSocket to a lightweight agent process on the remote server

### Agent Server Type
- Lightweight Node.js agent deployed to remote servers via SSH bootstrap
- Auto-install: bundles server code, copies via SSH, runs via nohup
- Auto-update: checks version hash, redeploys if changed
- Token-based authentication between hub and agent
- Uses HTTP REST for commands + WebSocket for terminal/file streaming
- DB migrations: 021 (agent server columns), 022 (agent bootstrap status)

### Subagent Delegation
- Worker delegation can route by worker type; per-task overrides are stored via `024_subagent_config`
- The `IAgentProvider` registry (`modules/agents/registry.ts`) is the single source of truth for agent/model definitions (codex shown as gpt-5-codex)
- `PromptModuleLoader` injects rule files (`harness/prompt-modules/rules/*`: common/typescript/php/ai-antipattern) and design/review/UI principles into subagent prompts; `025_inject_prompt_modules` controls injection
- `023_worker_extra_args` stores extra CLI args; worker launch command is derived from workerType + model + extra args

### Sidekick Package (Issue #263 Phase 4)
- **Sidekick** (new meaning, name freed up in Phase 3) = a Claude Skill-style skill package: a directory with a required
  `SKILL.md` (flat `key: value` frontmatter, no YAML lib — self-parsed) + optional `scripts/` + `references/`
- Two-layer resolution: builtin (`harness/sidekicks/`) + user (`data/sidekicks/`, overridable via `AZITO_SIDEKICKS_DIR`,
  resolved once at startup). Same name → user layer wins; `SidekickPackageLoader.list()` tags each entry with
  `layer`/`overridesBuiltin`. mtime-based caching (directory mtime for add/remove, per-`SKILL.md` mtime for edits)
- `renderSidekickBody()` expands `{{task.*}}`/`{{project.*}}`/`{{module.*}}`/`{{sidekick.dir}}`/`{{sidekick.name}}` via
  the existing `expandPromptTemplate`; script file contents are never template-expanded (values reach scripts only via
  env vars/args, to avoid injection)
- CRUD via `/api/sidekicks` (`SidekickPackageService`): POST scaffolds into the user layer; PUT copy-on-writes a
  builtin package into the user layer before editing; DELETE only removes the user-layer copy (reverts to builtin, or
  fully removes a user-only package); builtin-only DELETE is rejected
- 6 builtin packages ship in `harness/sidekicks/`: `planning-default`/`implementing-default`/`reviewing-default`/
  `testing-default`/`pushing-default` (bodies originally matched the final `phase_prompts` seed after migrations
  through 038; since Issue #263 Refine D they intentionally diverge — the seed-comparison migration's own expected
  seed constants are unchanged, but the shipped bodies no longer carry `PHASE_COMPLETE`/`QUESTIONS_JSON`/`TEST_FAILED`,
  see "Execution protocol envelope" below) and `issue-default` (no phase tag — a general-purpose package, ported from
  `harness/skills/azt-issue/SKILL.md`). `pushing-default` additionally
  ships `scripts/push.sh`: it commits and pushes the worktree's **current work branch** (never checks out; fails on
  detached HEAD), then creates a PR with `--head <work branch>`. Env vars: `AZITO_COMMIT_MESSAGE` (required),
  `AZITO_PR_BASE` (optional PR base; omitted → gh repo default), `AZITO_PR_BASE_FROM` (source branch to create a
  missing PR base from, via a remote-only ref push), `AZITO_SKIP_PR`, `AZITO_PR_TITLE`, `AZITO_PR_BODY`. The SKILL.md
  body keeps the same template variables (PushVerifier checks `git ls-remote --heads origin <work branch>` +
  `gh pr list --head <work branch>`); completion signaling is now added by the execution envelope, not the body
- `039_export_edited_phase_prompts` migration: compares each `phase_prompts.prompt` row against the known seed final
  form; unedited rows do nothing (builtin package takes over), edited rows are exported once to
  `<user-layer>/<phase>-default/SKILL.md` (never overwritten if already present). `enabled` is intentionally ignored
  when comparing — phase enable/disable is out of scope for the package format (deferred to Phase 5)
- This phase does **not** change the existing `phase_prompts`-based rendering path (`RenderSkillPromptUseCase`,
  `PhasePromptRenderer`) — that replacement is Phase 5
- Harness skills (Issue #263 Phase 7): `/azt-sidekick <name> [task_id]` executes any Sidekick package on demand via
  `GET /api/sidekicks/:name?render=1`; `/azt-summon` scaffolds a new Sidekick from the current conversation via
  `POST /api/sidekicks`. `azt-plan/implement/review/test/push` remain thin wrappers over `/api/phase-prompts`
  (server-side resolves the Unit's `phase_config` Sidekick); `azt-issue` is now a thin wrapper fetching
  `issue-default` (the implementation body lives there, not in `azt-issue/SKILL.md`). `/azt-mission
  [--parallel] <taskId|#issue>...` runs multiple tasks as one batch "mission": creates a mission integration
  branch, kicks each task via `/api/units/:id/execute`, supervises the run (plan approval, answers, failure
  recovery), reviews and merges each task PR into the mission branch, then opens one mission→base PR
  (final merge left to the user)
- **Execution protocol envelope** (Issue #263 Refine D, `modules/prompt/executionEnvelope.ts`): a `SKILL.md` body
  describes capability only, never the completion/question/test-failure signaling protocol. `stateMachineEnvelope()`
  (used by `PhaseLoopRunner` via `renderForStateMachine`) and `skillEnvelope()` (used by `RenderSkillPromptUseCase`
  via `renderForSkill`) each append that protocol on top of the rendered body, gated by
  `signalCapabilitiesForPhase(phase)`; the standalone `/api/sidekicks/:name?render=1` path applies no envelope at all

### Token Usage Tracking
- `UsageService` aggregates Claude/Codex token usage from local JSONL session files (`ClaudeUsageCollector`, `CodexUsageCollector`)
- Exposed via `GET /api/usage`; rendered in the header `UsageDropdown`

### Webhooks
- `POST /api/webhooks/agent-done` receives agent completion notifications (validated request body); shared `AZITO_WEBHOOK_TOKEN` required
- `POST /api/webhooks/agent-activity` receives event-driven agent activity signals (`{serverName, sessionName, windowIndex, windowName, paneIndex, event: 'start'|'stop'}`)
  from the Claude Code `UserPromptSubmit`/`Stop` hooks (`harness/hooks/azito-activity.sh`, wired by `setup.sh --server-name`); same
  `AZITO_WEBHOOK_TOKEN`. `AgentActivityMonitor.recordHookSignal()` resolves the signal against the `windows` table and, when matched,
  flips that key's state immediately (Tier 1), bypassing the sliding-window heuristic (Tier 2) until either a crash-failsafe
  (foreground pane reverts to a bare shell without a Stop signal) or the window disappears clears the hook state

### Worker
- Runs in tmux pane via `send-keys`
- Long text (>500 bytes) sent via `tmux load-buffer` + `paste-buffer`
- Auto-approve confirmation prompts (y/n, Continue?, etc.)
- Worker types: claude (--dangerously-skip-permissions), codex (--dangerously-bypass-approvals-and-sandbox), generic

### Worktree Service
- `IWorktreeService` interface abstracts git worktree operations (create/exists/remove/getBranch/getDiff/getPrUrl)
- `LocalWorktreeService`: local `execSync` implementation (async wrapper)
- `RemoteWorktreeService`: remote execution via `IServerTransport.exec()` with shell injection prevention (`assertSafePath`/`assertSafeBranch`)
- `WorktreeServiceFactory`: returns appropriate implementation based on server type (local/ssh/agent)
- Worktree creation fails fast: on failure, task is set to `failed` status (no fallback to original directory)
- Optional `branchName` parameter: user-specified branch checks for existing branch before creating; auto-generated branch always recreates
- `skipPr` option: when enabled, pushing phase skips PR creation (commit+push only), `verifyPushCompleted` skips PR existence check
- SSH code:0 detection: `RemoteWorktreeService` uses `hasGitError()` to detect `fatal:`/`error:` in stdout/stderr (SSH transports always return exit code 0)
- Stale worktree recovery: when `git worktree add` fails with "already used by worktree", extracts the stale path, prunes or force-removes, then retries
- Post-creation verification: `assertWorktreeSuccess()` confirms worktree directory actually exists after creation

### Task Execution (pipe-pane based)
- `tmux pipe-pane` streams pane output to a file with ANSI stripping (`sed -u`)
- `PaneOutputStream` monitors the file via `fs.watch` + polling
- Unique markers per phase: `AZITO_DONE_<taskId>_<nonce>`, `AZITO_QUESTIONS_<taskId>_<nonce>`
- `QUESTIONS_JSON` structured output for agent questions (parsed as JSON)
- `PaneClassifier` provides LLM-based fallback classification when markers are not detected
- `LlmContentExtractor` extracts plan markdown from pane output via LLM
- Design doc: `docs/task-execution-design.md`

### Terminal Handling
- **Linked sessions**: Each browser tab creates `tmux new-session -t <source> -s <unique>` to allow independent window selection across tabs
- **Resize guard**: ResizeObserver skips fit when container < 10px (prevents 0-size on hidden tabs)
- **WebSocket modes**: `terminal` (node-pty / agent proxy), `task-logs` (EventEmitter), `events` (notification stream), `file-tail` (agent-process WS, streaming file content)

### Startup Task Recovery
- `RecoverStuckTasksUseCase` が起動時に非終端タスク（planning/implementing/reviewing/testing/pushing/in_progress）を自動検出・復旧
- local サーバーのみ対象（v1）。ペイン生存確認 → done-marker 検査 → resume or advance
- `in_progress`（follow-up 中断）は execution_log から最後の phase_prompt を検索してフェーズを推定
- done-marker の signal ファイル（`/tmp/azito-pipe-<taskId>-sig-*.log`）で完了判定。完了済みは次フェーズへ前進、未完了は現フェーズ再実行
- pushing 完了済みは `review` に直接遷移（PR 重複防止）
- 同時 resume は最大3件、`app.listen` をブロックしない（fire-and-forget）

### Database
- SQLite (better-sqlite3) with WAL mode
- Migration files in `packages/server/src/shared/db/migrations/`
- DB path: `<project-root>/data.db`
- Current migrations: 001-054 (023 worker extra args, 024 subagent config, 025 inject prompt modules, 026 task target branch, 027 pushing target branch, 028 deduplicate project windows, 029 task summary, 030 agent session id, 031 task skip pr, 032 task working directory, 033 pushing prompt skip pr template vars, 036-038 Sidekick redesign split/rename, 039-041 Sidekick package export/phase-config/tags, 042 merge Operation+WorkerProfile into Unit, 043 agent turns, 044 agent watches, 045 server mux runtime, 046 remove orchestrator mode, 047 task current phase, 048 unit type column, 049 worker runtime, 050 window supervised, 051 resource guard settings, 052 project secrets, 053 browser tab snapshots, 054 ssh host fingerprint)

### SSH (Tailscale)
- Persistent shell pool with `\x02AGENTMGR_B/E` markers for command execution
- `none` auth support (Tailscale SSH)
- `user@host:port` format supported

## Frontend

### Unified Workspace
- Single `/workspace/:id` route serves as the primary UI
- Global pages (Projects, Tasks, Units, Settings) are tabs within the workspace
- `TaskDetail.tsx` removed — task details shown inline in workspace TaskPanel

### Tab Groups (Chrome-style)
- Tabs are grouped by project with colored headers
- `useTabGroups` hook manages group state (collapse/expand, auto-expand on tab select)
- Group headers stay visible via sticky overlay when scrolled out of view
- Tab dropdown menu (▾) always visible for quick navigation
- Active tab auto-scrolls into visible area (100ms delay for group expand)
- Drag & drop reordering within and between groups

### Terminal Mode (xterm.js)
- Dynamic import of @xterm/xterm
- FitAddon, WebLinksAddon
- WebSocket to `/ws?server=X&target=Y&cols=C&rows=R`
- Touch swipe scrolling via `useTmuxTouchScroll` hook (converts touch gestures to synthetic WheelEvents for xterm.js viewport)
- Mobile quick action buttons (Enter/Tab/Esc/Ctrl+C/Arrow Up/Arrow Down) shown when viewport <= 768px

### File Preview
- `StorageFilePreview`: image preview on file selection in FileExplorer
- PDF preview support via embedded viewer
- Mobile: clicking image preview closes sidebar

### Pane Session Recovery
- `TmuxClient.checkPaneExists`: lightweight pane alive check via `list-panes`
- `GET /api/tasks/:id` includes dynamic `paneAlive` flag (true/false/null)
- `POST /api/tasks/:id/recover-session`: resumes agent via `claude --resume <session-id>`
- TaskPanel polls pane status every 30s; shows recovery button when pane is lost
- Session ID validated as UUID to prevent command injection

### Task UI Enhancements
- `TaskRefBadges`: displays task ID, Issue number, and PR number as badges in task list/kanban
- Task summary: extracted as JSON after task completion, stored in `task_summary` column
- Agent session ID: saved on task creation (`agent_session_id` column) for session recovery
- `skipPr` toggle in task create/edit form: skips PR creation in pushing phase
- User-specified branch name field (when skipPr enabled): uses existing branch or creates from base
- Window Remove in ProjectSettings auto-closes associated terminal tabs
- Cross-project task lookup: TaskPanel falls back to `allTasks` when task not found in current project scope
- Per-task working directory override: `workingDirectory` field in task form overrides project server's default directory (migration 032)
- Unit default subagent config display: when subagent override is unchecked and a Unit is selected, shows the Unit's default Review/Implement subagent provider and model
- Pushing prompt template improved: `pushTaskDescription`, `pushRules`, `pushOutput` template variables replace `pushMode` for clearer skipPr support (migration 033)

### Mobile UX
- `useTmuxTouchScroll` hook: converts touch swipe gestures to synthetic WheelEvents with inertia/momentum scrolling, applied to Terminal and XTermView
- `useLongPress` hook: 500ms long-press detection for mobile context menus, exports `longPressStyle` to suppress text selection
- Long-press context menus in ServersSidebar: server, session, window, and pane rows support long-press to open context menus
- `useContextMenu` `showAt(x, y, items)` method: programmatic context menu positioning for touch coordinates
- TabBar `onTabLongPress` prop: enables long-press context menu on tabs
- Kanban board multi-line title wrapping with `-webkit-line-clamp: 2` for better mobile readability
- Mobile detection: `window.matchMedia('(max-width: 768px)')` with reactive MediaQueryList change listener

### Agent Reinstall
- ServerDetailPanel "Reinstall" button for `aztHarness` and `agent` dependencies (with confirmation dialog)
- ServersSidebar context menu "Reinstall agent" option for agent/SSH servers

### Task Status: `waiting_input`
- When an agent asks questions via `QUESTIONS_JSON`, task enters `waiting_input` status
- Questions displayed as structured UI (select/text inputs) in TaskPanel
- Submit answers via `POST /api/tasks/:id/answer`
- After submission, task resumes automatically (follow-up loop detects additional questions)

## API Patterns
- All routes return camelCase JSON
- Request bodies accept snake_case (for historical reasons in some endpoints)
- Session cache: 5s TTL for tmux session listings
- File APIs: `/api/servers/:name/files?path=` (listing), `/api/servers/:name/files/content?path=` (content)
- Directory autocomplete: `/api/servers/:name/directories?path=`
- Agent routes: `/api/agent/*` (authenticated via `X-Agent-Token` header)
- Task answer: `POST /api/tasks/:id/answer` (submit question responses)
- Task recovery: `POST /api/tasks/:id/recover-session` (resume agent session)
- Task deletion: `DELETE /api/tasks/:id` (cleans up tmux window, worktree, temp files)
- Usage: `GET /api/usage` (aggregated Claude/Codex token usage)
- Webhooks: `POST /api/webhooks/agent-done` (agent completion notifications, shared `AZITO_WEBHOOK_TOKEN`)
- Install status: `/api/servers/:name/install-status` (dependency install detection for ServerDetailPanel)
- Branch search: `GET /api/servers/:name/branches?working_directory=` (optional working directory override for branch listing)
- Units: `/api/units` CRUD + `execute`/`follow-up`/`stop`/`approve-plan`/`logs` (merged Operation+WorkerProfile — behavior + runtime; Issue #263 Refine B)
- Operations: `GET /api/operations` (currently running execution runs — `{ unitId, taskId, target }[]`; no operations table anymore)
- Activity diagnostics: `GET /api/debug/activity` (read-only Tier attribution per window — `decidedBy`
  (`tier0_supervisor`/`tier1_hook`/`tier2_title`/`tier3_heuristic`/`tier4_probe`/`none`) plus the supervisor /
  hook / probe material and the last announced transition; rendered in Settings → System「稼働検知診断」).
  `refinedBy: 'tier2_title'` は「Tier 0 が idle と判定した行を Tier 2 の画面分類が blocked へ精緻化した」印
  （claude は AskUserQuestion 選択中もタイトルが idle グリフ `✳ ` のままで、タイトルしか見ない supervisor が
  idle を報告するため）。精緻化された行は稼働（blocked）のまま残り、完了遷移は発行されない。Tier 0 が沈黙して
  いるキー（supervisor 再接続直後など）では Tier 2 自身が同じ画面確認を行い、`decidedBy: 'tier2_title'` /
  `state: 'blocked'` として同じ結論に達する（idle → blocked の一方向のみ。working への昇格はしない）
- Sidekick tags (Issue #263 Refine A): `tags: string[]` replaces the old single-value `phase:` frontmatter field. The five
  phase names are special-cased as "phase tags" (a Unit's `phaseConfig` can only assign a phase to a Sidekick carrying
  that tag; `isDefault` requires at least one phase tag); any other tag is free-form. `/azt-sidekick` accepts multiple
  names in one invocation and runs them in order

## Development Notes

### Running Tests
```bash
npx -w packages/server vitest run          # Unit tests (vitest 4.1.8)
npx -w packages/server tsc --noEmit        # Server type check
npx -w packages/frontend tsc --noEmit      # Frontend type check
npm run depcruise                          # Module dependency direction / circular dependency check
npm run e2e                                # Playwright E2E (activity detection suite; local only, not in CI)
```

`npm run e2e` builds the frontend + tui-supervisor, then runs `e2e/` against a throwaway hub instance:
temp `AZITO_DATA_DIR`, random free port, and an isolated tmux server via `TMUX_TMPDIR` (the host's tmux,
:3001 and :5173 are never touched). Agents are scripted fakes — no LLM is launched. First run needs
`npx playwright install chromium`. The server honours `AZITO_E2E_FAST_INTERVALS=1` to shorten the activity
monitor's *observation* periods only (probe refresh / cache TTL); judgment thresholds are unchanged and the
variable has no effect when unset.

### Adding a Migration
1. Create `packages/server/src/shared/db/migrations/NNN_description.ts`
2. Import in `Database.ts` and add to `migrations` array
3. Export: `version`, `description`, `up(db)` function

### E2E Test Task (State Machine Flow)
```bash
./scripts/create-test-task.sh <project_id> <unit_id> [PORT]   # default PORT=3001
```

### Adding a New Worker Type
1. Create `packages/server/src/domain/worker/XxxWorker.ts` implementing `IWorker`
2. Add to `WorkerFactory.ts`
3. Add to `WORKER_MODELS` in `packages/server/src/infrastructure/llm/LlmClient.ts`
4. Add to frontend `WORKER_COMMANDS` in Unit forms

## Environment
- Server: WSL2 Ubuntu 24.04, Node.js v24.14
- tmux 3.4
- Tailscale for multi-server SSH (none auth)
- Codex CLI (flat-rate plan)
- Claude Code CLI available
- vitest 4.1.8 (CVE-2026-47428/47429 patched)
