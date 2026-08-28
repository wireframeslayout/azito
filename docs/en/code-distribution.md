# Code Distribution (Issue #87)

## Scope of this document

**Code distribution** is the mechanism by which the hub uses its own git credentials to provision
project code on a target server, so that server can hold no git credentials of its own and still
be ready to run tasks.

It started as a feature exclusive to the [Isolated Execution Profile](./isolated-execution.md)
(an isolated server holds no credentials, so provisioning code onto it can only happen if the hub
does it on the server's behalf), but Issue #87 Phase 2 generalized it into an independent opt-in
feature. This document covers the distribution mechanism itself; isolation-specific concerns (the
3-layer model, the isolation doctor, how the pushing phase behaves) live in
[Isolated Execution Profile](./isolated-execution.md).

## 1. Where it applies and how it's enabled

Whether distribution runs for a given task is decided per-server at execution time:

| Server | Distribution |
|---|---|
| `local` (the hub itself) | Never — "distributing" to the hub's own server is meaningless |
| Isolated server (`isolationIntent: true`) | **Always** — an isolated server has no credentials of its own to clone with, so there's no opt-in choice to make |
| Any other `ssh`/`agent` server | Only if the project's distribution option (default off) is enabled for that server |

The distribution option for non-isolated servers is a toggle in Settings -> Project -> Servers, in
the add/edit form for a project server, right below the working directory field (default off).
This is meant for setups where the hub itself carries no dev environment — no working checkout, no
local dev toolchain — even though it still holds the project's git credentials (it needs them to
fetch on the repository's behalf). Development happens entirely on the agent server, and the hub is
used only for its own functions (task execution, monitoring, etc.).

Either way, distribution requires SSH. Even for an `agent`-type server, distribution needs SSH
connection details (`sshHost`, etc.) configured for SFTP transfer. Distributing to a server that
has no usable SSH fails loudly (it is not silently skipped).

## 2. How it works

Distribution runs after window creation and before worktree creation, serialized per
server-repository pair (concurrent distributions to the same server x repository are queued, so
writes to the mirror never race).

### 2.1 The hub-side cache

The hub keeps an authenticated bare repository cache at
`$AZITO_DATA_DIR/repo-cache/<repoHash>`. `repoHash` is derived deterministically from the
repository's normalized URL, and both the hub-side cache and the server-side mirror (below) use
the same hash for the same repository. On every distribution, the hub fetches just the target
branch into this cache using the project's configured credential, bringing it up to date.

### 2.2 The server-side bare mirror

The target server gets a per-repository, distribution-only bare mirror at
`~/.azito/repos/<repoHash>.git` (created with `git init --bare` on first use if it doesn't yet
exist). This mirror is not where a task works — it exists purely as the landing spot for
distributed content.

### 2.3 Bundle transfer, verification, and ingestion

The hub builds a bundle from its own cache with `git bundle create`, then **transfers it to the
server over SFTP**. The server verifies the received bundle with `git bundle verify` before
ingesting it into the mirror with a forced `git fetch --atomic`
(`+refs/heads/<branch>:refs/heads/<branch>`) — a forced refspec so an upstream force-push doesn't
make ingestion fail non-fast-forward; the next distribution self-heals instead.

### 2.4 Incremental distribution and its prerequisite

Every distribution after the first tries to build an incremental bundle (just the diff since the
last one delivered). The key design point: **the incremental prerequisite is not the "last
distributed SHA" recorded in the DB — it's the mirror's actual received ref, queried fresh on
every distribution**. The DB record is an observational cache only; it is never treated as the
source of correctness. That means drift between the DB and the mirror (the mirror got wiped
manually, or upstream force-pushed and rewrote ancestry) self-heals on the next distribution
instead of permanently breaking incremental delivery. If building, verifying, or ingesting the
incremental bundle fails, distribution falls back to a full bundle exactly once and retries.

### 2.5 Preparing the working directory

Once the mirror is updated, the task's working directory (`workingDir`) is prepared:

- If it doesn't exist yet, it's created with `git clone --no-local --branch <branch>` from the
  mirror (`--no-local` is required — a local clone's hardlink optimization can race a concurrent
  update to the source/mirror).
- If it already exists, it's updated by fetching from the mirror directly. This update **force-
  updates only the tracking ref (`refs/remotes/origin/<branch>`) and never touches the local
  branch ref** — force-rewriting the local branch would fail the fetch outright whenever that
  branch is checked out in a linked worktree (e.g. a task whose branch input names the base branch
  itself), and every later distribution to that server x repository would then fail permanently.
  Callers that need the updated content (task worktree creation, below) must reference
  `origin/<branch>` explicitly.
- The working directory's HEAD is detached every time (idempotently, on both the clone path and
  the fetch-update path). The working directory is a distribution landing spot, not somewhere a
  human works — leaving it on a checked-out branch would make a later task worktree creation that
  wants the same branch name fail.
- The working directory's `origin` remote URL is set to a **dummy URL** (an `.invalid` domain).
  The server is deliberately prevented from reaching the upstream repository directly; all further
  updates must go through the mirror (the fetch above).

### 2.6 The task worktree

A task's worktree is created from the distributed working directory. Whenever distribution
actually delivered something this call (a fresh distribution, or confirming it was already
current), worktree creation resolves its base branch as `origin/<base branch>` explicitly — the
working directory's local branch ref is never updated (see above), so using it directly could
resolve stale content.

## 3. Residual risk (a limit of isolation)

The server-side bare mirror sits under **the same Unix user the task itself runs as**. Since a
task can already run arbitrary code as that user, the mirror sharing that user is not itself a
privilege escalation. But it does leave room for a task to rewrite the mirror's `refs`/`objects`/
`config` directly — poisoning what gets propagated into the working directory (and from there,
into later task worktrees) on the next distribution, or disrupting distribution outright. The
current mitigation stops at appending `-c core.hooksPath=/dev/null` to every git invocation that
touches the mirror, which prevents hook execution but does not separate the mirror's ownership
from the task's execution user. Treat this as one of the stated limits of isolation.

## 4. Network requirements

Distribution requires SSH connectivity from the hub to the server (SFTP is an SSH subsystem). For
firewall rules when using this on an isolated server, see the [Isolated Execution Profile's
network isolation section](./isolated-execution.md#6-network-isolation-defense-against-lateral-movement)
— inbound must allow the SSH port in addition to `agentPort`.

## Related documents

- [Isolated Execution Profile](./isolated-execution.md) -- Application on isolated servers (always distributed), network isolation, how the pushing phase behaves
- [Task Management Guide](./tasks.md) -- Task execution flow, worktree creation
