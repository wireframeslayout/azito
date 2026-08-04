# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities through **GitHub private vulnerability reporting**: go to the repository's **Security** tab and click **"Report a vulnerability"**.

**Do not open public issues or pull requests for security bugs.** Public disclosure before a fix is available puts all users at risk.

We will acknowledge your report as soon as possible, keep you informed of progress, and credit you in the fix release unless you prefer otherwise.

## Supported Versions

Security fixes are applied to the latest release and the `master` branch only. Please make sure you are running the latest version before reporting.

## Deployment Security Model

> **AZITO is a power tool designed for trusted private networks. Read this section before deploying.**

AZITO orchestrates autonomous coding agents and, by design, launches them with **permissive flags**:

- Claude Code workers run with `--dangerously-skip-permissions`
- Codex workers run with `--dangerously-bypass-approvals-and-sandbox`

In addition, AZITO itself has **full shell access** to every machine it manages — locally, over SSH, and via deployed agent processes. Anyone who can reach the AZITO server can execute arbitrary commands on all connected machines as the AZITO user.

AZITO is intended for use by a **single trusted operator** on a **trusted private network**, such as:

- `localhost` only, or
- a private overlay network like a Tailscale tailnet.

### Hard rules

- **NEVER expose the AZITO server, its WebSocket endpoints, or the bundled MinIO instance to the public internet.** Do not port-forward them, do not put them behind a "hidden" URL, and do not rely on obscurity. If you need remote access, use a VPN/tailnet.
- **Change the default MinIO credentials** in your `.env` before use.
- **Set `AZITO_WEBHOOK_TOKEN`** (in `packages/server/.env`) so that webhook endpoints (`/api/webhooks/*`) require authentication. The same token must be configured on the Claude Code hook side.

### Handling externally authored input

AZITO can import GitHub / GitLab issues as tasks, and the imported text reaches agents that run
with the permissive flags above. Hardening this path — trust gates, prompt-level trust boundaries,
per-phase secret allowlists, and execution isolation — is tracked in
[#22](https://github.com/wireframeslayout/azito/issues/22) and is **not complete yet**.

Until it is, treat imported issue text as untrusted input:

- Do not import issues that untrusted third parties can edit.
- When importing an external issue, review its body first and create the task manually.
- Register only the project secrets a project genuinely needs.

### Additional recommendations

- Run AZITO under a dedicated user account with only the access the agents genuinely need.
- Treat every machine registered in AZITO (local, SSH, agent) as fully controllable by anyone with access to the AZITO UI or API.
- Keep the host, Node.js, and agent CLIs up to date.

## Bundled Node.js Runtime

Release bundles include a Node.js binary to ensure ABI compatibility with native modules (better-sqlite3, node-pty, ssh2). This means:

- Security updates for the bundled Node.js are the responsibility of this project.
- When an upstream Node.js security release is published, we will re-package and release within **one week**.
- Users running release bundles should update promptly when a new release is available.

If you are running from source (`git clone`), you manage your own Node.js installation and this policy does not apply.

## Data Protection

- `AZITO_DATA_DIR` contains sensitive data (`master.key`, `ui-token`, `data.db`). It is created with mode 700.
- Release bundles never include the `data/` directory. CI verifies this assertion on every build.
- The `master.key` encrypts secret columns in the database. Back it up and protect it.
