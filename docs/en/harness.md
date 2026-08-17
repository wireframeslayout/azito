# azt-harness Guide

## What is azt-harness

azt-harness (the AZITO Harness) lets you run AZITO's Sidekick Mode as **native Claude Code skills**. It lives under the `harness/` directory and installs into your Claude Code environment (`~/.claude/`) with a single `setup.sh` run.

The traditional Sidekick Mode launches a worker into a tmux pane and detects markers such as `AZITO_DONE` / `QUESTIONS_JSON` in the pane output to advance phases. azt-harness replaces that mechanism: **Claude Code itself executes each phase as a skill**. Free of marker detection, it lets Claude Code drive a task forward through a natural conversation with the user — its defining advantage.

azt-harness is made up of the following parts.

| Part | Location | Role |
|---|---|---|
| `/azt-*` skills | `harness/skills/azt-*` | Skills that run each task phase (plan/implement/review/test/push), run any Sidekick (azt-sidekick), create or edit one (azt-summon), create issues (azt-issue), or batch-run multiple tasks (azt-mission) |
| azt-mcp | `harness/skills/azt-mcp` | Exposes AZITO's REST API as MCP tools (projects, tasks, Units, Operations, Sidekicks) |
| prompt-modules | `harness/prompt-modules/` | Rule files for coding conventions, design principles, review perspectives, UI principles |
| sidekicks | `harness/sidekicks/` | Built-in Sidekick packages (`planning-default`, `implementing-default`, etc.) |
| unit-types | `harness/unit-types/` | UnitType definitions (TOML; built-in: `devops`) |
| bin | `harness/bin/` | CLI tools (`azs` — supervised window launcher, `azitoctl` — task control) |
| tmux config | `harness/tmux/` | `azito.conf` template for managed tmux |
| Hooks | `harness/hooks/` | `azito-notify.sh` (completion notification), `azito-activity.sh` (activity notification: Stop + UserPromptSubmit) |

## `/azt-*` Skills

Each skill fetches its phase-specific prompt from the AZITO API (`GET /api/phase-prompts/:phase?render=skill&task_id=<id>`) and works according to those instructions. The `nextPhase` field in the response indicates the next phase's skill name, so the next skill is suggested once a phase completes.

| Skill | Phase | Purpose |
|---|---|---|
| `/azt-plan <task_id>` | planning | Draft the task's execution plan |
| `/azt-implement <task_id>` | implementing | Implement the code changes |
| `/azt-review <task_id>` | reviewing | Review the implementation |
| `/azt-test <task_id>` | testing | Run and verify tests |
| `/azt-push <task_id>` | pushing | Push changes and open a PR (final phase) |
| `/azt-sidekick <name...> [task_id]` | any | Run one or more Sidekick packages by name, in order (`GET /api/sidekicks/:name?render=1`; without a name, lists the available packages) |
| `/azt-summon` | - | Create or edit a Sidekick package from the current conversation's work in the user layer (new: `POST /api/sidekicks`; update an existing one: `PUT /api/sidekicks/:name`). A persona name (robin/falcon, etc.) is recommended |
| `/azt-issue [description]` | (no phase tag) | Create an issue. The implementation body lives in the Sidekick `issue-default`; this skill is a thin wrapper that fetches and follows it |
| `/azt-mission [--parallel] <taskId\|#issue>...` | - | Run multiple azito tasks/GitHub Issues as one batch "mission", serially (or in parallel). Creates a mission integration branch, supervises each task run (plan approval, answering questions, failure recovery), reviews and merges each task PR, then opens one final mission→base PR |
| `/azt-link <task_id> <issue_url>` | - | Link a GitHub/GitLab issue to a task (sets `source` / `source_ref`) |
| `/azt-prepare <task_id>` | - | Prepare the task's working environment: verify the working directory and branch, create the worktree, move into it, and stand by for work |

Phase prompts are resolved and rendered server-side from the Sidekick package that the task's Unit (a workflow definition holding the phase→Sidekick mapping and execution runtime) `phase_config` points to (default: the Sidekick with `isDefault` for that phase tag, typically `harness/sidekicks/<phase>-default`).

### Usage

```
/azt-plan <task_id>
```

Each skill takes a numeric `task_id` argument and resolves AZITO's base URL from the `AZITO_URL` environment variable. When a phase completes, the next phase's skill is suggested via `nextPhase`, so running them in order completes the full plan → implement → review → test → push flow inside Claude Code.

## azt-mcp (MCP Server)

azt-mcp is an MCP server that lets Claude Code operate AZITO's REST API directly as MCP tools. Before running tasks through skills, you can create and list projects and tasks from within the conversation.

| Tool | HTTP | Description |
|---|---|---|
| `azt_list_projects` | `GET /api/projects` | List projects |
| `azt_create_project` | `POST /api/projects` | Create a project (name required) |
| `azt_list_tasks` | `GET /api/tasks` | List tasks (filterable by project_id/status/unit_id) |
| `azt_create_task` | `POST /api/tasks` | Create a task (project_id and title required; unit_id recommended for tasks that run the workflow automatically) |
| `azt_list_units` | `GET /api/units` | List Units (workflow definitions with a phase→Sidekick mapping plus execution runtime) |
| `azt_list_operations` | `GET /api/operations` | List currently-running Operations (execution runs of a Unit) |
| `azt_list_sidekicks` | `GET /api/sidekicks` | List Sidekicks (skill packages: SKILL.md + scripts/) |
| `azt_render_sidekick` | `GET /api/sidekicks/:name?render=1` | Fetch a Sidekick's template-expanded body (task_id optional) |
| `azt_get_phase_prompt` | `GET /api/phase-prompts/:phase` | Fetch a phase prompt (compatibility API) |

## prompt-modules (Rule Files)

`harness/prompt-modules/` manages the implementation rules passed to subagents as files. They guard against AI anti-patterns such as fallback overuse and forgotten wiring, and keep deliverables aligned with the project's conventions.

- `rules/common.md` -- Shared rules for structure, naming, error handling, design principles
- `rules/typescript.md` -- TypeScript / React rules
- `rules/php.md` -- PHP / Laravel rules
- `rules/ai-antipattern.md` -- Avoiding AI anti-patterns (fallback overuse, scope creep, forgotten wiring, dead code)
- `software-design-principles.md` -- Software design principles
- `review-perspectives.md` -- Review perspectives
- `ui-design-principles.md` -- UI design principles

`setup.sh` links these into `~/.claude/rules/` so they can be injected into Claude Code's subagent prompts.

## Hooks (Completion & Activity Notifications)

Two hooks are registered in Claude Code:

| Hook | Event | Role |
|---|---|---|
| `azito-notify.sh` | Stop | Sends a webhook notification (`POST /api/webhooks/agent-done`) to AZITO when the agent finishes |
| `azito-activity.sh` | Stop, UserPromptSubmit | Reports agent start/stop in real time to AZITO, reflected in the Active Windows status display |

Both require the shared secret `AZITO_WEBHOOK_TOKEN`; if the token is unset, the hook exits silently.

> **Note:** To enable webhook notifications, the AZITO server and the hook must share the same `AZITO_WEBHOOK_TOKEN`.

## Setup

`harness/setup.sh` installs the skills, rules, MCP server, and hook into your Claude Code environment (`~/.claude/`) in one go.

```bash
cd harness
./setup.sh --azito-url http://localhost:3001 --webhook-token <token> --ui-token <token>
```

setup.sh performs the following:

1. **Skills** -- Symlinks `harness/skills/azt-*` into `~/.claude/skills/`
2. **Rules** -- Symlinks `harness/prompt-modules/*.md` into `~/.claude/rules/`
3. **Settings** -- Merges azt-mcp (MCP server) and both hooks (`azito-notify.sh` + `azito-activity.sh`) into `~/.claude/settings.json`
4. **CLI tools** -- Makes tools in `harness/bin/` executable (`azs`, `azitoctl`)
5. **Env file** -- Only when both `--azito-url` and `--webhook-token` are given, writes `~/.azito/azitoctl.env` (mode 600). Always: `AZITO_URL`, `AZITO_WEBHOOK_TOKEN`, `AZITO_SUPERVISOR_PATH`. When provided: `AZITO_SERVER_NAME`. **`AZITO_UI_TOKEN` is never written here** (Issue #28 Phase B)
6. **operator.env** -- Only when `--ui-token` is given, writes `AZITO_URL` and `AZITO_UI_TOKEN` into `~/.azito/operator.env` (mode 600). setup.sh never sources this file itself — it is meant for a human to `source ~/.azito/operator.env` explicitly to act as the operator

`AZITO_URL` (default `http://localhost:3001`) and `AZITO_WEBHOOK_TOKEN` are also resolved from environment variables. Existing links and settings are skipped or updated, so re-running is safe. `--ui-token` (`AZITO_UI_TOKEN`) can be omitted, but a warning is shown that the MCP server config will not include a token. See [security-setup.md](./security-setup.md#principal-separation-operator--task) for the credential distribution split and its limits (chmod 600 does not protect against another process running as the same Unix user).

If the Codex CLI is installed (the `codex` command or `~/.codex` exists), the same skills and rules are also placed under `~/.codex/` and azt-mcp is registered via `codex mcp add`, so the same harness is available from both Claude Code and Codex.

### First-time azt-mcp Setup

To use azt-mcp, install the MCP server's dependencies first.

```bash
cd ~/.claude/skills/azt-mcp/mcp-server
npm install
```

`setup.sh` registers azt-mcp in the `mcpServers` section of `~/.claude/settings.json`. Authentication is required; passing `--ui-token` to `setup.sh` automatically registers `AZITO_UI_TOKEN` in the env, which is sent as an `Authorization: Bearer <token>` header.

## Install Status

AZITO's server detail panel visualizes each server's dependency install status (tmux, Node.js, **harness**, Tailscale, etc.). When the harness is not installed, it shows "azt-harness not installed" along with guided setup actions.

### Installing from the UI

You can also install the harness without the CLI by clicking "Install Harness" in the server detail panel → Setup tab (`POST /api/servers/:name/harness/install`). For local servers the install runs directly; for Agent servers it runs over SSH.
