# Security Configuration & Environment Setup Guide

## Scope of this document

After the security hardening work (Phases 0–3), AZITO automatically manages security settings. The UI token (`AZITO_UI_TOKEN`) is auto-generated when not set. Manual configuration is only required for MinIO credentials if you use file storage. This guide covers two paths:

- **[Migrating an existing environment](#migrating-an-existing-environment)** — bring a running AZITO installation up to date
- **[Setting up a new development environment](#setting-up-a-new-development-environment)** — start from a clean checkout

For installation from release bundles, see [Installation and Updates](install-and-update.md).

## Summary of changes

| Change | Impact | Action required |
|---|---|---|
| API / WebSocket now require authentication | Unauthenticated requests get 401; WS gets `close(1008)` | `AZITO_UI_TOKEN` is auto-generated. Use `azito token show` to view it, enter on first browser access. Set it in env to use a fixed token |
| Bind address defaults to `127.0.0.1` | Not reachable from LAN / Tailscale | Set `AZITO_BIND` if needed |
| CORS restricted to an allowlist | Browser access from unlisted origins fails | Set `AZITO_ALLOWED_ORIGINS` if needed |
| MinIO credentials are mandatory | `docker compose up` fails | Set credentials in the root `.env` |
| harness token delivery changed | `/azt-*` skill API calls return 401 | Re-run `setup.sh` on every server |
| DB secret columns are encrypted | `data/master.key` is generated automatically | Back up the key file |
| SSH host key TOFU verification | SSH connections are refused when the host key changes | Reset the fingerprint if the change was intended |
| agent token delivery changed | Existing agents keep working in the old form | Reinstall to migrate (optional) |
| Branch name / path boundary validation | Values containing special characters are rejected with 400 | Fix the offending task values |

## Environment variable reference

There are **two** env files with different roles. They are easy to confuse.

| File | Read by | Purpose |
|---|---|---|
| `packages/server/.env` | AZITO server (`tsx watch --env-file-if-exists=.env` / systemd `EnvironmentFile`) | Server behavior |
| `<repo root>/.env` | `docker compose` (its default env file) | MinIO credentials |

Both are git-ignored. Templates live in `.env.example`.

### `packages/server/.env`

| Variable | Required | Default | Description |
|---|---|---|---|
| `AZITO_UI_TOKEN` | No | auto-generates `$AZITO_DATA_DIR/ui-token` | Token for API / WebSocket auth. Resolution order: env -> file -> auto-generate. Use `azito token show` to view, `azito token rotate` to rotate |
| `AZITO_DATA_DIR` | No | repo root (`data.db`, `data/*`) | Persistent data directory. When set, `data.db`, `master.key`, `vapid-keys.json`, `ui-token`, `browser-profile/`, `sidekicks/` are consolidated under this directory (mode 700). Required for versioned directory deployments |
| `AZITO_BIND` | No | `127.0.0.1` | Listen address. `0.0.0.0` and `::` are explicitly rejected. Use a Tailscale IP for remote access |
| `AZITO_ALLOWED_ORIGINS` | No | `http://localhost:5173,http://localhost:3001` | Comma-separated origins allowed by CORS and the WebSocket Origin check |
| `AZITO_WEBHOOK_TOKEN` | No | random per start | Shared token for hooks / agent-signal / supervisor. Set it to keep it stable |
| `AZITO_MASTER_KEY` | No | auto-generates `$AZITO_DATA_DIR/master.key` | Encryption key for DB secret columns (64 hex chars). Takes precedence over the file |
| `AZITO_SIDEKICKS_DIR` | No | `$AZITO_DATA_DIR/sidekicks` | User-layer Sidekick package directory. Defaults to `sidekicks/` under `AZITO_DATA_DIR` |
| `AZITO_VAPID_SUBJECT` | No | none | VAPID subject for push notifications |
| `PORT` | No | `3001` | Server port |

### Root `.env`

| Variable | Required | Description |
|---|---|---|
| `MINIO_ROOT_USER` | **Yes** when using MinIO | `docker compose up` fails if unset |
| `MINIO_ROOT_PASSWORD` | **Yes** when using MinIO | Same. Use a sufficiently long value |

---

## Migrating an existing environment

Budget 15–30 minutes. Run the steps in order.

### Step 0. Back up

```bash
cd <azito>
cp data.db "data.db.bak-$(date +%Y%m%d-%H%M%S)"
cp packages/server/.env packages/server/.env.bak 2>/dev/null || true
```

### Step 1. Pull the code

```bash
git fetch origin
git checkout master && git pull --ff-only origin master
npm ci
```

Use `npm ci` so you land exactly on the updated `package-lock.json` (it contains the `@fastify/static` vulnerability fix).

### Step 2. Configure the server

> `AZITO_UI_TOKEN` is auto-generated on first start if not set (view with `azito token show`). Only follow the steps below if you want a fixed token.

```bash
openssl rand -hex 32   # copy the output
```

Append to `packages/server/.env`:

```bash
AZITO_UI_TOKEN=<the 64 characters generated above>

# Only when accessing over Tailscale (find the IP with `tailscale ip -4`)
AZITO_BIND=100.x.y.z
AZITO_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001,http://<tailscale-host>:3001
```

Tighten the permissions:

```bash
chmod 600 packages/server/.env
```

> Without `AZITO_BIND`, the server listens on `127.0.0.1` only, so it is reachable only from a browser on the same machine. Set it if you use AZITO remotely.

### Step 3. Set MinIO credentials and recreate the container

MinIO previously ran with the defaults (`minioadmin` / `minioadmin`) exposed on all network interfaces, so **rotating the credentials is strongly recommended**.

```bash
openssl rand -hex 24   # for the user name
openssl rand -hex 32   # for the password
```

Set them in the repository root `.env`:

```bash
MINIO_ROOT_USER=<generated value>
MINIO_ROOT_PASSWORD=<generated value>
```

```bash
chmod 600 .env
docker compose down
docker compose up -d
```

Ports are now bound to `127.0.0.1:9000` / `127.0.0.1:9001`. To reach the MinIO console remotely, use an SSH port forward or Tailscale.

Afterwards, re-enter the new credentials under Settings → Storage in AZITO.

### Step 4. Encrypt existing secrets

`data/master.key` is generated on first server start. Existing plaintext values are read transparently, but you should seal them in one pass.

```bash
npm run dev   # start once so data/master.key is created, then Ctrl+C
npx tsx scripts/seal-existing-secrets.ts
```

Example output:

```
Sealing existing secrets...
  llm_providers.api_key: 2
  servers.agent_token: 2
  project_repositories.token: 0
  project_secrets.value: 5
  storage_settings.access_key/secret_key: 1
Done.
```

**Back up `data/master.key`.** If you lose it, the encrypted secrets (LLM API keys, agent tokens, project secrets, repository tokens, MinIO credentials) become unrecoverable.

```bash
cp data/master.key ~/secure-backup/azito-master.key   # somewhere safe
```

### Step 5. Verify file permissions

The server enforces `600` at startup, but confirm:

```bash
stat -c '%a %n' data.db data.db-wal data/vapid-keys.json data/master.key 2>/dev/null
# all should be 600
```

### Step 6. Start and enter the token

```bash
npm run dev
```

Open `http://localhost:5173` (or `http://<tailscale-host>:3001`) and you will get a token prompt. Enter the `AZITO_UI_TOKEN` from Step 2.

> The token is stored in `sessionStorage`, so it lives **for the browser session only** (until you close the tab). A new session requires re-entry.

### Step 7. Re-run harness setup (every server)

The harness token delivery path changed. Skip this and `/azt-*` skill API calls will return 401.

```bash
# local
./harness/setup.sh \
  --azito-url http://localhost:3001 \
  --webhook-token "$AZITO_WEBHOOK_TOKEN" \
  --ui-token "$AZITO_UI_TOKEN" \
  --server-name local
```

> **Pass all three options.** `~/.azito/azitoctl.env` (mode 600) is only written when both `--azito-url` and `--webhook-token` are given; `--ui-token` is appended to that file. `--ui-token` alone writes nothing.

On remote servers, run the same command there (`--azito-url` points at the hub, `--server-name` is the server's name in AZITO):

```bash
ssh <remote-host>
cd <azito>   # wherever the harness lives
./harness/setup.sh --azito-url http://<hub>:3001 --webhook-token <token> --ui-token <token> --server-name "The Mirano"
```

### Step 8. Reinstall agent servers (recommended, optional)

The agent token moved from a plaintext systemd unit entry to a mode-600 `EnvironmentFile`. Existing agents keep working in the old form, so this is not urgent, but migration is recommended.

Use Servers → target server → Setup → Agent Server → "Reinstall". Reinstalling also issues a fresh agent token.

### Step 9. Verify

```bash
# authentication is enforced
curl -s -o /dev/null -w 'no-auth: %{http_code}\n' http://127.0.0.1:3001/api/servers
# → 401

curl -s -o /dev/null -w 'with-auth: %{http_code}\n' \
  -H "Authorization: Bearer $AZITO_UI_TOKEN" http://127.0.0.1:3001/api/servers
# → 200

# CORS is not a wildcard
curl -s -D - -o /dev/null -H 'Origin: https://evil.example' http://127.0.0.1:3001/api/servers | grep -i access-control-allow-origin
# → no output (or only an allowed origin)
```

Then check the UI:

- [ ] The workspace renders after entering the token
- [ ] A terminal tab connects (verifies WebSocket auth)
- [ ] One task runs at least through planning (verifies harness token delivery)
- [ ] Files open in the file explorer
- [ ] Agent completion notifications arrive (verifies the webhook token)

---

## Setting up a new development environment

### Prerequisites

| Software | Version | Purpose |
|---|---|---|
| Node.js | v24+ | Backend and frontend runtime |
| tmux | 3.4+ | Terminal session management |
| Docker | latest recommended | MinIO (file storage, optional) |
| Tailscale | latest recommended | HTTPS / push notifications / SSH (optional) |
| OpenSSL | any | Token generation |

To use coding agents you also need the `claude` and/or `codex` commands.

### 1. Clone and install

```bash
git clone <repository-url> azito
cd azito
npm ci
```

### 2. Create the server env file

> `AZITO_UI_TOKEN` is auto-generated on first start if not set (view with `azito token show`). Only set it here if you want a fixed token.

```bash
cat > packages/server/.env <<EOF
AZITO_UI_TOKEN=$(openssl rand -hex 32)
AZITO_WEBHOOK_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 packages/server/.env
cat packages/server/.env   # note the tokens — needed for the browser and harness
```

`AZITO_WEBHOOK_TOKEN` is optional (randomly generated per start), but pinning it is easier to operate since the harness must share the same value.

### 3. MinIO (optional)

```bash
cat > .env <<EOF
MINIO_ROOT_USER=$(openssl rand -hex 24)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 32)
EOF
chmod 600 .env
docker compose up -d
```

Skip this if you do not need file storage — AZITO runs fine without MinIO.

### 4. Start

```bash
npm run dev
```

- Backend: `http://127.0.0.1:3001`
- Frontend (Vite): `http://localhost:5173`

Open `http://localhost:5173` and enter `AZITO_UI_TOKEN`.

### 5. Install the harness

```bash
source packages/server/.env
./harness/setup.sh \
  --azito-url http://localhost:3001 \
  --webhook-token "$AZITO_WEBHOOK_TOKEN" \
  --ui-token "$AZITO_UI_TOKEN" \
  --server-name local
```

### 6. Initial setup

1. **Servers** — a `local` server is registered by default
2. **Create a project** — set its working directory under Projects
3. **Configure a Unit** — define the workflow and runtime
4. **Check dependencies** — Servers → target server → Setup shows tmux / Node.js / harness status

See the [user guide](./README.md) and the [azt-harness guide](./harness.md) for details.

---

## Accessing over Tailscale

**The required settings depend on your setup.** Check which one you have first:

```bash
tailscale serve status
```

### Setup A: HTTPS terminated by `tailscale serve` (recommended — output shows a proxy line)

```
https://<host>.ts.net (tailnet only)
|-- / proxy http://localhost:5173
```

Here every hop **terminates on localhost**: browser → Tailscale (HTTPS) → `localhost:5173` (Vite) → `localhost:3001` (AZITO). So **`AZITO_BIND` must stay at its `127.0.0.1` default — do not change it** (changing it breaks Vite's proxy target `localhost:3001`).

All you need is the allowed origin. In `packages/server/.env`:

```bash
AZITO_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001,https://<host>.ts.net
AZITO_PUBLIC_URL=https://<host>.ts.net
```

`AZITO_PUBLIC_URL` is the URL that supervisors and remote agents use to reach the hub. When omitted, the Tailscale IP (`http://100.x.x.x:3001`) is used, but with a `127.0.0.1` bind that address is unreachable and **supervised monitoring will not work**. Always set this to the MagicDNS HTTPS URL in a `tailscale serve` setup.

The browser sends the Tailscale HTTPS domain as `Origin`; without this entry the API is rejected by CORS and WebSockets close with `1008 Forbidden origin`.

Vite needs no change — `.ts.net` is allowed by default in `allowedHosts`. For any other domain, add it via `AZITO_ALLOWED_HOSTS`:

```bash
AZITO_ALLOWED_HOSTS=my-host.example.com npm run dev
```

### Setup B: connecting straight to the Tailscale IP (no `tailscale serve`)

Make AZITO listen on the Tailscale IP. In `packages/server/.env`:

```bash
AZITO_BIND=100.101.102.103          # output of `tailscale ip -4`
AZITO_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001,http://<host>.ts.net:3001
```

AZITO no longer listens on `localhost:3001`, so **the Vite dev server's proxy (which targets `localhost:3001`) stops working**. Use the production daemon instead — it serves the built frontend from the same origin on `:3001`.

```bash
npm run build && systemctl --user restart azito
```

### Verifying the setup

```bash
# Is the Tailscale origin allowed?
curl -s -D - -o /dev/null -H "Origin: https://<host>.ts.net" \
  http://127.0.0.1:3001/api/health | grep -i access-control-allow-origin
# → access-control-allow-origin: https://<host>.ts.net

# Is an unlisted origin rejected? (no output means correct)
curl -s -D - -o /dev/null -H "Origin: https://evil.example" \
  http://127.0.0.1:3001/api/health | grep -i access-control-allow-origin
```

After editing `.env`, `tsx watch` re-reads it on the next source reload — `touch packages/server/src/main.ts` applies it (for the daemon, `systemctl --user restart azito`).

---

## Production (daemon) operation

```bash
./deploy/daemon-install.sh          # build + register systemd user unit + start
systemctl --user status azito
journalctl --user -u azito -f
```

`deploy/azito.service` reads `EnvironmentFile=-<root>/packages/server/.env`, so `AZITO_UI_TOKEN` and `AZITO_BIND` placed in `packages/server/.env` reach the daemon as well.

After code changes:

```bash
npm run build && systemctl --user restart azito
```

The dev server and the daemon share port `:3001`, so stop the daemon before `npm run dev`:

```bash
systemctl --user stop azito
# when you are done
systemctl --user start azito
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Don't know the UI token | Need to find the auto-generated token | Run `azito token show`. On TTY startup the token is printed once when generated |
| Exits with `AZITO_BIND must not be 0.0.0.0 or ::` | Binding to all interfaces is explicitly refused | Use `127.0.0.1` or a Tailscale IP |
| Cannot reach the server (connection refused) | Listening on `127.0.0.1` only | Set `AZITO_BIND` to the Tailscale IP and restart |
| UI loops on API 401 | Entered token does not match the server value | Check `packages/server/.env`, close the browser session and re-enter |
| Terminal tab disconnects immediately (`1008 Unauthorized`) | The WebSocket carries no token | Reload the browser; close stale tabs |
| Terminal disconnects with `1008 Forbidden origin` | The requesting origin is not allowlisted | Add it to `AZITO_ALLOWED_ORIGINS` and restart |
| Vite replies `Blocked request. This host is not allowed` | Host missing from `allowedHosts` | Add the hostname to `vite.config.ts`, or use `:3001` |
| `/azt-*` skills return 401 | harness token not distributed | Re-run `setup.sh` with all three of `--azito-url`, `--webhook-token`, `--ui-token` |
| `docker compose up` fails with `MINIO_ROOT_USER is required` | Root `.env` not set | Set the credentials in the root `.env` |
| MinIO console unreachable remotely | Ports are now bound to `127.0.0.1` | Use an SSH port forward (`ssh -L 9001:127.0.0.1:9001 <host>`) |
| Task execution fails with `Unsafe branchName` / `Invalid base_branch` | Branch name or path contains disallowed characters | Use only alphanumerics and `_ . / -` (paths may also use `@ : ~`) |
| File preview returns `Not a regular file` | A non-regular file (device, FIFO, …) was opened | Pick a regular file; this rejection is intentional |
| Saving a custom LLM provider returns 400 | `base_url` is not HTTPS, or points at private / loopback / Tailscale CGNAT (100.64.0.0/10) | Use a public HTTPS endpoint. For a tailnet endpoint you must relax `shared/validation/urlValidation.ts` |
| Provider update returns `api_key must be re-entered when base_url changes` | Guard against key exfiltration when the endpoint changes | Re-enter the API key and save |
| SSH fails with `Host key mismatch` | Stored fingerprint differs (host rebuilt, or a man-in-the-middle) | If intended, use Servers → target server → Danger Zone → "Reset SSH fingerprint" |
| An agent server returns 401 on every API | agent token mismatch | Servers → Setup → Agent Server → "Reinstall" |
| Opening a supervised pane always waits 10 seconds | `AZITO_PUBLIC_URL` not set; the auto-detected Tailscale IP is unreachable because bind is `127.0.0.1` | Add `AZITO_PUBLIC_URL=https://<MagicDNS>` to `.env` → restart the service → respawn supervised windows (existing shell panes keep the old `AZITO_URL`; check with `GET /api/supervisors` — `[]` confirms this issue) |

## Recovery / rollback

### If `data/master.key` is lost

Encrypted secrets cannot be decrypted. Re-enter the following manually:

1. LLM API keys under Settings → Providers
2. MinIO credentials under Settings → Storage
3. Every project's Secrets
4. Every repository token
5. Reinstall agent servers (reissues their tokens)

Before doing that, check whether an old `master.key` survives elsewhere (backups, or next to `data.db.bak-*`).

### Reverting to the previous version

```bash
systemctl --user stop azito        # if running as a daemon
git checkout <pre-change commit>
npm ci
cp data.db.bak-<timestamp> data.db  # the backup from Step 0
```

The added DB column (`servers.ssh_host_fingerprint`) is harmless to old code, so you can also run without restoring the DB. However, encrypted secret columns will not be decrypted by the old code, so restoring `data.db` from the backup is the reliable path.
