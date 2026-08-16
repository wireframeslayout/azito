# AZITO User Guide

AZITO is a browser-based tmux session manager designed for autonomous agent development. It lets you manage multiple coding agents -- Claude Code, Codex -- across local and remote servers through a unified web interface. Its core feature drives agents through a UnitType-defined phase loop, enabling fully autonomous task execution: a **Unit** (the team that runs an operation) drives a task through phases and determines what actually runs it (worker runtime), each phase's work is defined by a **Sidekick** (tagged skill package), and an **Operation** is one execution run of a Unit carrying out a task.

## Key Features

- **Terminal Management** -- View and interact with tmux sessions across multiple servers from your browser, using a full xterm.js terminal with touch scrolling and quick action buttons.
- **Terminal Themes** -- 7 preset themes plus savable custom themes. Live-edit colors (including all 16 ANSI colors), backgrounds (gradient / image / solid), and scope (terminal only / entire screen).
- **tmux Runtime Selection** -- Choose per server between system (existing tmux) and managed (AZITO-managed tmux, auto-provisioned with the recommended config).
- **Autonomous Task Execution** -- Configure a Unit's execution runtime (worker type, model) and let AZITO drive tasks through the Planning → Implementing → Reviewing → Testing → Pushing phases automatically, per the Unit's phase configuration.
- **azt-harness** -- Run each phase as native Claude Code `/azt-*` skills. Free of marker detection, Claude Code drives tasks forward through natural conversation. Ships with azt-mcp (MCP tools), prompt-modules (implementation rules), and a completion hook, installable via `setup.sh`. See [azt-harness Guide](harness.md).
- **Project Workspaces** -- Organize servers, tmux windows, Units, repositories, and files into per-project workspaces with a VS Code-style activity bar.
- **Task Form View** -- Create and edit tasks in a dedicated form screen (a Workspace tab), and link GitHub/GitLab issues directly from the form.
- **Base / Target Branch** -- Specify the base branch to fork from and the target branch to push/PR to when creating a task.
- **Task Archive / Restore** -- Archive finished tasks (releasing their tmux window and other resources) and restore them later along with their worktree and window.
- **Commit History** -- The task detail's Commits tab shows the worktree's commit list and per-commit diffs.
- **GitHub/GitLab Integration** -- Link repositories to projects, browse and search issues, and create tasks directly from issues. See [GitHub/GitLab Integration](github-integration.md).
- **Server Detail Panel** -- Visualize each server's dependency install status (tmux, Node.js, harness, Tailscale, etc.) with guided setup actions.
- **Token Usage** -- Check Claude/Codex token usage from a header dropdown.
- **Subagent Delegation** -- Configure subagent delegation (agent / model / extra args) per Unit, with per-task overrides; implementation rules are passed to subagents as files.
- **Agent Completion Webhook** -- Receive agent completion notifications via webhook (shared `AZITO_WEBHOOK_TOKEN`).
- **File Storage (MinIO)** -- Upload and manage files per project with drag-and-drop support and image thumbnails. See [File Storage Guide](storage.md).
- **PWA Push Notifications** -- Receive browser push notifications when tasks complete or fail, including on mobile. See [Push Notifications Setup](push-notifications.md).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | v24+ | Runtime for both server and frontend (bundled in the release build — needed there only for the browser runtime and supervised windows) |
| tmux | 3.4+ | Session management backend |
| Docker | Any recent | Required only for MinIO file storage |
| Tailscale | Latest | Required only for HTTPS and push notifications |

## Installation

Two ways in, depending on what you are doing.

| | Release build | Source checkout (development) |
|---|---|---|
| For | Using AZITO | Developing AZITO itself |
| Get it | Tarball from GitHub Releases (Node.js bundled) | `git clone` + `npm ci` |
| Config | `~/.azito/hub/.env` | `packages/server/.env` |
| Run | systemd / launchd service | `npm run dev` |

For the **release build**, see [Installation and Updates](install-and-update.md). The rest of this page covers the source checkout.

```bash
git clone <your-repo-url> azito
cd azito
npm ci
```

## Quick Start

### 1. Configure environment variables (required)

AZITO will not start without an auth token. Create `packages/server/.env`:

```bash
cat > packages/server/.env <<EOF
AZITO_UI_TOKEN=$(openssl rand -hex 32)
AZITO_WEBHOOK_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 packages/server/.env
cat packages/server/.env   # note the tokens — needed for the browser and harness
```

Accessing over Tailscale or using MinIO needs extra settings. See the [Security & Environment Setup Guide](security-setup.md) for the full variable reference.

### 2. Start the app

```bash
npm run dev
```

This starts the Fastify backend (`:3001`, SQLite `data.db` in the project root) and the Vite dev server (`:5173`) together.

### 3. Open the app

Navigate to `http://localhost:5173` and enter your `AZITO_UI_TOKEN`.

> The token is kept in `sessionStorage`, so each browser session asks for it again.

### 4. Install the harness

```bash
source packages/server/.env
./harness/setup.sh --azito-url http://localhost:3001 \
  --webhook-token "$AZITO_WEBHOOK_TOKEN" --ui-token "$AZITO_UI_TOKEN" --server-name local
```

Required for `/azt-*` skill API calls.

### 5. Create your first project

1. Click **Projects** in the top navigation bar.
2. Click **New Project** and fill in a name and optional description.
3. In project settings, add servers and tmux windows you want to manage.

### 6. Open the Workspace

Click a project name to open its Workspace. The workspace is the main working area where you interact with terminals, manage tasks, browse files, and configure Units. See [Workspace Guide](workspace.md) for details.

## Further Reading

- [Installation and Updates](install-and-update.md) -- Release install, where config lives, Tailscale access, updating and rolling back
- [Security & Environment Setup Guide](security-setup.md) -- Required env vars, migrating an existing install, new environment setup, Tailscale, troubleshooting
- [Isolated Execution Profile](isolated-execution.md) -- Running externally-sourced tasks on credential-free servers (the 3-layer model, the isolation doctor, the allow policy, network isolation)
- [Workspace Guide](workspace.md) -- Layout, sidebar modes, tab management, keyboard shortcuts
- [Push Notifications Setup](push-notifications.md) -- Enable PWA notifications via Tailscale HTTPS
- [File Storage Guide](storage.md) -- MinIO setup, uploading, and managing files
- [GitHub/GitLab Integration](github-integration.md) -- Connect repositories and work with issues
- [Sidekick / Unit / Operation Guide](sidekicks.md) -- How Sidekicks (tagged skill packages), Units (the team that runs an operation), and Operations (execution runs of a Unit) fit together
- [azt-harness Guide](harness.md) -- Native Claude Code execution (/azt-* skills, azt-mcp, prompt-modules, hook, setup.sh)
- [Task Management Guide](tasks.md) -- Task creation/execution flow, worktrees, stall detection, logs
- [File Operations Guide](files.md) -- File explorer, preview, download, external editor integration
- [tmux Configuration Guide](tmux.md) -- Required/recommended tmux settings for AZITO and how they apply per managed/system mode
- [Activity Detection Tier Reference](activity-detection.md) -- The running/blocked/idle judgment ladder (Tiers 0-4), stop reasons, timing constants, the diagnostics panel, and the question lifecycle
