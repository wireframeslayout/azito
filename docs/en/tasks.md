# Task Management Guide

## What Is a Task?

A task is a unit of work assigned to a Unit (the team that runs an operation). Each task holds information such as a title, description, and priority, and is executed autonomously according to the Unit's UnitType (phase definition) and execution runtime (worker type, model). Which Sidekick (tagged skill package) runs each phase is determined by the Unit's `phase_config`.

## Creating a Task

### From the Workspace

1. Select **Tasks** mode in the workspace activity bar.
2. Click the **+** button in the Tasks sidebar, or click the **+ New Task** button in the task list tab under All Tasks, to open a dedicated task creation form as a Workspace tab.
3. Fill in the following fields:

| Field | Description |
|---|---|
| Title | The task title |
| Description | A detailed description of the task |
| Project | The project to associate with |
| Assign to Unit | The Unit (workflow definition + execution runtime) that executes the task. Pre-selects the project's default Unit |
| Server Environment | Override the execution server (shown when the project is bound to multiple servers) |
| Priority | Priority (numeric, default: 0) |
| Plan Approval | Require plan approval (checkbox) |
| Self-Review Max | Maximum self-review attempts (0–3). Overrides the Unit's default |
| Base Branch | The branch the work branch forks from (defaults to the repository default) |
| Target Branch | The target branch for push / PR creation |
| Issue Link | Link a GitHub / GitLab issue directly from the form (optional) |
| Skip PR | Skip PR creation (commit + push only during pushing phase) |
| Branch | Working branch name (available when Skip PR is enabled; checks out existing branch if found) |
| Working Directory | Override the project's default working directory for this task |
| tmux Window | Specify the tmux window name (optional) |
| Subagent Override | Override the Unit's default review/implementation subagent settings (provider/model) |

4. Click the **Create** button.

> Task creation/editing happens in a dedicated form screen (tab), not a modal. Canceling returns you to the original task list / detail view.

### From a GitHub / GitLab Issue

You can also import a task from an issue. See the [GitHub/GitLab Integration Guide](github-integration.md) for details.

## Status List

A task can have one of the following statuses.

| Status | Description |
|---|---|
| `open` | Created, not yet started |
| `running` | A phase is actively executing |
| `phase_review` | Awaiting user approval of a phase result (e.g. plan approval) |
| `waiting_input` | Agent is asking questions, awaiting user response |
| `review` | All phases completed, awaiting final review |
| `in_progress` | Running (follow-up execution) |
| `done` | Completed |
| `failed` | Failed |
| `archived` | Archived (terminal state; resources such as the tmux window have been released) |

## Execution Flow

### UnitType-Driven Phase Loop

The phase sequence is defined by the Unit's UnitType (TOML). The default `devops` type
runs: planning → implementing → reviewing → testing → pushing.

```
open
  │
  ▼
running (phase N) ─────────────────────┐
  │                                    │
  ├─ planApproval → phase_review       │
  │                   │ approve        │
  │                   ▼                │
  │               running (phase N+1)  │
  │                                    │
  ├─ questions → waiting_input         │
  │                │ answer            │
  │                └───────────────────┘
  │
  ▼ (all phases complete)
review → done  (or failed — reachable from any phase)
```

## Worktree-Based Execution

A Git worktree is created automatically when a task runs, so work happens on an isolated branch.

### How It Works

1. When task execution starts, `git worktree add` runs against the project's repository.
2. Branch name: uses the user-specified branch name if given, otherwise `task/{id}-{slug}` (e.g. `task/42-add-login-page`).
3. The worktree is created at `<workingDir>/.worktrees/task-<id>` and the path is recorded in the task's `worktree_path` field (protected by a regex guard in `TaskCleanupService`).
4. The worker operates inside this worktree directory.

### Benefits

- **Accurate diffs** -- The diff against the main branch can be shown precisely.
- **Isolated execution** -- Other tasks and the main branch are unaffected.
- **Works well with parallelism** -- Each task runs in its own worktree, avoiding conflicts during parallel execution.

### Worktree Creation Failure

If worktree creation fails, the task is set to `failed` status and the tmux window is cleaned up. There is no fallback to continue in the original directory (fail-fast).

### Related Fields

| Field | Description |
|---|---|
| `worktree_path` | Filesystem path of the worktree |
| `worktree_branch` | Branch name of the worktree |
| `base_branch` | The branch it forks from (can be specified at task creation) |
| `target_branch` | The target branch for push / PR creation (can be specified at task creation) |
| `summary` | Execution summary on task completion (JSON format) |
| `agent_session_id` | Agent session ID (for session recovery) |
| `skip_pr` | Skip PR creation flag |
| `branch` | User-specified working branch name |
| `working_directory` | Per-task working directory (overrides the project server's default) |

## Plan Approval

When a phase with `planApproval: true` completes (e.g. planning in the devops UnitType), the task enters `phase_review` status.

### Approval Flow

1. The worker drafts an execution plan and writes it to the log.
2. The task transitions to `phase_review`.
3. Three buttons appear on the task detail view: "Reject", "Re-Plan", and "Approve".
4. **Approve** -- Approves the plan and proceeds to the next phase.
5. **Re-Plan** -- Sends it back with a comment and re-executes the same phase.
6. **Reject** -- Rejects the plan and sends the task back.

## Structured Questions (QUESTIONS_JSON)

When an agent needs confirmation during execution, it emits structured questions via the `QUESTIONS_JSON` marker.

### Question Format

```json
AZITO_QUESTIONS_<taskId>_<nonce>: [
  {"text": "What is the kanban column layout?", "type": "select", "options": ["5 columns", "all separate"]},
  {"text": "Any additional requests?", "type": "text"}
]
```

- `select`: Choose one from a set of options.
- `text`: Free-form input.

### Answer Flow

1. When the agent emits `QUESTIONS_JSON`, the task transitions to the `waiting_input` status.
2. A question UI appears on the task detail view (select boxes / text inputs).
3. The user enters answers and clicks "Submit Answers".
4. The answers are sent to the agent and task execution resumes.
5. If the agent emits additional questions, it transitions back to `waiting_input` (loop).

### Unique Markers

Markers generated dynamically per phase (`AZITO_DONE_<taskId>_<nonce>`, `AZITO_QUESTIONS_<taskId>_<nonce>`) reliably distinguish markers inside the prompt template from the agent's actual output.

## Follow-up Instructions

You can send additional instructions (follow-ups) to a running or paused task.

### How To Use

1. Type a message into the comment input area at the bottom of the task detail view.
2. Optionally select a **phase prompt chip** to attach a phase prompt.
3. Click the "Send" button.

Phase prompt chips let you attach a predefined phase prompt (e.g. "Run the tests", "Review it") with one click. Phase prompts are managed as Sidekick packages (`/api/sidekicks`).

## Session Resume and Automatic Recovery

If the server restarts or an error occurs while a task is running, the task can be resumed using the following methods.

### Worker `--resume`

The worker (Claude Code) session is resumed using the saved session ID (`agent_session_id`) via `claude --resume <session-id>`. This preserves the LLM's conversation context and continues from where execution was interrupted.

### Automatic Recovery at Startup (RecoverStuckTasksUseCase)

On server startup, `RecoverStuckTasksUseCase` automatically detects non-terminal tasks (`running` / `in_progress`) and attempts recovery:

1. Pane liveness check — confirms whether the tmux pane still exists
2. Done-marker check — examines signal files (`/tmp/azito-pipe-<taskId>-sig-*.log`) to determine if the phase completed
3. If completed, advances to the next phase; if not, re-executes the current phase (resume)

Concurrent resumes are capped at 3 and do not block server startup (fire-and-forget).

## Stall Detection and Retry

If a worker's output does not change during execution, stalling is detected in three stages.

### Detection Conditions (3 stages)

1. **30-second activity monitoring** — Worker output changes are monitored at 30-second intervals (`ACTIVITY_THRESHOLD_SEC = 30`)
2. **2-minute idle → LLM classification** — If output hasn't changed for 2 minutes, an LLM (PaneClassifier) performs fallback classification (`IDLE_TIMEOUT = 120_000`)
3. **5-minute max (extendable)** — If completely unresponsive for 5 minutes, judged as stalled (`MAX_IDLE = 300_000`). The overall max phase duration is 30 minutes (60 minutes with extension)

### UI Display

In the task log view (TaskLogView), a warning bar appears when the task log connection becomes stale (no updates for an extended period). It displays the elapsed time along with a **Retry** button that re-establishes the connection.

### Retry

Clicking the Retry button re-establishes the task log WebSocket connection and fetches the latest execution state.

## Archiving and Restoring Tasks

Finished tasks can be archived instead of deleted, and restored later with their working environment.

### Archive

Select **Archive** from the task detail menu. Running execution is stopped, the tmux window and window records are cleaned up, and the status becomes `archived`. Execution logs and task data are preserved.

### Restore

Select **Restore** on an archived task to recreate the worktree and tmux window and return the status to `open` (an existing work branch is checked out as-is; the operation rolls back on failure).

- The global task list has a filter for archived tasks.
- The status dropdown is disabled for archived tasks.

## Task Detail Tabs

The task detail view has the following tabs:

| Tab | Content |
|---|---|
| Description | Task description and details |
| Unit | Configuration of the assigned Unit |
| Git | Git information (branch, worktree status) |
| Summary | Execution summary on task completion |
| Commits | Worktree commit history (diff from base branch) |
| Diff | Diff against the base branch |

### Commit History

The **Commits** tab shows the worktree's commit history.

- Lists commits diverging from the base branch (`base..HEAD`)
- Select a commit to view its individual diff

## Task Deletion and Resource Cleanup

Deleting a task automatically cleans up associated resources:

- **tmux window** -- The tmux window tied to the task is killed.
- **Git worktree** -- The task's worktree is removed.
- **Temporary files** -- pipe-pane output files and signal files are deleted (**local server only**).

## Session Recovery

If an agent's pane (tmux window) is lost while a task is running, the session recovery feature lets you resume work.

### How It Works

- The TaskPanel checks pane liveness every 30 seconds (`paneAlive` flag).
- When the pane is lost, the status display changes to "lost" and a recovery button appears.
- Clicking the recovery button restarts the agent using the saved session ID (`agent_session_id`) via `claude --resume <session-id>`.

## Task Summary

When a task completes, an execution summary is automatically extracted and saved in JSON format. The summary can be viewed on the task detail screen.

## Skip PR Creation

Enabling "Skip PR" when creating a task causes the pushing phase to skip PR creation, performing only commit and push.

- The pushing prompt changes to "commit + push only, update existing PR if found" (controlled via `pushTaskDescription`, `pushRules`, `pushOutput` template variables).
- Completion checking skips PR existence verification (SHA match only).
- A user-specified branch name can be used for the worktree (checks out existing branch if found).

## Working Directory Override

Specifying a "Working Directory" when creating a task overrides the project server's default working directory.

- The task's `workingDirectory` takes priority across the entire execution pipeline: worktree creation, prompt template variables, push completion verification, and git info collection.
- Branch search is also linked to the task's working directory (BranchInput sends the `working_directory` parameter to the API).
- Falls back to the project server's configured directory when not specified.

## Task Logs

Every event that occurs during task execution is recorded in the execution log.

### Log Types

| Type | Description |
|---|---|
| `llm_request` | LLM request to the orchestrator |
| `llm_response` | LLM response from the orchestrator |
| `command` | Command / prompt sent to the worker |
| `output` | Output from the worker |
| `status_change` | Task status change |
| `user_comment` | Follow-up comment from the user |

### Real-Time Streaming

On the task detail view, logs are streamed in real time over WebSocket (`task-logs` mode). The UI uses a chat-style layout where each log entry is styled according to its type.
