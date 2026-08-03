# AZITO

English | [日本語](./README.ja.md)

**A workspace that gives you access to your development environment anytime, anywhere, from any device**

AZITO is a web application for controlling tmux sessions on remote servers from your browser and managing multiple AI coding agents (Claude Code, Codex) in one place.

## The Problem

In agentic development, you run AI agents across multiple projects simultaneously, repeatedly reviewing their output and issuing new instructions. Traditional workflows suffer from several problems:

- **Resource pressure** -- Launching VS Code for every project consumes large amounts of memory and CPU on the client machine, making it unstable
- **Scattered context** -- Multiple editor windows × multiple tmux windows × multiple panes pile up, and you lose track of what you were doing where
- **Location and device constraints** -- Driving tmux directly from a smartphone or a low-powered device is impractical, making it hard to work on the go

AZITO solves these problems and delivers a development experience that fits entirely in a single browser tab.

## Features

### Browser-based terminal management
A full terminal mode powered by xterm.js, with touch-swipe scrolling and quick-action keys (Enter / Esc / Ctrl+C / arrows) optimized for mobile. Operate tmux sessions, windows, and panes directly from the browser.

### Per-project workspaces
Windows, tasks, files, and Units (execution team definitions) are managed together per project. Switch between projects with a single click from a dropdown, while tabs persist across projects. Tabs can also be organized into tab groups.

### Autonomous agent execution
An autonomous execution loop that drives worker agents through the Planning → Implementing → Reviewing → Testing → Pushing phases. The work for each phase is defined by a Sidekick (a tagged skill package), while a Unit defines both the phase workflow (which Sidekick handles which phase) and the worker runtime (worker type, model). Each execution run of a Unit is called an Operation. Stall detection (5 minutes without output) and retries are also supported.

### azt-harness (Claude Code native execution)
A harness that runs each task phase as a Claude Code **`/azt-*` skill**. Instead of relying on markers such as `AZITO_DONE`, Claude Code progresses through plan → implement → review → test → push while conversing naturally with the user. It bundles **azt-mcp** (which exposes the AZITO API as MCP tools), implementation rules passed to subagents (prompt-modules), and completion / activity notification hooks — all installed into your Claude Code environment with a single run of `setup.sh`.

### Multi-server support
Connect to multiple development servers over a private network via Tailscale. Three server types are supported — Local, SSH, and Agent — with the Agent type offering automatic installation and automatic updates on remote servers.

### Worktree-based task execution
A Git worktree is created for each task, running on its own independent branch. This enables accurate diff display and isolated execution. The `IWorktreeService` interface allows worktree operations on both local and remote servers. User-specified branch names are supported, and an execution mode that skips PR creation (skipPr) is also available.

### GitHub / GitLab integration
Fetch and search repository issues and PRs/MRs, and create tasks directly from issues. Self-hosted GitLab is also supported.

### PWA support
Push notifications (on task completion or failure), add-to-home-screen, and offline support. Delivers a near-native app experience even on smartphones.

### File operations
File explorer, syntax-highlighted previews, image previews, PDF previews, file downloads, and integration with VS Code / Zed.

### Session recovery
If an agent's pane is lost, the agent can be restarted with a single click using its saved session ID. Pane liveness is checked every 30 seconds, with a recovery UI provided.

### Enhanced task management
Badges for task ID, issue number, and PR number; automatic summary generation on task completion; automatic cleanup of related resources (tmux window, worktree, temp files) on task deletion; and automatic recovery of non-terminal tasks on startup.

### Token usage tracking
Aggregates Claude / Codex token usage from local session logs and shows it in a dropdown in the header.

### Selectable tmux runtime
Each server can use either the system tmux or an AZITO-managed tmux (a static binary downloaded automatically with SHA256 verification). Recommended tmux settings can be applied from the server settings screen.

### File storage
File upload and sharing via MinIO (S3-compatible), with drag & drop support.

## Architecture

```
Browser (React 19 + Vite)
  ├── HTTP REST API ──► Fastify Server (TypeScript, feature-first modules)
  ├── WebSocket ──► terminal / task logs / event streams
  │
  └── Fastify Server
        ├── modules/         # 1 feature = 1 module (routes + service + repository together)
        │     ├── tmux/, servers/          # Foundation: tmux client, server transports (Local / SSH / Agent)
        │     ├── agents/, git/, llm/,     # Mid layer: workers, worktrees, LLM clients,
        │     │   prompt/, sidekicks/      #   phase prompts, Sidekick packages
        │     └── tasks/, windows/, units/, operations/,   # Upper layer: task execution (phase loop),
        │         projects/, files/, usage/, notifications/ #   projects, files, usage, push notifications
        └── shared/db/       # SQLite (WAL mode) + migrations
```

### Server types

| Type | Connection | Purpose |
|---|---|---|
| Local | Direct execution | The machine AZITO runs on |
| SSH | Tailscale SSH (`none` auth) | Remote development servers |
| Agent | AZITO Agent (HTTP) | Remote servers (with auto-install support) |

## Quick Start

### Prerequisites

The release build bundles Node.js; the rest are still needed on the host.

| Software | Version | Purpose |
|---|---|---|
| Node.js | v24+ | Backend and frontend (bundled in the release build) |
| tmux | 3.4+ | Terminal session management |
| Tailscale | Latest | SSH connections / HTTPS / push notifications |
| Docker | Latest (optional) | For MinIO (file storage) |

To use AI agents:
- **Claude Code CLI** (`claude`)
- **Codex CLI** (`codex`) -- flat-rate plan

For GitHub integration, the **GitHub CLI** (`gh`) is also required.

### Install (release build)

The release build ships its own Node.js runtime — no npm, no checkout:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/wireframeslayout/azito/releases/latest/download/install.sh | bash
```

> Use `| bash`, not `| sh` — the installer requires bash (`set -euo pipefail`).

It installs to `~/.azito`, registers a systemd (Linux) or launchd (macOS) service, and prints a UI token. Open `http://localhost:3001`. To review the script before running, pass options, or verify checksums, see [Installation and Updates](./docs/en/install-and-update.md).

Supported: Linux x64 / arm64, macOS Apple Silicon.

### Run from source (development)

```bash
git clone <repository-url> azito
cd azito
npm install
```

Start the backend (`:3001`) and frontend (`:5173`) together:

```bash
npm run dev
```

Open `http://localhost:5173` in your browser.

### Initial setup

1. **Check servers** -- A `local` server is registered by default. Add SSH / Agent servers from Settings
2. **Create a project** -- Create a project from the Projects page and set its working directory
3. **Open the workspace** -- In the project workspace, add windows and configure Units

## Documentation

See [docs/en/](./docs/en/) for detailed guides ([日本語版](./docs/ja/)).

| Document | Contents |
|---|---|
| [User guide](./docs/en/README.md) | Overview and quick start |
| [Installation and updates](./docs/en/install-and-update.md) | Release install, config locations, Tailscale access, updating |
| [Security & environment setup](./docs/en/security-setup.md) | Environment variables, tokens, hardening, troubleshooting |
| [Workspace](./docs/en/workspace.md) | Layout, sidebar, tab management |
| [Sidekick / Unit / Operation](./docs/en/sidekicks.md) | Sidekicks (tagged skill packages), Units (execution teams), Operations (execution runs) |
| [azt-harness](./docs/en/harness.md) | Claude Code native execution (/azt-* skills, azt-mcp, hooks) |
| [Task management](./docs/en/tasks.md) | Creating and running tasks, worktrees, stall detection |
| [File operations](./docs/en/files.md) | Explorer, previews (images, PDF), editor integration |
| [GitHub/GitLab integration](./docs/en/github-integration.md) | Fetching issues and PRs/MRs, creating tasks |
| [Push notifications](./docs/en/push-notifications.md) | Enabling PWA push notifications |
| [File storage](./docs/en/storage.md) | File management with MinIO |
| [tmux configuration](./docs/en/tmux.md) | Required/recommended tmux settings, managed/system runtime modes |

## Tech Stack

- **Frontend**: React 19, Vite, TypeScript, xterm.js
- **Backend**: Fastify, TypeScript (feature-first modules)
- **Database**: SQLite (better-sqlite3, WAL mode)
- **Terminal**: tmux, node-pty
- **Network**: Tailscale (SSH, HTTPS)
- **AI Agents**: Claude Code, Codex

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See the [LICENSE](./LICENSE) file for details.

Copyright (c) 2026 Junzo Matsunoo (wireframeslayout)

Contributions require signing the Contributor License Agreement. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CLA.md](./CLA.md) for details.
