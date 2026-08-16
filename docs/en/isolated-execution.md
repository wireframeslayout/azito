# Isolated Execution Profile (Issue #29)

## Scope of this document

When running task instructions that originate externally (issue bodies, PR comments — content
the operator did not write directly), code manipulated by a worker that can reach
operator-equivalent credentials could, via prompt injection, seize write access to the entire
hub, other servers, and repositories. The **isolated execution profile** is the
declaration/verification/runtime-gate mechanism for running such externally-sourced tasks only
on servers that hold **no credentials at all**.

For principal separation (operator/task principal, scoped auth) itself, see the
[Security Configuration & Environment Setup Guide](./security-setup.md). This document covers the
OS-level isolation (Issue #29) built on top of that.

## 1. What isolated execution is / the 3-layer model

Isolation is not a single mechanism — it is a combination of three layers with different
properties.

| Layer | What it does | Status |
|---|---|---|
| Layer 1: OS boundary | Configure the isolated server itself so it **never holds** operator-equivalent credentials (SSH private keys, `gh` auth, the operator token, hub secrets) | Operational (a choice made when the server is built) |
| Layer 2: distribution blocking | The hub **does not inject** operator-equivalent tokens into task panes on a server that has declared isolation | Implemented (`TaskPaneEnvironmentService`) |
| Layer 3: API authorization | Scoped auth restricts the task principal to an allowlisted set of APIs | Implemented in Issue #28. A **precondition** for declaring isolation |

The isolation doctor (below) is a self-reported health check that probes a fixed list of known
residual-credential locations (files, environment variables, `gh`/git config, ssh-agent
forwarding) on the target host. **It is not an end-to-end verification that Layer 2 holds on
every code path.** In particular, it never inspects the **task's tmux pane environment** — the
place where `TaskPaneEnvironmentService` applies its masking at window-creation time — so a
wiring regression that stopped that masking from reaching a newly created task window would leave
the doctor green while a task pane still leaked credentials. Layer 1 is the operational
configuration itself; the doctor only **confirms** the known locations it checks are in the state
the operator intended — it does not enforce the configuration, and it does not cover every
location Layer 2 depends on.

As a consequence of C-1 (Layer 3 as a precondition), **the PUT that enables `isolation_intent` is
rejected with 409 unless the hub has scoped auth (`AZITO_SCOPED_AUTH=1`) enabled** (see below).

## 2. Building an isolated server

Only `agent`-type servers can be targets of isolated execution (`local`/`ssh` are not eligible).

### Prerequisites

1. Set the target server up so it holds no SSH private keys, `gh` auth, operator token, or hub
   secrets (e.g. `AZITO_UI_TOKEN`) at all.
2. Enable scoped auth on the hub side first (order matters — see below).

### Activation order

1. **Get the scoped-auth doctor green.** Run `azito auth doctor` and confirm every server reports
   green (or not-applicable). See
   [Security Configuration & Environment Setup Guide](./security-setup.md#azito-auth-doctor).
2. **Enable `AZITO_SCOPED_AUTH=1`.** Restart the hub.
3. **Run `azito token rotate`.** This invalidates any old token still held by a pane that wasn't
   fully drained (see the migration steps in security-setup.md for detail).
4. **Build the isolated server.** Install the harness with
   `harness/setup.sh --purge-operator-token` (see below).
5. **Declare isolation.** Send `PUT /api/servers/:name` with `isolationIntent: true`.

Reversing this order (declaring isolation while scoped auth is still disabled) causes the PUT to
be rejected with `isolation_intent_requires_scoped_auth` (409).

### `setup.sh --purge-operator-token`

Passing `--purge-operator-token` to `harness/setup.sh` proactively removes any operator-equivalent
tokens left on that server:

- Deletes `~/.azito/operator.env` (if present)
- Strips `AZITO_UI_TOKEN` from `mcpServers.azt-mcp.env` in `~/.claude/settings.json`
- Strips `AZITO_UI_TOKEN` from Codex's `config.toml` (`mcp_servers.azt-mcp.env`)
- Cannot be combined with `--ui-token` (`setup.sh` itself rejects it with an error — distributing a
  token while purging it is a contradiction)

When an isolation declaration (a false→true transition of `isolationIntent`) succeeds, the hub
automatically attempts this cleanup once (returned in the PUT response as
`isolationCleanup: 'done' | 'failed' | 'skipped'`). On failure, the reason is recorded in
`isolation_cleanup_report`, and a true→true resend (retry) re-attempts it.

## 3. The isolation doctor

`POST /api/servers/:name/isolation/doctor` runs nine probes against a server that has already
declared isolation (`agent`-type only), checking whether credentials have actually reached it.

| check id | Misconfiguration it detects |
|---|---|
| `same_host` | The target server is the same host / shares a filesystem with the hub (hostname/uid match + a canary file readback) |
| `no_ssh_private_keys` | A PEM-format private key remains under `~/.ssh` |
| `gh_unauthenticated` | `gh` still has local credentials (a token in `hosts.yml`, or `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` set) |
| `no_git_credentials` | `git config credential.helper` resolves to something effective, or `~/.git-credentials` exists |
| `no_operator_token` | An `AZITO_UI_TOKEN=` line remains in `~/.azito/azitoctl*.env` or `operator.env` |
| `no_claude_mcp_token` | `AZITO_UI_TOKEN` remains in `mcpServers.azt-mcp.env` inside `~/.claude/settings.json` |
| `no_codex_mcp_token` | `AZITO_UI_TOKEN` remains in Codex's `config.toml` (`mcp_servers.azt-mcp.env`) |
| `no_operator_environment` | The execution environment `/api/exec` launches into (the inherited process environment) has any of `AZITO_UI_TOKEN`/`AZITO_WEBHOOK_TOKEN`/`AZITO_MASTER_KEY` set (`AZITO_AGENT_TOKEN` is the hub<->agent transport credential and is excluded) |
| `no_ssh_agent` | A forwarded `SSH_AUTH_SOCK` reaches a live ssh-agent with authenticating capability |

Each check reports one of `pass` / `fail` / `unknown`; `verified` is `true` only when **every**
check is `pass`. A probe that could not actually run (unreachable target, unrecognized output
shape, etc.) always folds to `unknown` — never rounded up to `pass` (fail-closed).

### Doctrine: the doctor is a misconfiguration detector, not an attestation

Every probe in the isolation doctor depends on self-reporting relayed through the agent process
running ON the target host, via `transport.exec()`. When the host itself is adversarial — for
example, it was already compromised by an externally-sourced task that ran on the isolated server
and tampered with the agent process or its environment — no check in this file, and no check added
later, can be trusted to see through that.

The actual defense against an adversarial host is structural, not probe-based: that host is never
handed a credential worth stealing in the first place (the Layer 2 distribution-blocking gate).
The isolation doctor's job is to confirm that structural gate is actually in the state the
operator believes it's in — a health check on the gate, not a substitute assurance for hosts the
gate doesn't cover.

**Scope note**: the nine checks above enumerate known locations where a leftover credential could
sit — files, environment variables, `gh`/git config, ssh-agent forwarding. None of them exercise
the **task tmux pane environment** a real task run actually creates (the place
`TaskPaneEnvironmentService` masks at window-creation time). This doctor is therefore a snapshot
health check of the known-location gate, not proof that the entire Layer 2 path is intact for a
given task run.

### Verification TTL and immediate invalidation on doctor failure

When the doctor completes with every check `pass`, `isolationVerifiedAt` is recorded, and this
verification is treated as current for **24 hours** (`ISOLATION_VERIFICATION_TTL_MS`). A
verification past its TTL is automatically treated as invalid (see section 4).

If a doctor run completes with even one `fail`/`unknown`, `isolationVerifiedAt` is cleared
**immediately** (preventing a stale "verified" from lingering).

## 4. The `allow` policy and runtime re-verification

For each (project, server) pairing, the execution policy for externally-sourced (untrusted-origin)
tasks can be set to `deny` / `manual-approval` / `allow`. `allow` is the loosest policy — it
executes automatically with no approval step.

`allow` only actually takes effect when the following **3-point AND** is re-evaluated by the
server on every single execution and all three hold:

1. The target server has declared `isolationIntent: true`
2. That isolation has been verified by the isolation doctor, and the verification is within
   `ISOLATION_VERIFICATION_TTL_MS` (24 hours)
3. Scoped auth (`AZITO_SCOPED_AUTH`) is enabled on this hub process

If any one of these breaks, `allow` automatically degrades to `manual-approval` — it never
degrades to `deny`, and never becomes an error. The degrade reason is one of:

| Degrade reason | Meaning |
|---|---|
| `not_isolated` | The server has not declared isolation |
| `verification_missing` | The isolation doctor has never succeeded |
| `verification_expired` | Verified, but the TTL (24 hours) has elapsed |
| `verification_failed` | `isolationVerifiedAt` is set but the paired verification report is not `verified: true` (defense-in-depth double check) |
| `scoped_auth_disabled` | Scoped auth is disabled on this hub |

## 5. Stated limits (TOCTOU, self-reporting)

- **Snapshot-only**: the isolation doctor's result is a snapshot taken at probe time. A credential
  written to the target server the moment after a passing probe returns is not detected (TOCTOU:
  time-of-check to time-of-use). The 24-hour TTL narrows this gap; it does not close it.
- **Dependence on self-reporting**: as the doctrine in section 3 states, every probe depends on the
  target host's own response. An adversarial host can spoof its self-report, so the doctor is a
  health check on whether the structural gate (Layer 2) is working, not a defense against an
  adversarial host itself.
- **Tailnet membership is out of scope**: whether a Tailscale SSH identity can reach other hosts on
  the tailnet (lateral movement) can neither be observed nor enforced by a per-server probe run
  from the hub. It is outside the isolation doctor's scope and is an operational responsibility of
  tailnet ACLs / firewalls (section 6).

## 6. Network isolation (defense against lateral movement)

Even when the isolated server itself holds no credentials, if it can still reach other hosts on
the tailnet via SSH, it can be used as a stepping stone for lateral movement. Always pair OS-level
isolation with network-level isolation.

### Tailnet ACL discipline (Tailscale deployments)

**Scope limitation**: Tailscale ACLs only govern traffic that goes through the tailnet overlay
(destinations reached via a Tailscale-assigned IP / MagicDNS name). Direct reachability to the
public internet, or to other hosts on the same LAN segment, is outside the ACL's control — an ACL
alone is not sufficient defense against lateral movement. The ACL example below only closes off
SSH lateral movement *within the tailnet*; blocking public-internet/LAN paths requires the
persistent host firewall in the next subsection, applied in addition to this ACL, not instead of
it.

Tag the isolated server `tag:isolated`, deny Tailscale SSH from that tag to every destination, and
allow outbound only to the hub's webhook port. Example ACL:

```jsonc
{
  "tagOwners": {
    "tag:isolated": ["autogroup:admin"],
  },
  "acls": [
    // outbound from the isolated server is allowed only to the hub's webhook port
    { "action": "accept", "src": ["tag:isolated"], "dst": ["<hub-tailscale-ip>:3001"] },
    // everything else from the isolated server is implicitly denied (allowlist model)
  ],
  "ssh": [
    // SSH *to* the isolated server is allowed only as operationally needed (defined separately)
    // SSH *from* the isolated server is never explicitly allowed = effectively denied to every destination
  ],
}
```

The key is to never write an SSH rule with `tag:isolated` as the **src**. Tailscale's `ssh` block
only permits explicitly-allowed pairs, so with no entry allowing SSH from `tag:isolated`, a host
carrying that tag cannot SSH out to anything.

### Firewall variant (required as a persistent host firewall regardless of Tailscale)

Because the tailnet ACL only governs tailnet-overlay traffic (previous subsection), blocking
lateral movement over the public internet, the local LAN, or IPv6 requires a **persistent**
dual-stack (IPv4 + IPv6) host firewall on the isolated server itself. Apply this at all times, as a
complement to the tailnet ACL, whether or not Tailscale is in use.

`iptables` only covers IPv4 — omitting `ip6tables` lets **IPv6 egress bypass the rule set
entirely**. `nftables` is recommended since it can cover both families in one rule set;
`iptables`/`ip6tables` in tandem (with the exact same rules applied to both) is equally effective.
Below is a complete stateful rule set: allow loopback → allow established/related traffic →
explicitly allow the required hub<->agent traffic → deny everything else (replace the hub
address/port with your environment's values):

```bash
# --- nftables (recommended: one rule set covers IPv4 and IPv6) ---
nft add table inet isolated
nft add chain inet isolated output '{ type filter hook output priority 0; policy drop; }'
nft add chain inet isolated input  '{ type filter hook input  priority 0; policy drop; }'

# Always allow loopback
nft add rule inet isolated output oif lo accept
nft add rule inet isolated input  iif lo accept

# Allow established/related traffic (required: the hub's inbound response
# lands on the hub's ephemeral port — without this rule the agent becomes
# unreachable from the hub)
nft add rule inet isolated output ct state established,related accept
nft add rule inet isolated input  ct state established,related accept

# Allow only new outbound connections to the hub's webhook/agent port
nft add rule inet isolated output ip  daddr <hub-ipv4> tcp dport 3001 ct state new accept
nft add rule inet isolated output ip6 daddr <hub-ipv6> tcp dport 3001 ct state new accept

# Everything else is denied automatically (chain policy is drop; no
# explicit rule needed for packets that don't match anything above)
```

```bash
# --- iptables + ip6tables (for environments without nftables — apply the
#     exact same rules to BOTH IPv4 and IPv6) ---
for CMD in iptables ip6tables; do
  # Always allow loopback
  $CMD -A OUTPUT -o lo -j ACCEPT
  $CMD -A INPUT  -i lo -j ACCEPT
  # Allow established/related traffic (required for the hub's inbound response)
  $CMD -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  $CMD -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
done
# Allow only new outbound connections to the hub's webhook/agent port (IPv4 and IPv6 each)
iptables  -A OUTPUT -d <hub-ipv4> -p tcp --dport 3001 -m state --state NEW -j ACCEPT
ip6tables -A OUTPUT -d <hub-ipv6> -p tcp --dport 3001 -m state --state NEW -j ACCEPT
# Deny everything else
for CMD in iptables ip6tables; do
  $CMD -A OUTPUT -j REJECT
  $CMD -A INPUT  -j REJECT
done
```

### Planned future work

- Machine-verification of the ACL (adding a `tailnet_acl` check to the isolation doctor): **#85**
- Turning the above into an application feature (settings UI / automatic application): **#86**

Both are manual operational procedures today. The isolation doctor's nine checks (section 3) do
not include tailnet ACL verification.

## 7. Pushing from isolated tasks is the operator's responsibility for now

Because an isolated server is assumed to hold no push credentials at all (no `gh` auth, SSH key,
or git credential helper), `PhaseLoopRunner` **automatically skips the pushing phase** (any phase
carrying the `pushVerify` flag) for a task running on a server with `isolationIntent: true`, even
if the Unit's `phaseConfig` includes it. The skip is recorded in the execution log as
`pushing_skipped_isolated`; once every other phase has completed normally, the task transitions to
`review` the same way a testing-terminated run would. Commit, push, and PR creation must be done
manually by the operator.

Official support for the hub pushing on behalf of an isolated task is planned in **#87** (a design
for distributing a push-only, scoped credential to isolated servers is under consideration). Until
then, assigning a Unit whose phase config includes `pushing` to tasks running on an isolated server
is safe (it is skipped automatically), but assigning a Unit without a `pushing` phase is still
recommended so the intent stays explicit.

Similarly, features that require operator-level privilege (e.g. operations via the CDP browser
/ "browser-ops") are not reachable from tasks on an isolated server under the current
architecture — they require operator-equivalent credentials, which never reach an isolated server
in the first place.

## Related documents

- [Security Configuration & Environment Setup Guide](./security-setup.md) -- Principal separation (operator/task), enabling scoped auth
- [Task Management Guide](./tasks.md) -- Task execution flow, the phase loop
