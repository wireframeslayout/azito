# AZITO Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (React SPA)                                              │
│   ├── Workspace: Terminal tabs + File explorer + Task logs       │
│   ├── Projects / Units / Sidekicks / Operations /                │
│   │     Tasks management                                        │
│   └── WebSocket: terminal, capture stream, task log push        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP + WebSocket (via Vite proxy in dev)
┌───────────────────────────▼─────────────────────────────────────┐
│ Fastify Server (port 3001)                                       │
│   ├── HTTP Routes: /api/servers, /projects, /units,              │
│   │     /sidekicks, /operations, /tasks                         │
│   ├── WebSocket: /ws?mode=terminal|capture|task-logs             │
│   ├── ExecuteTaskUseCase + RecoverStuckTasksUseCase              │
│   └── SQLite Database (data.db)                                  │
└───────────┬────────────────────────────────────┬─────────────────┘
            │ node-pty / execFile                │ SSH (persistent shell)
┌───────────▼───────────┐          ┌────────────▼────────────────┐
│ Local tmux sessions    │          │ Remote servers (Tailscale)   │
│   ├── Claude Code      │          │   ├── tmux sessions          │
│   ├── Codex            │          │   └── Worker agents          │
│   └── Other agents     │          └─────────────────────────────┘
└────────────────────────┘
```

## Execution Flow (Task)

```
1. User creates Task → assigns to a Unit (workflow definition + execution
   runtime), with the server resolved from the project's defaults or the
   task's own overrides
2. Execute button clicked
3. ExecuteTaskUseCase:
   a. Create Git worktree via IWorktreeService (local or remote via WorktreeServiceFactory; fail-fast on failure — task set to failed, no fallback)
   b. Create/reuse tmux window for the task
   c. cd to worktree directory
   d. Launch worker CLI (claude/codex)
   e. UnitType-driven phase loop (phases defined in TOML):
      i.   planning → worker creates execution plan
      ii.  phase_review → user approves or requests changes
      iii. implementing → worker implements code changes
      iv.  reviewing → automated review of changes
      v.   testing → run tests
      vi.  pushing → push changes / create PR
4. Update task status, log everything
5. Stall detection: warn after 5min of no output change
6. Push notification via WebSocket (real-time log) + PWA push
```

## azt-harness (Claude Code Native Execution)

azt-harness runs the same task phases (planning/implementing/reviewing/testing/pushing) as native Claude Code skills instead of
driving a worker through a tmux pane. Unlike the marker-based flow above (which
detects `AZITO_DONE` / `QUESTIONS_JSON` in pane output), Claude Code executes each
phase as a skill and advances through natural conversation.

```
~/.claude/                          harness/  (source, linked by setup.sh)
  ├── skills/azt-{plan,implement,    ├── skills/azt-*           # /azt-* phase skills
  │     review,test,push}            │     └── fetch GET /api/phase-prompts/:phase
  ├── skills/azt-mcp                 ├── skills/azt-mcp         # AZITO REST API as MCP tools
  ├── rules/*.md                     ├── prompt-modules/*.md    # rules / design / review / UI
  └── settings.json (merged)         └── hooks/azito-notify.sh  # Stop hook → webhook
        ├── mcpServers.azt-mcp
        └── hooks.Stop → azito-notify.sh
```

| Part | Source | Role |
|------|--------|------|
| `/azt-*` skills | `harness/skills/azt-*` | Run each task phase (plan/implement/review/test/push); fetch the phase prompt from `GET /api/phase-prompts/:phase?render=skill&task_id=<id>` and chain to `nextPhase` |
| azt-mcp | `harness/skills/azt-mcp` | Expose AZITO's REST API (projects, tasks, units, operations, sidekicks, phase prompts) as MCP tools |
| prompt-modules | `harness/prompt-modules/` | Coding rules, design/UI principles, review perspectives injected into subagent prompts |
| Stop hook | `harness/hooks/azito-notify.sh` | POST `/api/webhooks/agent-done` on completion (shared `AZITO_WEBHOOK_TOKEN`) |

`harness/setup.sh` symlinks skills into `~/.claude/skills/`, rules into
`~/.claude/rules/`, and merges azt-mcp + the Stop hook into `~/.claude/settings.json`.
See [docs/en/harness.md](en/harness.md) / [docs/ja/harness.md](ja/harness.md).

## Domain Model

```
Project
  ├── name, description, workingDirectory, sidekickPrompt
  ├── icon (emoji), color (theme color)
  ├── repositories[] (url, name)
  ├── windows[] (serverName, tmuxTarget, label)
  ├── defaultUnitId (default Unit for tasks)
  └── projectServers[] (project↔server binding: workingDirectory, branch, tmuxSession)

Unit                                       # the team that runs an operation (merges the
  │                                        # former Operation + WorkerProfile split)
  ├── name, systemPrompt
  ├── selfReviewMaxAttempts
  ├── reviewSubagent, implementSubagent (subagent delegation config)
  ├── unitType (references a UnitType TOML definition)
  ├── phaseConfig (per-phase Sidekick assignment + enabled/disabled)
  └── workerType (claude/codex/generic), workerModel, workerExtraArgs

Sidekick                                   # tagged skill package (not a DB entity — files under
  │                                        # harness/sidekicks/* and the user layer)
  ├── name, description, tags[] (planning/implementing/reviewing/testing/pushing
  │     are special-cased "phase tags"; any other value is free-form), isDefault
  ├── layer (builtin/user), overridesBuiltin
  └── body (SKILL.md), scripts/, references/

Task
  ├── projectId, unitId (falls back to the project's defaultUnitId)
  ├── serverName (overrides the project's default when set)
  ├── title, description
  ├── status: open/running/phase_review/waiting_input/review/in_progress/done/failed/archived
  ├── priority, tmuxWindow
  ├── worktreePath, worktreeBranch, baseBranch (Git worktree isolation)
  ├── summary, agentSessionId (session recovery)
  ├── skipPr (skip PR creation in pushing phase)
  └── source (local/github), sourceRef

Operation                                  # not a DB entity — one execution run of a Unit,
  │                                        # observable only via GET /api/operations
  └── unitId, taskId, target

ExecutionLog
  ├── taskId, unitId, type, content (JSON)
  └── Types: llm_request, llm_response, command, output, status_change, user_comment
```

## WebSocket Modes

| Mode | URL | Description |
|------|-----|-------------|
| terminal | `/ws?server=X&target=Y&cols=C&rows=R` | Full PTY via node-pty (local) or SSH stream (remote); default mode |
| task-logs | `/ws?mode=task-logs&taskId=N` | Real-time execution log streaming via EventEmitter |
| events | `/ws?mode=events` | Notification stream (NotificationBus → browser) |
| supervisor | `/ws/supervisor` | tui-supervisor outbound connections (webhook-token authenticated) |
| file-tail | `/ws?mode=file-tail&path=P` (agent process only) | Streaming tail of a remote file, consumed by `AgentPaneStream` on the hub |

## Key Files

| File | Purpose |
|------|---------|
| `packages/server/src/main.ts` | Entry point / composition root, wires everything together |
| `packages/server/src/modules/tasks/execution/ExecuteTaskUseCase.ts` | Core execution logic |
| `packages/server/src/modules/tasks/execution/PhaseLoopRunner.ts` | UnitType-driven phase loop |
| `packages/server/src/modules/tmux/TmuxClient.ts` | All tmux operations |
| `packages/server/src/modules/servers/ssh/SshClient.ts` | SSH pool with marker-based exec |
| `packages/server/src/modules/llm/CodexExecClient.ts` | codex exec wrapper |
| `packages/server/src/modules/agents/registry.ts` | `IAgentProvider` registry — single source of agent/model definitions |
| `packages/server/src/modules/prompt/PromptModuleLoader.ts` | Injects rule/principle files into subagent prompts |
| `packages/server/src/modules/usage/UsageService.ts` | Aggregates Claude/Codex token usage |
| `packages/frontend/src/pages/Workspace.tsx` | Main workspace (largest page) |
| `packages/frontend/src/hooks/useTabPersistence.ts` | Unified tab state (localStorage) |
| `packages/frontend/src/components/TaskLogView.tsx` | Chat-style execution log |
| `packages/frontend/src/components/FileExplorer.tsx` | File tree + preview with syntax highlighting |
| `packages/server/src/modules/git/WorktreeService.ts` | Git worktree (LocalWorktreeService) |
| `packages/server/src/modules/git/IWorktreeService.ts` | Worktree service interface |
| `packages/server/src/modules/git/RemoteWorktreeService.ts` | Remote worktree operations via ServerTransport |
| `packages/server/src/modules/tasks/recovery/RecoverStuckTasksUseCase.ts` | Startup task recovery (stuck tasks) |
| `packages/frontend/src/components/ui/` | Shared UI components directory |
| `harness/setup.sh` | Installs azt-harness skills/rules/MCP/hook into `~/.claude/` |
| `harness/skills/azt-*` | `/azt-*` phase skills (plan/implement/review/test/push) |
| `harness/skills/azt-mcp/mcp-server/index.js` | azt-mcp server exposing AZITO REST API as MCP tools |
| `harness/hooks/azito-notify.sh` | Stop hook → `POST /api/webhooks/agent-done` |

## UI Components

Shared UI components in `packages/frontend/src/components/` (base components under `components/ui/`):

| Component | Purpose |
|-----------|---------|
| `ui/TabBar` | Unified tab bar with drag-drop, overflow menu, cross-project dots |
| `ui/FormInput` | Standardized form input with label, validation, helper text |
| `ui/LoadingState` | Loading spinner / skeleton states |
| `StatusBadge` | Colored status badges (task status, PR status) |
| `Modal` | Modal dialog wrapper |
| `ui/IconButton` | Icon-only action buttons |
| `TaskRefBadges` | Task ID / Issue # / PR # badge display |
| `StorageFilePreview` | Image and PDF preview |
