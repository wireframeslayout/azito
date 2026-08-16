# Isolated Execution Profile (Issue #29)

## Scope of this document

When running task instructions that originate externally (issue bodies, PR comments — content
the operator did not write directly), code manipulated by a worker that can reach
operator-equivalent credentials could, via prompt injection, seize write access to the entire
hub, other servers, and repositories. The **isolated execution profile** is the
declaration/verification/runtime-gate mechanism for running such externally-sourced tasks only
on servers that hold **no operator-equivalent or repository-push credentials** (SSH private keys,
`gh` auth, the operator token, hub secrets — see the table below). An isolated install
intentionally still retains a narrower set of transport/signal credentials: `AZITO_WEBHOOK_TOKEN`
(used by `~/.azito/azitoctl*.env` and the activity/interaction hook scripts) and the agent
transport token (`AZITO_AGENT_TOKEN`, the hub<->agent connection credential). Both are scoped to
talking to the hub — reporting activity/completion signals and accepting hub-issued commands over
that one channel — and carry none of the operator's actual authority (they cannot push code,
authenticate `gh`, or call any API outside what the agent transport itself exposes).

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

**ACLs are additive, not exclusive**: Tailscale's `acls` list is evaluated as an allowlist — every
`accept` rule that matches a given src/dst pair is independently in effect, regardless of what
other rules exist. Adding the two `accept` rules below does **not** by itself produce "only these
two directions are reachable." If your tailnet already has a broad grant (a wildcard rule covering
`*`, an `autogroup:member`-to-`*` default, or any other pre-existing rule whose `dst` happens to
also match `tag:isolated`), that rule keeps matching traffic to/from the isolated server exactly as
it did before you tagged it — the two rules below add reachability on top, they never subtract it.
**Before relying on this ACL, audit the tailnet's full `acls` list for any existing rule whose
`dst` (or `src`, for outbound) would match `tag:isolated`, and narrow or remove it** — most
commonly a legacy `{"action":"accept","src":["*"],"dst":["*:*"]}`-shaped default, or a
"management/monitoring" grant that was written before this tag existed. The isolated server's
actual reachability is the union of every matching rule in the tailnet-wide policy file, not just
the two rules shown here.

There are **two directions** of traffic between the hub and an isolated server, and they carry
different intent. The ACL needs to distinguish and allow both:

- **hub → isolated server (inbound)**: the hub dials out to the `agent`-type server's HTTP/WS port
  for exec, terminal, and doctor probes. The destination is the isolated server's `agentPort` (the
  agent process's listen port — fixed at install time; get the value from your AZITO configuration)
- **isolated server → hub (outbound)**: the isolated server's hook scripts POST webhooks
  (`agent-done`, `agent-activity`, etc.) to the hub. The destination is the hub's webhook port (the
  hub's listen port as reachable via `AZITO_PUBLIC_URL` — get the value from your AZITO
  configuration)

Tag the isolated server `tag:isolated`, allow only those two directions, and implicitly deny
everything else to/from the isolated server (including lateral movement to other nodes). Example
ACL:

```jsonc
{
  "tagOwners": {
    "tag:isolated": ["autogroup:admin"],
  },
  "acls": [
    // hub -> isolated server: allow reaching the agent's HTTP/WS port (agentPort)
    { "action": "accept", "src": ["<hub-tailscale-ip>"], "dst": ["tag:isolated:<agent-port>"] },
    // isolated server -> hub: allow outbound only to the hub's webhook port
    { "action": "accept", "src": ["tag:isolated"], "dst": ["<hub-tailscale-ip>:<hub-webhook-port>"] },
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
carrying that tag cannot SSH out to anything — but that block only ever governs **Tailscale SSH's
own authorization layer** (who Tailscale SSH will let in as which local user). It does not replace
the `acls` network-reachability check above: a connection to port 22 must first be allowed by an
`acls` rule (network authorization) before Tailscale SSH's `ssh` block is even consulted (session
authorization). An empty/absent `ssh` entry for `tag:isolated` closes the SSH-specific layer, but
if an `acls` grant (audited above) still permits `tag:isolated` to reach port 22 on some host, that
network path is open regardless — non-Tailscale-SSH services listening on 22, or a non-Tailscale
SSH daemon, would still be reachable.

Assert both — network reachability and SSH authorization — as machine-checked policy tests, using
Tailscale's [ACL test syntax](https://tailscale.com/kb/1337/acl-syntax#tests) (`tests`/`sshTests`).
The policy file itself is managed and validated either through the admin console's "Preview"
action before saving, or through GitOps using the
[Tailscale API](https://tailscale.com/kb/1101/api) /
[Manage tailnet policies](https://tailscale.com/kb/1276/tailnet-policy-file) (a CI pipeline that
fetches, validates, and applies the policy via the API). There is no standalone `tailscale acl
test` CLI subcommand — if you want this in CI, run the tests through the API instead.

```jsonc
{
  // ... tagOwners / acls / ssh as above ...
  "tests": [
    {
      "src": "tag:isolated",
      // Port 22 on an unrelated host must NOT be reachable — proves no leftover
      // broad grant is still matching src=tag:isolated.
      "deny": ["<some-other-tailnet-host>:22"],
      // The two explicit directions above must still work.
      "accept": ["<hub-tailscale-ip>:<hub-webhook-port>"],
    },
  ],
  "sshTests": [
    {
      "src": "tag:isolated",
      "dst": ["<some-other-tailnet-host>"],
      // accept/check/deny are each arrays of *remote usernames being attempted* (not booleans).
      // Since tag:isolated is never granted SSH, list the representative login name(s) actually
      // used in your operation (e.g. "root" or the operator's SSH username) under deny, asserting
      // "cannot log in as that user."
      "deny": ["<remote-user>"],
    },
  ],
}
```

A `tests`/`sshTests` failure blocks the ACL from saving in the admin console — treat this as the
actual proof that "isolated server cannot reach anything but the hub," not the absence of a rule
you wrote yourself.

### Firewall variant (required as a persistent host firewall regardless of Tailscale)

Because the tailnet ACL only governs tailnet-overlay traffic (previous subsection), blocking
lateral movement over the public internet, the local LAN, or IPv6 requires a **persistent**
dual-stack (IPv4 + IPv6) host firewall on the isolated server itself. Apply this at all times, as a
complement to the tailnet ACL, whether or not Tailscale is in use.

**The principle (this is the part that matters)**: keep the isolated server's outbound traffic to
the bare minimum, and block everything that could reach another node directly — especially SSH
tcp/22 — along with any unrelated egress. "Bare minimum" means exactly these two things:

1. **Reaching the hub's webhook** (the path hook scripts use to POST `agent-done`/
   `agent-activity`, etc.)
2. **`tailscaled`'s own underlay connection** (the traffic that makes the tailnet overlay itself
   work: outbound TCP 443 to the coordination server / DERP relays, the UDP used for DERP/STUN,
   and DNS to a configured resolver. Blocking this cuts the isolated server off from the tailnet
   entirely, which also destroys the hub's inbound control path)

Inbound should allow only the hub reaching this server's `agentPort`.

**Do not break the netfilter chains Tailscale manages**: on Linux, `tailscaled` creates its own
netfilter chains (`ts-input`, `ts-forward`, etc.) and inserts jump rules at the top of the
`INPUT`/`FORWARD` chains to manage traffic for the `tailscale0` interface. Replacing the entire
filter table's `INPUT`/`OUTPUT`/`FORWARD` chains in one shot via a `-restore`-style command wipes
out those `tailscaled`-owned chains and jump rules along with everything else. Do not use that
wholesale-replace approach as the basis for a persistent rule set. Safer directions:

- Check `iptables -S`/`nft list ruleset` before applying anything, leave whatever chains and jump
  rules `tailscaled` has inserted intact, and **append** the isolation-specific restrictions on
  top (never a full replace).
- Ideally, run `tailscaled` under a dedicated service UID/cgroup and scope the egress restriction
  to the task process (the UID/cgroup the agent/worker runs under) instead. That way
  `tailscaled`'s underlay traffic and the task's egress are never conflated, and you never have to
  touch `tailscaled`'s own rules — though this requires a configuration change and is out of scope
  for this document.

**What follows is reference material laying out the requirements — validation in your own
environment is required.** The authoritative source for what ports/protocols `tailscaled`'s
underlay actually needs is Tailscale's official
[Firewall ports](https://tailscale.com/kb/1082/firewall-ports) page. These can vary by version and
network configuration (DERP-relayed vs. direct connection, etc.), so defer to the official
documentation for exact port numbers.

**Requirements table**:

| Direction | Destination | Protocol/Port | Allow? | Notes |
|---|---|---|---|---|
| INPUT | this host (loopback) | any | allow | loopback is always allowed |
| OUTPUT | this host (loopback) | any | allow | same |
| INPUT/OUTPUT | - | established/related | allow | needed in both directions for replies |
| INPUT | hub's tailscale IP | TCP `<agent-port>` | allow | path the hub uses to dial in for exec/terminal/doctor probes |
| OUTPUT | hub's tailscale IP | TCP `<hub-webhook-port>` | allow | path hook scripts use to POST agent-done/agent-activity |
| OUTPUT | coordination server / DERP | TCP 443 | allow | `tailscaled`'s underlay — see the official requirements |
| OUTPUT | DERP/STUN | UDP (ports per official requirements) | allow | `tailscaled` direct-connection establishment / DERP relay |
| OUTPUT | one configured DNS resolver (usually `100.100.100.100`) | UDP/TCP 53 | allow (only if name resolution is needed) | see next subsection; never a wildcard allow to any DNS server |
| INPUT/OUTPUT | everything else (including SSH tcp/22 to other nodes) | any | deny | this is the actual lateral-movement defense |

**Notes**:
- The table above lays out direction/destination/protocol; the concrete IPs/ports depend on your
  environment (Tailscale's DERP map, region configuration, etc.). Before applying anything, verify
  the addresses/ports actually in use from `tailscaled`'s own logs or the official documentation.
- If you build your own rule set, implement it in a way that doesn't destroy the chains
  `tailscaled` inserted (append, as described above).
- No single "paste this and you're done" firewall script is provided here. Whatever
  implementation you use — dual-stack (IPv4/IPv6), `nft` or `iptables` — build rules that satisfy
  the requirements table above and validate them in your own environment before going to
  production.

### Name resolution under this firewall (MagicDNS / `AZITO_PUBLIC_URL`)

The requirements table above is built around direct reachability to fixed destinations, so DNS
needs an explicit decision. If the hub-facing configuration (in particular a MagicDNS name, which
is what `AZITO_PUBLIC_URL` normally holds) is a hostname, the isolated server has no way left to
resolve it once its existing DNS cache entry expires: the hook scripts (`agent-done`/
`agent-activity`/etc.) silently stop reaching the hub, and the outage never shows up as a firewall
deny in the logs — it looks like a name that simply stopped resolving.

Two ways to close this gap; pick one before relying on this requirements table in production:

- **Pin a numeric IP (recommended)**: resolve the hub's Tailscale IP once and configure the
  isolated server's webhook target with that literal address instead of the MagicDNS hostname. No
  DNS lookup is ever needed, so you can drop the DNS row from the requirements table entirely. If
  the hook scripts speak HTTPS to the hub, confirm their TLS verification is configured to accept
  the certificate for that IP (a certificate issued for the MagicDNS name may not validate against
  the bare IP depending on your TLS setup) — or use the tailnet's plain-HTTP path if your
  deployment already treats the tailnet itself as the trust boundary.
- **Allow DNS to one explicit resolver**: if you must keep resolving a hostname, follow the DNS row
  in the requirements table and allow DNS (UDP **and** TCP, port 53) to your resolver's numeric IP
  only — never a wildcard allow to "any" DNS server, which would reopen a broad egress path.
  Tailscale's own resolver (`100.100.100.100`) is the usual choice for a MagicDNS name.

Whichever option you pick, verify it under the firewall (not just before applying it) — from the
isolated server itself:

```bash
tailscale status                      # confirms the tailnet connection is alive (detects a blocked underlay)
getent hosts <hub-hostname-or-ip>     # confirms resolution still works (or isn't needed)
curl -v <hub-webhook-url>             # confirms the hook path actually reaches the hub
```

### Making it persistent (surviving reboot)

Rules built at runtime alone are wiped on reboot, silently removing lateral-movement protection.
You **must** persist them through your distribution's standard mechanism — `nftables.service` for
an `nft` implementation, or `iptables-persistent` for an `iptables`/`ip6tables` implementation
(Debian/Ubuntu) — so they're always in effect. As above, this assumes the rule set being persisted
was built by appending to, not replacing, whatever chains/jump rules `tailscaled` inserted.

**Verifying after reboot is required.** Reboot and confirm both that the rules are actually in
effect and that `tailscaled`'s underlay connection hasn't broken.

```bash
sudo reboot
# after reboot:
sudo nft list ruleset                 # or: sudo iptables -L -n -v / sudo ip6tables -L -n -v
tailscale status                      # confirms the tailnet connection is alive (underlay not blocked)
curl -v <hub-webhook-url>             # confirms reachability to the hub (agentPort connectivity)
```

### Planned future work

- Machine-verification of the ACL (adding a `tailnet_acl` check to the isolation doctor): **#85**
- Turning the above into an application feature (settings UI / automatic application): **#86**

Both are manual operational procedures today. The isolation doctor's nine checks (section 3) do
not include verification of either the tailnet ACL or the host firewall.

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
