# Sidekick / Unit / Operation Guide

> **Concept model (Issue #263 redesign, final form)**: the old "Sidekick" used to be "the unit that
> defines an execution environment" (orchestrator + worker + tmux session binding). This redesign
> settles into the following model:
>
> - **Sidekick** -- a **tagged skill package** (`SKILL.md` + `scripts/`). Carries `tags: string[]`; the
>   five values `planning`/`implementing`/`reviewing`/`testing`/`pushing` are treated specially as
>   **phase tags**. A Sidekick carrying a phase tag becomes an assignment candidate for that phase, and
>   `isDefault` marks it as the default candidate for each phase tag it carries. A Sidekick with no phase
>   tag is a general-purpose skill (e.g. issue creation).
> - **Unit** -- **the team that runs an operation**. A single entity holding both the workflow definition
>   (per-phase Sidekick assignment/enablement, system prompt, self-review and subagent config) and the
>   execution runtime (worker type, model, extra args, UnitType) — the Operation and
>   WorkerProfile split introduced earlier in the redesign was re-merged into one Unit.
> - **Operation** -- **one execution run** of a Unit carrying out a task. It is not a persisted
>   configuration entity; its only observable form is what `GET /api/operations` returns — the set of
>   currently-running (Unit × Task) pairs.
> - "Where it runs" is owned by `project_servers` (project↔server binding) and `tasks.server_name`
>   (per-task override).
>
> This page reflects the final model. If you were referencing an older doc (single-value `phase`,
> Operation-as-workflow-definition, a separate WorkerProfile), read it against this page instead.

## Overview

Running a task combines three elements:

```
Task
 ├─ Unit (the team that runs the operation)
 │   ├─ phaseConfig ─→ which Sidekick each phase uses (candidates filtered by tag)
 │   └─ execution runtime (workerType / workerModel / workerExtraArgs)
 └─ serverName / project_servers (where it runs)
```

- **Sidekick**: "how" a phase does its work (prompt + deterministic scripts); its `tags` decide which
  phase(s) it's eligible for
- **Unit**: the team holding both the workflow "configuration" (Sidekick assignment, behavior) and the
  "means of execution" (worker, orchestrator)
- **Operation**: one run of a Unit while it's actively executing a task (observable in the running list)
- Execution location is determined by the project↔server pairing (`project_servers`), optionally
  overridden per task via `server_name`

## Sidekick (tagged skill package)

### Structure

A Sidekick is a directory in the same format as a Claude Code Skill:

```
<name>/
  SKILL.md        Required. YAML-style frontmatter + Markdown body
  scripts/        Optional. Shell scripts that deterministic work (git ops, file ops, etc.) is delegated to
  references/     Optional. Reference material
```

`SKILL.md` frontmatter:

```yaml
---
name: robin                          # kebab-case (^[a-z0-9][a-z0-9-]*$). A persona name is recommended
description: One sentence describing what this skill does
tags: implementing, reviewing        # Free-form tags, comma-separated. Multiple phase tags are allowed
isDefault: false                     # Whether this is the default Sidekick for each phase tag it carries
---
Body (Markdown with template variables)
```

`tags` is a free-form array of tags. The five values `planning` / `implementing` / `reviewing` /
`testing` / `pushing` are treated specially as **phase tags** — a Unit's `phaseConfig` can only assign a
phase to a Sidekick that carries that phase's tag. A Sidekick with no phase tag at all is a
general-purpose skill (e.g. issue creation), invoked directly by name from skills like `/azt-sidekick`.
A single Sidekick may carry more than one phase tag (e.g. a package that does both implementing and
reviewing).

### Persona naming convention

Custom Sidekicks are recommended to carry a distinct persona name, like Robin or Falcon. The `name`
field is the invocation name itself, so `/azt-sidekick robin` reads naturally and is easy to remember.
A functional name like `xxx-default` also works, but a persona name is easier to tell apart once you're
running several custom Sidekicks.

### Two layers (builtin / user)

- **Builtin layer**: standard packages shipped under `harness/sidekicks/*`
- **User layer**: packages a user has created or edited (`<repo-root>/data/sidekicks/`; overridable via the `AZITO_SIDEKICKS_DIR` environment variable, resolved once at startup)
- When a package with the same name exists in both layers, **the user layer wins** (`overridesBuiltin: true`)
- Editing a builtin package triggers **copy-on-write**: the whole package (including `scripts/` and
  `references/`) is copied into the user layer first, and the edit is written there. From then on that
  package is treated as belonging to the user layer and is no longer affected by builtin updates (harness upgrades)
- Only the user layer can be deleted. To undo a user override and "revert to builtin", delete the user-layer
  copy (`DELETE /api/sidekicks/:name`, or "Revert to built-in" in the UI)

### The 7 built-in packages

| name | tags | Purpose |
|---|---|---|
| `planning-default` | planning | Analyze the task and draft an implementation plan |
| `implementing-default` | implementing | Implement according to the plan |
| `reviewing-default` | reviewing | Review its own implementation and fix issues |
| `testing-default` | testing | Run tests on the implemented code |
| `pushing-default` | pushing | Commit/push/open a PR by running a script (`scripts/push.sh`) |
| `issue-default` | issue | Create an issue (`/azt-issue` is a thin wrapper around it) |
| `browser-ops` | browser | CDP browser connection helper and login / log hygiene conventions |

### Template variables

The `SKILL.md` body can embed the following template variables (`{{...}}` syntax), expanded by
`renderSidekickBody` / `expandPromptTemplate`.

| Variable | Content |
|---|---|
| `{{task.title}}` / `{{task.description}}` / `{{task.plan}}` / `{{task.targetBranch}}` | Basic task info |
| `{{task.pushTaskDescription}}` / `{{task.pushRules}}` / `{{task.pushOutput}}` | Pre-built template vars for the pushing phase (content varies based on `skipPr`) |
| `{{project.sidekickPrompt}}` / `{{project.defaultBranch}}` | Project-level extra instructions / default branch |
| `{{projectServer.workingDirectory}}` / `{{projectServer.branch}}` | Working directory / branch on the execution server |
| `{{selfReview.attempt}}` / `{{selfReview.maxAttempts}}` | Self-review attempt counters |
| `{{module.reviewPerspectives}}` / `{{module.softwareDesignPrinciples}}` / `{{module.uiDesignPrinciples}}` | Body of the rule files under `harness/prompt-modules/` |
| `{{sidekick.dir}}` | Absolute path of this package's directory (**relative to the execution server** — resolves to the synced remote path on ssh/agent servers) |
| `{{sidekick.name}}` | Package name |

When rendering without a `task_id` (e.g. previewing a general-purpose package), `task.*` / `project.*` /
`projectServer.*` / `selfReview.*` are left unexpanded (only `{{sidekick.*}}` / `{{module.*}}` are expanded).

### The scripts/ delegation convention

Deterministic work (git operations, file operations, or anything requiring reproducibility) should not
be spelled out in the body — extract it into a shell script under `scripts/`. The body instructs
execution as `{{sidekick.dir}}/scripts/xxx.sh`.

**Important**: template expansion is never applied to the contents of files under `scripts/` (to prevent
injection). If the body needs to pass values to a script, the convention is to pass them **as environment
variables at execution time**. Injecting external input (like a task's `title`/`description`) into a
script via string substitution would be a command-injection vector, so it is disallowed.

### Syncing to remote servers

When a task runs on an ssh/agent server, Sidekick packages are synced to that server before execution
(`SidekickSyncService`, placed under `~/.azito/sidekicks/<name>/`). The sync is hash-based and only
transfers when something changed; a lock (`~/.azito/sidekicks.lock`) prevents races when multiple tasks
run concurrently.

### Execution protocol envelope

A `SKILL.md` body should describe only *capability* (what to do). It must not encode the *execution
protocol* — how completion/questions/test-failure get signaled back. That's added by the execution
context, as an "envelope" wrapped around the body (`executionEnvelope.ts`, Issue #263 Refine D):

- **state-machine** (`PhaseLoopRunner`, when `workerExecutionMode: 'tmux-pipe'`): appends a
  `<completion_signal>` block with `AZITO_DONE_*` / `AZITO_QUESTIONS_*` / `AZITO_TEST_FAILED_*` markers
  and an `AZITO_PHASE_SUMMARY` line. The questions/test-failed sections are conditional on the
  UnitTypePhase definition's `questions` / `testFailed` flags
- **http-signal** (`PhaseLoopRunner`, when `workerExecutionMode: 'http-signal'`): appends an envelope
  that instructs the worker to signal completion, questions, and test failures via the `azitoctl` CLI
  (`azitoctl complete` / `azitoctl questions`) instead of writing markers to a signal file
- **skill** (harness skills like `/azt-plan`, via `RenderSkillPromptUseCase`): appends natural-language
  instructions ("report when done", "ask the user directly if unclear") using the same UnitTypePhase flags
- **standalone** (`GET /api/sidekicks/:name?render=1`, direct `/azt-sidekick` execution): no envelope is
  applied at all — the body is returned as authored

Because of this, a `SKILL.md` body must never contain marker text or echo commands like
`PHASE_COMPLETE` / `QUESTIONS_JSON` / `TEST_FAILED` (also called out in `/azt-summon`'s authoring rules).

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sidekicks` | List (meta only, no body; includes `tags`/`isDefault`) |
| GET | `/api/sidekicks/:name` | Detail (includes body). `?render=1` expands template variables (`task_id` optional) |
| POST | `/api/sidekicks` | Create in the user layer (name/description required; tags/body/scripts/isDefault optional) |
| PUT | `/api/sidekicks/:name` | Update (description/tags/isDefault/body/scripts). Copy-on-write for builtins |
| DELETE | `/api/sidekicks/:name` | User layer only (revert to builtin, or delete a user-only package entirely) |

## Unit (the team that runs an operation)

A Unit holds both "how a task proceeds" (behavior) and "what runs it" (execution runtime). Of what the
old "Sidekick" used to hold for the execution environment (tmux session, worker type, etc.), "where it
runs" stays on `project_servers` / `task.serverName`, but "which worker, driven how" now lives on the
Unit itself (the Operation/WorkerProfile split introduced earlier in the redesign was re-merged into one Unit).

### What it holds

| Field | Description |
|---|---|
| Name | Unit name |
| UnitType | The UnitType name defining the phase structure (`devops`, etc., defined in `harness/unit-types/*.toml`) |
| Worker Type / Worker Model / Worker Extra Args | Execution runtime: `claude` / `codex` / `generic`, its model, and extra CLI args |
| Worker Execution Mode | How the worker's output is monitored (`tmux-pipe` / `http-signal`) |
| Worker Runtime | Worker runtime (`tui`) |
| System Prompt | Base prompt the worker references on each phase (optional) |
| Self-Review Max Attempts | Default max retry count for self-review (send-back during the reviewing phase). Can be overridden per task |
| Review Subagent / Implement Subagent | Config (provider/model) for delegating review/implementation work to a subagent. Can be overridden per task |
| Phase Config | Per-phase Sidekick assignment and enablement |

> **Note:** UnitType TOML definitions cannot currently be created or edited from the UI (the only built-in type is `devops`). To add a custom UnitType, place the file in the user-layer directory `data/unit-types/` (overridable via `AZITO_UNIT_TYPES_DIR`). `harness/unit-types/` is the built-in layer and is overwritten on release updates.

The phase sequence is determined by the UnitType definition (TOML) referenced by the Unit's `unitType`.
The default `devops` type transitions through planning → implementing → reviewing → testing → pushing
according to `phaseConfig`

### Per-phase configuration via phaseConfig

`phaseConfig` lets you specify the following for each phase defined by the UnitType:

```jsonc
{
  "implementing": { "sidekick": "robin" }, // use a non-default Sidekick just for this phase
  "testing": { "enabled": false }          // skip this phase
}
```

- If `sidekick` is omitted, the phase's default package (the one carrying that phase's tag with
  `isDefault: true`) is used
- If the specified Sidekick doesn't carry the tag for the phase it's assigned to, it's an error
  (fails fast as a configuration mistake — it never silently falls back)
- A phase with `enabled: false` is excluded from the execution order; the flow transitions directly
  from the previous enabled phase to the next enabled one

The resolution logic is centralized in `resolvePhaseSidekick.ts`, used by both the state-machine
execution loop (`PhaseLoopRunner`) and the prompt resolution for `/azt-*` skills (`RenderSkillPromptUseCase`) —
so the two never diverge.

### Project default + per-task override

- `project.defaultUnitId`: the project's default Unit. Task creation forms pre-select it automatically
  and label it as the project default
- `task.unitId`: per-task override (falls back to the project's default when `null`). If neither the
  task nor the project has a Unit, execution fails at runtime — the UI warns about this ahead of time
- Likewise, `task.serverName` (execution server override), and `task.selfReviewMaxAttempts` /
  `task.reviewSubagent` / `task.implementSubagent` (per-task overrides of the Unit's defaults) also exist

### Migration map from the earlier concepts

| Earlier field | Final home |
|---|---|
| Old Sidekick's Worker Command / Worker Model / Worker Extra Args | Unit (execution runtime) |
| Old Sidekick's Orchestrator Provider / Orchestrator Mode | Removed (orchestratorMode has been replaced by UnitType-driven phase loop) |
| Old Sidekick's Server / tmux Session | `project_servers` (project↔server binding); per-task via `task.serverName` |
| Old Sidekick's Max Concurrency | Removed (the concept of controlling parallel execution count no longer exists) |
| Operation (workflow definition)'s System Prompt / Self Review Max Attempts / Subagent Delegation / Phase Config | Merged into Unit as-is |
| WorkerProfile (execution runtime), in full | Merged into Unit. `project.defaultWorkerProfileId` → `project.defaultUnitId` |
| Sidekick's single-value `phase:` | Sidekick's `tags: string[]` (multiple allowed: phase tags + free-form tags) |
| Operation (formerly: the workflow-definition DB entity) | Merged into Unit, both in name and substance. "Operation" is repurposed to mean "an execution run of a Unit" |

## Operation (an execution run of a Unit)

In the final model, "Operation" refers to **one execution run** of a Unit while it's carrying out a
task. It is not a persisted configuration entity; it's only observable as the list `GET /api/operations`
returns — the currently-running set of (unitId, taskId, target) triples. The workflow definition itself
lives on the Unit.

## Execution location (project_servers / task.serverName)

- The `project_servers` table holds project↔server bindings (including `working_directory` /
  `branch` / `tmux_session`). A single project can be bound to multiple servers
- By default a task uses the server from the project's first `project_servers` row, but this can be
  overridden per task via `task.serverName`
- A per-task `workingDirectory` override is also available (takes precedence over the project server's default directory)

## UI

| Screen | Purpose |
|---|---|
| **Sidekicks** (skill library) | Sidekick list grouped by phase tag (a Sidekick with multiple phase tags appears in each matching group). Click a tag to filter. Shows `Built-in` / `Custom`, `Default`, `Overridden`, `Scripts` badges. Click through to the detail view (edit SKILL.md body; tags use a chip input) |
| **Units** | Unit list. Shows a runtime summary (Worker Type/Model chips), self-review count, disabled phases, and custom Sidekick assignments as badges. Click through to a detail view (config, assigned tasks, logs), with "Edit Unit" leading to the edit screen. The edit screen is organized Name → Runtime → Phases → Subagents → Advanced (System Prompt, Self-Review) |
| **Operations** | List of currently-running Operations (Unit × Task pairs). Shows the Unit name, task title, and execution target; click through to open the task |

## Using /azt-summon and /azt-sidekick

- `/azt-sidekick <name...> [task_id]`: run one or more Sidekicks on the spot by name, in order. Lists
  available packages when no name is given
- `/azt-summon`: **create or edit** a Sidekick in the user layer from the current conversation's work.
  If it refers to an existing Sidekick (matching name, "fix the ... skill", etc.), it enters edit mode —
  fetching the current content via `GET /api/sidekicks/:name` and then calling `PUT /api/sidekicks/:name`.
  For a new package it calls `POST /api/sidekicks`. A persona name (robin, falcon, etc.) is recommended.
  See `harness/skills/azt-summon/SKILL.md` for details
