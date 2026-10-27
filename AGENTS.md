# AZITO - Agent Development Workspace

## Project Overview
AZITO is a browser-based tmux session manager that enables autonomous agent development through "Sidekick Mode". It manages multiple coding agents (Claude Code, Codex) across local, SSH, and agent servers, driving them through a UnitType-defined phase loop.

## Quick Start

```bash
# From the repository root:
# UI token is auto-generated on first start (saved to data/ui-token).
# To set a fixed token: echo "AZITO_UI_TOKEN=$(openssl rand -hex 32)" >> packages/server/.env && chmod 600 packages/server/.env
# Start backend (Fastify, :3001) + frontend (Vite, :5173) together, with hot reload
npm run dev
# Runs dev:server (PORT=3001 tsx watch packages/server/src/main.ts) + dev:web (vite) in parallel.
# tsx watch auto-reloads the server on file changes — usually no manual restart is needed.
# NOTE: tsx watch does NOT type-check (esbuild transpile only); run `tsc --noEmit` to catch type errors.
# Do NOT also launch a standalone `npx tsx src/main.ts` — it competes for :3001 (EADDRINUSE).

# Access at http://localhost:5173 (dev) or via Tailscale
```

`packages/server/.env` (git-ignored) is auto-loaded via `tsx watch --env-file-if-exists=.env`.

| Variable | Required | Notes |
|---|---|---|
| `AZITO_UI_TOKEN` | no | API/WS auth token. Resolution: env -> `$AZITO_DATA_DIR/ui-token` -> auto-generate. Use `azito token show/rotate` to manage |
| `AZITO_DATA_DIR` | no | Persistent data directory. Consolidates `data.db`, `master.key`, `vapid-keys.json`, `ui-token`, `webhook-token`, `browser-profile/`, `sidekicks/` under one path (mode 700). Default: repo root (`data.db` + `data/`) |
| `AZITO_BIND` | no | Listen address, default `127.0.0.1`. `0.0.0.0`/`::` are rejected — use a Tailscale IP for remote access |
| `AZITO_PUBLIC_URL` | no | URL that supervisors / remote agents use to reach the hub. Required when using `tailscale serve` (set to `https://<MagicDNS>`). Auto-detected from Tailscale IP if unset, but unreachable when bind is `127.0.0.1` |
| `AZITO_ALLOWED_ORIGINS` | no | CORS + WS Origin allowlist, default `http://localhost:5173,http://localhost:3001` |
| `AZITO_WEBHOOK_TOKEN` | no | hook/agent-signal/supervisor shared token. Resolution: env -> `$AZITO_DATA_DIR/webhook-token` -> auto-generate |
| `AZITO_MASTER_KEY` | no | DB secret-column encryption key; falls back to auto-generated `$AZITO_DATA_DIR/master.key` (back it up) |
| `AZITO_BROWSER_UA` | no | CDP ブラウザの User-Agent 文字列を上書き。未設定時は Chrome 130 相当の既定値 |

MinIO credentials (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) live in the **repo-root** `.env` — that is
`docker compose`'s env file, not the server's. Both are required when running `docker compose up`.

After changing `AZITO_UI_TOKEN` (or running `azito token rotate`), re-run `harness/setup.sh --azito-url <url> --webhook-token <t> --ui-token <t>
--server-name <name>` on every server, or `/azt-*` skills get 401. `azito token rotate` auto-updates
the local `~/.azito/operator.env` and `~/.claude/settings.json` MCP token (if present) — it does
**not** touch `~/.azito/azitoctl*.env`, which never carries `AZITO_UI_TOKEN` (Issue #28 Phase B:
operator/task credential separation — `azito auth doctor` checks local drift). Full procedures
(migration, new environment, Tailscale, troubleshooting): `docs/ja/security-setup.md` /
`docs/en/security-setup.md`.

### Production (Daemon)

```bash
./deploy/daemon-install.sh              # Build + install systemd user unit + start
# Access at http://localhost:3001 or http://<tailscale-host>:3001

systemctl --user status azito           # Status
systemctl --user restart azito          # Restart
systemctl --user stop azito             # Stop
journalctl --user -u azito -f           # Logs

# Rebuild after code changes:
npm run build && systemctl --user restart azito

# Dev coexistence: daemon uses :3001, so stop it before `npm run dev`:
#   systemctl --user stop azito
# After dev, restart with:
#   systemctl --user start azito

./deploy/daemon-uninstall.sh            # Uninstall
```

### Release Build (distribution)

The published artifact is a self-contained tarball: an esbuild bundle + a downloaded Node binary,
so an end user needs neither npm nor a checkout.

```bash
# Build one platform's tarball into packages/server/dist-hub/
npx -w packages/server tsx scripts/build-hub.ts --version v0.3.0 --platform linux --arch x64
```

- `scripts/build-hub.ts` stages `azito-hub.cjs`, `azito-supervisor.cjs`, the Node binary, `public/`,
  `harness/`, `deploy/` templates and the native `node_modules`, then validates the stage
  (`assertStageContents`) before tarring. Native modules are `external` in the bundle and copied in.
- `scripts/run-hub.sh` becomes `run.sh` in the bundle. It resolves the host PATH (nvm/nodenv/Homebrew)
  and a UTF-8 locale, because systemd/launchd hand the service a minimal environment.
- A Windows bundle (`--platform win32`, built on a Windows host) is a zip with `node.exe` and `run.ps1` (from `scripts/run-hub.ps1`) instead of
  `node` / `run.sh`. `install.ps1` (repository root, a release asset listed in `SHA256SUMS`; not inside the bundle) installs it for the current user on
  Windows PowerShell 5.1 into `<prefix>\hub\<version>\`, records the version in `<prefix>\hub\current.txt` (no `current` symlink on Windows), has the
  bundled hub create `hub\.env` and `data\` through `azito-hub.cjs init-env` (so the owner-only ACL comes from `SecretFileGuard`), and writes
  `<prefix>\bin\azito.cmd` (reads `current.txt`; `start` / `stop` / `status` forward to `azito-hub.cjs service ...`; `run` runs `run.ps1` in the foreground). CI runs the whole
  path on real `powershell.exe` in "Hub bundle (Windows)" (`scripts/smoke-install-win32.ts` with `-NoService`, and `scripts/smoke-service-win32.ts` for the task).
- **The Windows hub as a Task Scheduler task** (#380 B3a): `createServiceManager` (`modules/system/createServiceManager.ts`) returns `createWindowsServiceManager` on win32 (the hub's own misao stays `unsupported_os`
  through `createMisaoServiceManager` until B3b). Unless `install.ps1 -NoService`, install.ps1 runs `azito-hub.cjs service install`, which registers task `AzitoHub` from XML generated by
  `modules/system/windowsHubService.ts` (`buildHubTaskXml`; logon trigger, least privilege, restart on failure; `userId` = `%USERDOMAIN%\%USERNAME%` resolved in `serviceCommand`), then writes `current.txt`, then starts
  it with `/Run` and waits for `/api/health`. The task runs `conhost.exe --headless powershell.exe -EncodedCommand <launcher>`; the launcher reads `hub\current.txt` at each start and runs that version's
  `run.ps1 -Service -LogFile <prefix>\logs\hub.log`, so the definition names no version (an update only switches the pointer and restarts, see "In-app update on Windows"). `run.ps1 -Service` runs the hub under `cmd.exe` (`>> hub.log 2>&1`; at start a log over 10 MB is moved
  to `hub.log.1`) and sets `AZITO_HUB_EXIT_WITH_PID` to its parent `conhost.exe`: the hub (`app/hubExitWithParent.ts`, reusing `agent/parentWatch`) shuts down when that process is gone, because the Task Scheduler's End
  ends only the conhost. `azito service stop|restart|reload` (`modules/system/windowsHubOperations.ts`, driven by `cli/serviceCommand.ts`) first checks that the registered task belongs to this prefix (read back from the task's launcher, `registeredHubPrefix`) and exists, finds the hub `node.exe` of any version under `<prefix>\hub\` (`findHubProcesses`: same user, whole-argument match, given and real path, never itself) BEFORE `/End` and again AFTER it (the launcher may have started a hub in between; both sets are waited for before `/Run`), waits `HUB_GRACE_MS` for them to shut down by themselves, and `endHubProcesses` ends only the same id+creation-time that is left. `service install` registers again when only the definition copy is left, and replaces another prefix's stopped task only with `--yes`.
  `DeployModeDetector` has a `taskscheduler` mode (the hub was started with `AZITO_HUB_EXIT_WITH_PID`, so no schtasks call per request): `canUpdate()` is true there, except on an architecture with no release (win32-arm64, with the reason).
- **Coming back from a crash on Windows** (#380): `conhost.exe --headless` reports exit code 0 whatever its child did and RestartOnFailure does not fire for a non-zero exit code either
  (`shared/os/taskScheduler/restartOnFailure.windows.test.ts`), so nothing outside the hub restarts it. **AzitoHub**: the fixed launcher (`buildHubLauncherScript`, `HUB_RESTART_TIMING`) is a loop: it reads
  `current.txt` and runs `run.ps1 -Service` at every start, and when `run.ps1` ends with a **non-zero** code it waits 5 s (doubling up to 60 s; a run of 5 minutes starts over from 5 s) and starts again; an exit code 0
  (graceful shutdown: SIGTERM, or the followed `conhost.exe` being gone) is not started again. `/End` (`azito stop|restart|reload`) ends the `conhost.exe` and the launcher with it, and a launcher that outlives its
  `conhost.exe` notices (same process id and start time) and ends, so there is no "stopped by the hub" state. A bad pointer is logged and retried every 60 s. Every restart goes to `hub.log` (`launcher: ...`) and
  `<prefix>\logs\hub-launcher.json` (`hubLauncherState.ts`, shown by `azito status` as `launcher:`). The whole script travels in the task command line, so `hubTaskExec` refuses one over 8191 characters (the paths are
  written once, `$hubRoot`). The launcher changed, so a task of the first 0.12 builds (`buildSingleRunLauncherScript`, recognised as `singleRun`) is still this install's (operable) and is replaced by
  `azito service install` (not while running). **AzitoMisao** (the hub's own): `LocalMisaoWatchdog` (`modules/system/misao/`) is `AgentRecoveryWatchdog`'s sibling for this machine, same waits (`shared/recoveryBackoff.ts`:
  15 s look, 1 min first, doubling to 15 min, a "running" task without a daemon is ended from the 2nd attempt) calling `MisaoServiceService.reviveWindowsDaemon` = `MisaoWindowsInstaller.reviveDaemon` on the local target,
  inside the same one-at-a-time slot as install / update / the CLI (`MisaoServiceService.exclusive`: the in-process flag plus, on Windows, the cross-process slot `misaoRootLock.ts` / `shared/processLock.ts` — a named pipe `\\.\pipe\azito-lock-<hash of the root + the secret `<root>\.lock-key`>` that the holder listens on (the key — `misaoLockKey.ts`, made once atomically via SecretFileGuard + hard link, checked owner-only on every use, no fallback — keeps another user from naming and pre-creating it; EADDRINUSE = busy, the OS frees it when the holder dies, never waited for; a connection to the holder lives 2 s from connect at most and all are destroyed on release; a held pipe is looked at — `misaoPipeHolder.ts`: Windows's `GetNamedPipeServerProcessId` + `GetOwnerSid`, never the holder's own word — this user's process = `busy` (+ pid), another user's or unidentifiable = `lock_foreign` (a possible pre-emption: the name is visible while held; detected, not prevented), which the watchdogs treat as `foreign_lock:<reason>` = not an attempt, warned once per reason); `MisaoAgentInstaller` takes the same slot for a Windows agent whose reported misao root equals the hub's own (`localMisao`, by name), otherwise only the per-server mutex; Unix is not locked; `busy` = not an attempt), and only for the misao AZITO installed here (`MISAO_SOCKET` managed, `taskStartsMisaoOf`); started in `main.ts` with the agent watchdog. Nothing
  restarts either while the hub is down (the launcher brings the hub back, then the hub brings misao back). CI: `scripts/smoke-recovery-win32.ts`.
- Releases are cut by tagging `v*`; `.github/workflows/release.yml` builds linux-x64/arm64,
  darwin-arm64 and win32-x64 and publishes them with `SHA256SUMS` and `install.sh`. Tags containing a hyphen
  (`v0.3.0-rc1`) are published as pre-releases.
- **win32-x64** (#380 B1): `--platform win32 --arch x64` produces `azito-hub-<ver>-win32-x64.zip` and must run on a Windows host
  (better-sqlite3 / node-pty come from that host's `node_modules`, never cross-built). `node.exe` is the official zip checked
  against `SHASUMS256.txt` (`scripts/nodeAssets.ts`, not `download-node.sh`: a Windows runner has no guaranteed curl / unzip);
  archives are read and written with the OS's `System32\tar.exe` (`scripts/archive.ts` `hostTar()`, because the GNU tar that ships
  with Git for Windows can't read a zip). `assertStageContents(platform)` requires `node.exe`, `better_sqlite3.node` and node-pty's
  `conpty*.node` / `conpty/` files instead of `run.sh` / `node` / `spawn-helper`. The launcher `run.ps1`, `install.ps1` and the CLI
  are B2; the zip is booted in CI (`ci.yml` "Hub bundle (Windows)" and the release build) by `scripts/smoke-hub-win32.ts`, which
  runs `node.exe azito-hub.cjs` directly and waits for `/api/health`.
- Installed layout: `~/.azito/hub/<version>/` with a `current` symlink, `~/.azito/hub/.env`
  (config, outside the versioned dir) and `~/.azito/data/` (DB, keys, token).
- In-app update: Settings → System. Works under systemd, launchd and the Windows Task Scheduler; not for a source checkout, and
  not for pre-releases (GitHub's `releases/latest` returns stable releases only).
- **In-app update on Windows** (#381 U2): `SystemUpdateService.launchUpdateScript` registers the one-shot task `AzitoHubUpdate` (`windowsHubUpdateTask.ts`: no trigger, `conhost.exe --headless powershell.exe -EncodedCommand`,
  a script that runs the CURRENT version's `node.exe azito-hub.cjs update-run ...`, the Task Scheduler's 1 h limit is only a backstop: it ends the task's `conhost.exe`, not the `node.exe`; `update-run` itself follows that `conhost.exe` (`AZITO_HUB_EXIT_WITH_PID`, set by the script, the hub's own mechanism) and gives up after 50 min: a stop is looked at before and after each step (a working step is waited for, never cut), then the run records a failed run and, if it had switched, puts the old version back; a stop that arrives during the last step (the health check) leaves a completed update a success with a `note` in the state; downloads time out after 10 min) and `/Run`s it, because a process the hub spawns would die with the hub's own task when the update
  ends `AzitoHub` (measured on a real Task Scheduler: a task started by a process inside another task survives that task's `/End`, and can delete its own task while running). A task cannot carry an environment variable, so the
  bind address and port go as `--health-url` and `AZITO_GITHUB_TOKEN` in `<data>/update-token` (owner-only; `update-run` reads and deletes it first, it is never on a command line). A leftover `AzitoHubUpdate` is replaced (after its previous `update-run` process is found and ended, and a leftover `update-token` removed) only when its
  script is recognised as AZITO's (`inspectHubUpdateTask`); an unknown one, or another install's running one, stops the update with the reason. `update-run` (`updateScript.ts`) is the same download → verify → extract → smoke-test
  → switch → restart → health-check → rollback sequence as Unix, with an `UpdateBackend` per OS (`unixUpdateBackend.ts`, `windowsUpdateBackend.ts`): the zip is unpacked by `extractZipSafely` into `hub\<tag>` (an existing
  folder is used only if it holds everything the zip holds, never written into), the smoke test runs the NEW `node.exe --version`, `switch` is `writeHubPointer` (`current.txt`), and `restart` is `runOnWindows('restart')`, the very
  sequence of `azito service restart` (this process is never one of the hub processes it ends). Failure after the switch puts the old pointer back, restarts and waits for the old version's `/api/health`; the folder this run made
  is removed (an existing one never). misao is a separate task and is not touched. `update-run`, and `azito service install|start|stop|restart|reload`, take the hub's `ProcessLock` (`hubLock.ts`, a named pipe named from
  `<prefix>\hub` and `hub\.lock-key`) so that they never run at the same time; a taken lock is a refusal with the reason. `update-run` deletes its own task when it ends. `AZITO_UPDATE_API_BASE` (an `http://` loopback
  address only; the hub does not start with anything else) points the release API at a local server and exists for the CI smoke test (`scripts/smoke-update-win32.ts`).
- **Old versions on Windows** (#381 U3): after a successful update (the new version answered `/api/health`; never after a rollback) `update-run` tidies `<prefix>\hub\` through the optional `UpdateBackend.pruneOldVersions` that only `windowsUpdateBackend.ts` has, so the Unix hub keeps its old versions as it always did (`windowsHubPrune.ts`, `windowsHubFolderOps.ts`). Kept: the version now in `current.txt`, the one it named before the update (the way back), every version a running process uses (`findHubVersionsInUse`: the executable or command line of any process is under `<hubRoot>\<version>\`), and everything whose name is not a release tag (`.staging-*`, `.env`, `current.txt`, `v1.0.0.bak.old`), which is not looked at. Removed: a real folder directly under `hub\` named like a release tag (`isReleaseTag`). **Preconditions, each of which stops the whole tidying with the reason in `update.log` and the state's `note`** (the update stays a success): `hub\` can be changed only by this user, SYSTEM and Administrators (`assertHubDirOnlyOwnerWritable`, its ACL read with `Get-Acl`: nobody else can swap a folder for a link while it works; those three can do anything to this user's files anyway); and every process whose use of a version cannot be ruled out is accounted for when it is this user's (its executable and command line are read from WMI, the image path again with the least right, `QueryFullProcessImageName`; one of this user's whose image is still unknown, or an interpreter such as node.exe / powershell.exe / cmd.exe with no readable command line, stops the tidying with its name — on a desktop that is usually the user's own window running as administrator (an elevated PowerShell), whose path a non-elevated hub cannot read, and the note says so: closing it lets the next update tidy up (the hub never closes it); the kernel's own pseudo-processes have no image file and are skipped). By owner (`GetOwnerSid` against this user's SID): a process whose owner is read and is another account's is not held to that: the hub lives under the user's profile, which no other standard user can read (only SYSTEM and Administrators), and a non-administrator cannot read the path of smss / csrss / svchost / MsMpEng, so stopping for them would stop every run (found on a real Windows 11). Its use of a version is still caught, because a running exe / loaded DLL is a mapped image that `whyAFileIsHeld` (below) cannot open for writing whoever maps it, and an open handle makes the isolating rename fail; either way the version is kept whole. A path or command line that does name a version counts for any account. A process whose owner cannot be read (maybe this user's own elevated process) stops the tidying when it is a known interpreter with no readable command line (it may have read a version's script and load another module from it later, with nothing mapped or open); any other such process is skipped. Before a folder is renamed, every writable file in it is opened for writing (`whyAFileIsHeld`): a mapped image or DLL of a running program stays mapped after its handle is closed and cannot be deleted, so a folder with one is left whole and reported, instead of being removed in part. A `.prune-*` is picked up again only if it is `.prune-<release tag>-<8 hex>` (`isIsolatedName`). **Links are not entered**: a junction or symlink under `hub\` named like a version is left as it is and logged (it is somebody's arrangement). A version folder is renamed to `.prune-<tag>-<random>` inside `hub\` and removed with `cmd.exe /d /c rd /s /q` (System32, absolute path): `rd` removes a reparse point inside the tree (junction, symlink, volume mount point) as the link only, which Node's own removal cannot be trusted to do (`lstat` shows a volume mount point as the folder it points at). A window between the real-path check and the rename remains in principle (Node has no `openat2`); the ACL precondition is what closes it. A folder that cannot be renamed or removed (a file held open, EBUSY / EPERM / EACCES, `rd` failing) is kept, written to `update.log` and to `note`, and a half-removed `.prune-*` is removed by the next update (every update looks at all folders). If the processes cannot be listed nothing is removed. CI: `windowsHubPrune.windows.test.ts` (real junctions, a volume mount point made from a VHD when the runner allows it, a really held file, the real process list and ACL) and `scripts/smoke-update-win32.ts` (step 6b: a, b, c).
- Windows one-liner: `irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex` (Windows PowerShell 5.1). `install.ps1` is one script block called at the end of the file, so it runs as text
  (iex / `& ([scriptblock]::Create((irm <url>))) -Port 3010 -Yes`) as well as `-File`: never `exit` (a failure is a terminating error), nothing left in the caller's session, options also from `AZITO_INSTALL_<OPTION>`
  variables. `release.yml` replaces the one `__AZITO_RELEASE_TAG__` placeholder with the tag, so the downloaded installer installs its own release (a checkout asks the GitHub API for "latest"). `-Port` goes to
  `init-env --port` (PORT + AZITO_ALLOWED_ORIGINS); git is checked first and, if missing, the winget / git-scm.com guidance is printed. CI: `scripts/smoke-oneliner-win32.ts`.
- The tarball also carries the misao **native binary** (Rust, no Node / node-pty needed) for every target
  (`misao/<target>/{misao,LICENSE,NOTICE,THIRD-PARTY-LICENSES.txt}` for `x86_64`/`aarch64-unknown-linux-musl` and
  `aarch64`/`x86_64-apple-darwin`, plus `x86_64-pc-windows-msvc`, plus `misao/manifest.json` with each file's sha256) (every hub tarball has all five targets, four Unix ones and `x86_64-pc-windows-msvc`: the hub installs its own from them, since hubs run on linux x64 / arm64 and
  darwin arm64, and the same bundle serves an agent host of another OS / architecture; `AgentInstaller`'s preflight currently accepts
  x86_64 agents only, so arm64 agent support is out of scope here). The archives are pinned release assets: version, URL and sha256 are constants in
  `scripts/misaoAssets.ts`, verified at build time (offline builds set `AZITO_MISAO_ASSET_DIR`). The install target is chosen from the
  host's OS / architecture (`misaoTargetFor` in `MisaoBundle.ts`; the hub uses its own, an agent reports its own); a host without a
  binary is an `unsupported_host` error, never a fallback. The Windows build is a zip asset (extracted with `unzip`, which the
  build host must have; its absence is an explicit error; a Windows build host reads it with `hostTar()` of `scripts/archive.ts`) whose executable is `misao.exe`, keyed `misao` in the manifest
  (`misaoFileName` in `MisaoBundle.ts`, `misaoReleaseFileName` in the build script). It is installed on Windows **agents** (below); for the hub's own
  service on a Windows hub, `status` reports `unsupported_platform` and `install` / `update` fail with `not_managed` (the Windows hub, #380). Also `deploy/azito-misao.service` / `com.azito.misao.plist`
  (`ExecStart=<prefix>/misao/current/misao serve ...`, no `__NODE__`). misao is **a separate service**
  (`azito-misao` / `com.azito.misao`) unpacked to `~/.azito/misao/<version>/` with `misao/current` switched only by an explicit
  `azito misao update` (or the Setup row's update button): stopping the daemon closes every pane, so a hub update or restart never
  touches it. `azito misao install|update|start|status` (`cli/misaoCommand.ts`) and `GET/POST /api/system/misao[/install|start|update]`
  share `modules/system/misao/MisaoServiceService`; `install.sh` just calls the bundled CLI. tmux is optional on a release install.
  The same bundled misao is installed on **agent servers** by `modules/system/misao/MisaoAgentInstaller` (the binary that fits the agent's OS /
  architecture and its licenses are sent through the agent and sha256-checked on both ends, never downloaded by the agent; the unit template is
  rendered by the shared `misaoUnit.ts`; macOS agents run it as a background process; `install()` never switches or stops a running daemon, except that with
  nothing running `current` is pointed at the new release, since the unit needs the binary layout; the previous link and unit are put back if that fails).
  `update()` is the explicit switch of a running one (`POST /api/servers/:name/update-misao`, operator only even in compat mode, and the Setup row's
  "Update misao" button after a confirmation): save the previous link + unit, stop (systemd unit, `misao stop`, SIGTERM to the process naming the managed
  socket), switch, start, and on any failure restore both and start the previous release. For the hub's own service, an update from a Node-era 0.2.0 install
  (`azito misao update`) keeps the old version directory, and a failed update restores the previous unit file as it was (not a re-rendered one; launchd
  jobs are booted out before a definition changes, since a loaded job keeps its old one). `AgentInstaller.install` runs the install after the agent is healthy, and
  `POST /api/servers/:name/install-misao` (`system/misao/agentMisaoRoutes.ts`, operator only even in compat mode; `GET` = progress for both) runs it on demand.
  `AgentUpdater` never touches the daemon.
  On a **Windows hub** (#380 B3b) `MisaoServiceService` hands install / update to the agent's `MisaoWindowsInstaller` aimed at the local machine
  (`misao/misaoLocalWindows.ts`: in-process commands, `LocalFileOps`, pipe probe and `stageMisaoReleaseFile`), so there is one misao per user:
  `<prefix>\misao\<version>\misao.exe`, the `current` file, the task `AzitoMisao` and the pipe of that folder, shared with a Windows agent on the same
  machine (a task that starts a misao from another folder is refused without `--replace-socket`). `resolveMisaoPaths(prefix, windowsUser)` takes the
  Windows branch (drive path; spaces, parentheses, `&`, `%`, `!` allowed: such a path reaches the task through a PowerShell launcher script with the paths in environment variables, `conhost.exe` re-reads a command line with them wrongly; `"` and line breaks refused). The pipe name is made from the folder's real spelling: the host that owns the folder resolves it once at its entry point with `shared/os/realPath.ts` `resolveRealPath` (nearest existing ancestor via `realpath.native` + the missing part unchanged; the hub for its prefix, the agent for its home, reported as `misaoRoot`), and `windowsMisaoPipe`, the task XML and the ownership check (`taskStartsMisaoOf`, which reads the task's `--data` / `AZITO_MISAO_ROOT` folder) only take strings. update / start refuse a task of another folder like install; the pipe is written to `hub\.env` as
  `MISAO_SOCKET` after the daemon answers, and `run.ps1` loads it. `install.ps1` runs `azito misao install --prefix` after the hub's task (skipped with
  `-NoService`; a failure is a warning). `hasMisaoToRelyOn` takes `windowsTaskDefined` (the Task Scheduler is asked in `main.ts`). No unit template is
  rendered for Windows. Panes on the hub's own Windows misao start a worker as a program (#371).
  **Windows agents** (#369 A3; `MisaoAgentInstaller` hands a `hostProfile.platform === 'win32'` target to `MisaoWindowsInstaller`, the Unix path is unchanged): the same upload route
  (the agent stores `misao` as `misao.exe`) puts the release in `%USERPROFILE%\.azito\misao\<version>\` (the root is made owner-only with `PROTECT_SCRIPT` first); there is no link — `<root>\current`
  is a file holding the version and the Task Scheduler task `AzitoMisao` (logon trigger, `misaoWindowsTask.ts`: `conhost.exe --headless cmd.exe /d /c ""<exe>" serve --socket "<pipe>" --data "<root>" >> "<log>" 2>&1"`,
  `TaskDefinitionInput.argumentsLine`) names the release's `misao.exe` directly. Everything on the host runs through the agent's `/api/run` (PowerShell `-EncodedCommand` via `powershellEncodedArgs`, `SchtasksClient`
  over `createScriptCommandSpecRunner`) and its file API. The endpoint is the named pipe `windowsMisaoPipe(root, user)` (= the SDK's default for `MISAO_DIR=<root>`); the agent decides it once at startup
  (`resolveAgentMisaoSocket(env, home, windows)`, `MISAO_SOCKET` may name another pipe) and reports `host.windows` (`systemRoot`, `userName`, `misaoRoot`) in `GET /api/misao/status`, whose `socketPresent` is a
  pipe connect probe. `install()` still never stops a running daemon; `update()` = `misao.exe stop` (through the pipe) -> End the task + sweep (`shared/os/windowsProcessSweep.ts`, the process sweep the agent install shares) if it stays up
  -> switch -> start, restoring the previous `current` + task XML on failure. Trials: hub env `AZITO_WIN_MISAO_TASK_NAME` / `AZITO_WIN_MISAO_DIR` (in `WindowsAgentOptions`; the folder reaches the agent as `AZITO_MISAO_DIR` in its settings file when not the
  default). A Windows agent's panes are `%ComSpec%` opened bare (`PaneShell.commandArgs === null`; a worker is started as the window's program, #371). Tests: `MisaoAgentInstaller.windows.test.ts` (fake agent host, Linux-safe) and
  `MisaoWindowsInstaller.misaoIntegration.test.ts` (real `misao.exe` + real agent on Windows CI, job "misao integration tests (Windows)").

## Architecture

```
packages/
  server/                          # Fastify + TypeScript (feature-first)
    src/
      main.ts                      # Composition root: wires repositories/services, registers routes, starts Fastify
      agent/                       # Lightweight agent entry point (deployed to remote servers)
        main.ts, routes.ts         # Agent process HTTP/WS surface
        misaoRelay.ts, misaoRoutes.ts  # `/ws?mode=misao` byte relay to the agent's own misao socket (fixed at startup, 128 at once) + `GET /api/misao/status` / `PUT /api/misao/upload` (the release files, staged under `~/.azito/misao/<version>.upload/`; on Windows the pipe replaces the socket) — all behind the agent token
      modules/                     # Feature modules (1 module = 1 responsibility; routes+service+repository together)
        tmux/                      # [base] TmuxClient, PaneOutputStream/PaneStream(Factory), TmuxHookManager
          routes/, ws/             # HTTP routes (sessions, hooks) + WS handlers (terminal, agent-terminal)
          misao/                   # MisaoMuxClient (IMuxClient over the misao daemon), MisaoConnection, MisaoTerminalStream (browser terminal attach, one dedicated daemon connection per terminal), MisaoPaneStateEvents (the daemon's `pane.state` activity events, consumed by `operations/misaoActivityBridge.ts`), MisaoPaneStream (task output read from the daemon's line stream instead of pipe-pane; a gap is only logged as `pane_stream_gap` — completion/questions are detected from the signal file) — the driver is always registered (no feature flag; an absent daemon is `daemon_unreachable`); `MisaoServers` holds one node (connection + driver) per daemon — the hub's own for every local server, one per agent server that has misao (created lazily, dropped when the server is edited/deleted; the SDK reaches it through `MisaoClient({ connect })` over the agent relay) — and `MisaoDriverRouter` is the registered driver that routes each call by server; an agent server lists misao only once it has a node (`MuxDriverRegistry` `hosted`), otherwise `not_installed`
        servers/                  # [base] Server entity, SqliteServerRepository, install status parsing
          transport/               # ServerTransport interface + Local/Ssh/Agent implementations, AgentPaneStream/EventStream
          ssh/                     # SshClient (persistent shell pool, marker-based exec)
          auth/                    # Token-based auth for agent connections
          agent-deploy/            # AgentBundler, AgentInstaller, AgentUpdater, HarnessInstaller
        agents/                   # [mid] Worker (Claude/Codex/Generic), SessionStrategy(Factory), IAgentProvider registry, LaunchCommand
        git/                      # [mid] IWorktreeService, Local/RemoteWorktreeService(Factory), GitDiffService, DiffParser,
                                  #       PathContainment (assertPathContained/assertDirectoryContained) — worktree listing API
                                  #       (GET .../git/worktrees) and diff scope (uncommitted/base/commit) also live here
          providers/               # GitProviderService (GitHub/GitLab provider abstraction)
        llm/                      # [mid] LlmClient, Provider, CodexExecClient, PaneClassifier, LlmContentExtractor
        prompt/                   # [mid] PhasePrompt, PhasePromptRenderer, PromptModuleLoader, RenderSkillPromptUseCase
        sidekicks/                # [mid] SidekickPackage (Claude Skill型パッケージ: SKILL.md+scripts/+references/),
                                  #       SidekickPackageLoader (builtin/user 2層マージ), SidekickPackageService, renderSidekickBody
        tasks/                    # [upper] Task, TaskStatus, ExecutionLog, SqliteTaskRepository
          execution/               # ExecuteTaskUseCase, WorkerWaiter, PromptExpander, GitInfoCollector, PushVerifier
          recovery/                # RecoverStuckTasksUseCase (startup stuck-task recovery)
          ws/                      # taskLogHandler
        windows/                  # [upper] Window, SqliteWindowRepository, WindowRespawnService
        units/                    # [upper] Unit (behavior + runtime, merged Operation+WorkerProfile), SqliteUnitRepository
        operations/               # [upper] running-execution-runs API only (GET /api/operations); no operations table
        projects/                 # [upper] Project, ProjectServer, SqliteProjectRepository/SqliteProjectServerRepository
        files/                    # [upper] FileBrowseService (browse/read/write/create/delete/rename), FileSearchService
                                  #       (rg-preferred, grep fallback), SqliteStorageSettingsRepository
          storage/, ws/            # MinioStorageClient + file-tail WS handler
        usage/                    # [upper] UsageService, Claude/CodexUsageCollector (token usage aggregation)
        notifications/            # [upper] NotificationBus, webhooks (agent-done), push subscriptions
          push/, ws/               # PushNotificationService, VapidKeyManager + notificationHandler
        browser/                  # [upper] CDP browser (shared server-side browser, tab snapshots, agent ops)
        supervisors/              # [base] SupervisorRegistry/Launch/Path — tui-supervisor process management
        system/                   # [upper] SystemUpdateService, DeployModeDetector, UpdateChannelResolver,
                                  #         updateScript (out-of-process self-update),
                                  #         serviceManager (ServiceManager over systemd / launchd for the hub and misao; launchd always uses user/<uid> with a Background-limited plist, moving older gui/<uid> installs)
        health/                   # [upper] GET /api/health (hub-wide flags: scopedAuthEnabled)
      shared/
        fs/                       # IFileOps, LocalFileOps (Node fs on the host), fileOpsWire (agent /api/fileops request/response)
        db/                       # Database.ts (SQLite/WAL) + migrations/ (001-079)
  frontend/                        # React 19 + Vite + TypeScript
    src/
      components/                  # Layout, Terminal, Modal, FileExplorer, TaskLogView, etc.
        ui/                        # TabBar, TabGroup, IconButton, etc.
        workspace/                 # GlobalSettingsPanel, GlobalTasksPanel, ServersSidebar, etc.
      pages/                       # Workspace (unified), Tasks, Units, etc.
      hooks/                       # useTabPersistence, useTabGroups, useTmuxTouchScroll, useLongPress, useApi, useWebSocket
```

### Module Structure Rules
- 1機能 = 1モジュール（`modules/<name>/` 配下に routes・service・repository を同居させる）。
- 依存方向: `shared` → `tmux`/`servers`（基盤層） → `agents`/`git`/`llm`/`prompt`/`sidekicks`（中間層） → 上位モジュール
  （`tasks`/`windows`/`units`/`operations`/`projects`/`files`/`usage`/`notifications`） → `main.ts`。
  循環依存は禁止（`npm run depcruise` で検証。ルールと現状の例外は `.dependency-cruiser.cjs` を参照）。
- インターフェース（`I〜`）は実装が2つ以上ある場合のみ定義する（例: `IWorktreeService` は Local/Remote の2実装）。
- `routes.ts` は薄く保つ。リクエスト/レスポンスの変換とサービス呼び出しに徹し、ビジネスロジックは service/use case 側に置く。

## Key Technical Decisions

### Server Transport Abstraction
- Three transport types: `local`, `ssh`, `agent`
- `ServerTransport` interface abstracts command execution, file operations, tmux management
- `LocalTransport`: direct `execFile` + local tmux
- `SshTransport`: SSH shell pool with marker-based execution
- `AgentTransport`: HTTP/WebSocket to a lightweight agent process on the remote server
- Host OS (`hostProfile`, #379 P5): every transport knows `HostProfile { platform: linux|darwin|win32, arch: x64|arm64 }` of the host it
  runs on (`shared/os/hostProfile.ts`; `ServerConfig.hostProfile`, distinct from `host` = the address). A local server's is the hub's own
  (`TransportFactory.hostProfileFor`, from its `HostEnv`, never stored). An agent's is recorded in `servers.host_platform/host_arch`
  from its own report `GET /api/host` (`agent/hostRoutes.ts`, behind the token; never in `/health`) by `AgentHostRecorder` — after
  install/update and when reached with none recorded — and from the SSH preflight's `node -p "process.platform+' '+process.arch"` on install.
  NULL = an agent registered before the OS was kept = a Unix agent (existing sh paths keep working; a 404 from `/api/host` is `agent_outdated`
  and leaves it NULL). `exec(command: string)` is `@deprecated` (POSIX-only) and throws `unsupported_os` when the host is win32. misao pane
  shells are per node (`modules/tmux/misao/paneShell.ts`): the hub's shell for its own daemon, the agent's reported shell (`$SHELL`, else its user's passwd login shell) for an agent's
  (neither is an error; an agent too old to report keeps the hub's shell); a Windows agent's node opens its reported `%ComSpec%` bare (a worker is started as the window's program, #371), and so does a Windows hub's own (`hubPaneShell`, the hub's `%ComSpec%`; #380 B4a)

- Task files (#371 T2): `GET /api/host` also reports the agent's `homeDir` / `tmpDir`. `TaskTempFiles` names a task's signal / pipe / output / rules files
  from a `TaskTempServer` (`local` = the hub's tmpDir; `agent` = the agent's OS notation via `hostPathFor` + its reported tmpDir). The hub asks once per
  transport (`TransportFactory.taskTempServer` → `AgentTransport.loadTaskTempHost`, kept in memory, nothing stored; an unrecorded agent is a Unix `/tmp`) and it
  must be awaited before an agent pane stream is created. `ManagedStreamFiles(platform, allowedDirs)` judges paths by the agent's own rules (a win32 agent has no `/tmp`).
  `WorkerWaiter.readPhaseOutputFile` / `GitInfoCollector.writeRemoteFile` use `IFileOps` (a missing output file is `null`, an unreadable one throws); `GitInfoCollector.collectGitInfo`
  and `gitConfigOps` run git as an argv through `runGit` (local and remote are one path).

### Local server on a Windows hub: misao only (#380 B4a)
- `hostFeatureSupport(profile, 'tmux')` (`@azito/shared`) is the one decision. `SqliteServerRepository(db, hubHost)` stamps the hub's own host on a local server's `hostProfile` when it reads it
  (never stored) and reads a `tmux` default as `misao` where tmux is closed (the row is untouched). `muxKinds.hostRunsTmux` / `supportedMuxKinds` follow it; `registerTmuxDriver` registers the tmux driver
  so a host without tmux does not `hosted` it and answers `unsupported_os` (new `MuxDriverUnavailableReason`); `LocalTransport.execMux` / `openTerminal` refuse a stray call. `TmuxHookManager` install / uninstall,
  the startup linked-session GC and the `install-status` tmux row are skipped for it (one info line at startup); `install-tmux` and `PUT defaultMux: tmux` answer 501 `unsupported_os`. Unix hubs: unchanged.
- Panes are the hub's `%ComSpec%`, bare. Create / rename / delete / send-keys / capture / the browser terminal / `tier0_mux` work. A worker (claude / codex / a command) is **not typed into a Windows pane** and no shell pane is replaced (#371): `WorkerLaunch` (`modules/agents/WorkerLaunch.ts`, built by `IAgentProvider.buildLaunch` / `ISessionStrategy.buildRespawnLaunch` / `buildWorkerLaunch`) is one definition with two renderings: a POSIX host gets `renderLaunchLine` typed into the shell (after the `cd` line, unchanged text); a Windows host (`workerStartsAsProgram`) gets the worker as **the first pane of the window it is created with**: `PaneProgram` (`{ argv, cwd, cols, rows }`, built by `agents/workerProgram.ts`) goes to `openWorkspace` / `openWindow` (`opts.program`) and `MisaoMuxClient.createWindowWithPane` hands it to `pane.open` (misao resolves `claude` -> `claude.cmd` with the child's PATH / PATHEXT and names the profile after it); the pane env is the call's `extraEnv`. Add Window (and the quick add) on a Windows host is one call: `POST /mux/workspaces[/:ws/windows]` with `launch: { command, workerType, workingDirectory }` (`SessionsRouteOptions.planNewWindowProgram`, wired in `buildServer.ts`), which answers `agentSessionId` for the window row (`POST /projects/:id/windows` takes `agent_session_id`); `launch-agent` on an existing window is `unsupported_os` on Windows. `WindowRespawnService.respawn` recreates the window, so it passes the program to that creation. Task execution (`execute` / `followUp` / restore) is built the same way (#371 T6, "Tasks on Windows" below): the worktree is made first and the window is created with the worker as its first pane. The terminal size is `tmux/terminalSize.ts` (120x40) because a Node TUI does not follow a later ConPTY resize. A command line (generic worker, the Add Window command) is split only when it is plain / `'single quoted'` words (`splitCommandLine`), else `unsupported_os`; every word of the argument list must also be free of cmd.exe's `% ^ & | < > " ! ( )` because a `.cmd` shim is run through cmd.exe (`launchArgv`; escaping on misao's side is separate work). A `~` working directory is expanded against the host's home before `pane.open`. Respawn of a window with a saved pane layout, a plain shell window with a working directory, or a generic / custom-command worker window (its command is not stored, so no launch can be rebuilt) is `unsupported_os` on Windows, refused before the window is destroyed; respawning a window a task owns works the same way (T6). The respawn destroys the old window before it creates the new one, so a program that cannot be found (PATH / PATHEXT) fails after the old window is gone, with that said in the error. The session id `planNewWindowProgram` reports is read from the split argument list and recorded only if it is a UUID. Windows CI: `scripts/smoke-misao-win32.ts`, and the `program` cases of `MisaoWindowsInstaller.misaoIntegration.test.ts`.

### SSH / agent servers from a Windows hub (#380 B4b)
- `SshClient` takes an `SshClientEnv` (`homeDir`, `platform`, `authSock`, `defaultUser`) resolved once in `wiring.ts` by `ssh/sshClientEnv.ts` (`HostEnv.homeDir` = `%USERPROFILE%`, `USERNAME` on win32, `USER`/`LOGNAME` elsewhere);
  it never reads `process.env`. Keys (`id_ed25519`, `id_rsa`, `id_ecdsa`) and `config` are under `<homeDir>\.ssh`; `IdentityFile ~/…` / `~\…` expand to that home (ssh-config returns `IdentityFile` as a list: the first is used).
  A server written without `user@` and with no `User` in the config and no OS user is an error (`No SSH user for …`), not an empty name. There is no `known_hosts` reader and no key-permission check: host keys are pinned by the hub's
  own fingerprint store (trust on first use, a changed one is refused) on every OS, and ssh2 reads the key as a buffer (a Windows ACL check would add nothing the hub acts on).
- ssh-agent (`ssh/sshAgentSocket.ts`, `resolveSshAgent`): `SSH_AUTH_SOCK` wins everywhere (socket path, `\\.\pipe\…`, or `pageant`; ssh2 1.17 takes all three). Unset on Windows → the OpenSSH agent pipe
  `\\.\pipe\openssh-ssh-agent` if it exists (the "OpenSSH Authentication Agent" service must be running; it is Disabled by default). Absent → "no agent" with a reason (`ResolvedHost.agentUnavailableReason`, logged once per reason), and the key
  files are still tried. Unset on Unix is also "no agent". `run-hub.sh` still looks for the login session's socket; `run-hub.ps1` needs nothing (the pipe name is fixed). A pipe/socket that exists but is dead makes ssh2 emit `error` (pre-existing, Unix too).
- The agent bundle always carries the **Linux x86-64** `pty.node`, whichever OS the hub runs on, together with the npm node-pty's macOS / Windows prebuilds (debug symbols dropped; one bundle serves every agent OS, so a Windows or macOS hub can also deploy to Linux, and the agent-on-Windows install still gets `prebuilds/win32-x64`). `build-agent.ts` stages node-pty's JS + prebuilds + `build/Release/pty.node` (Linux needs no `spawn-helper`) and takes the Linux binary from
  the host when that is Linux x64, otherwise from `--node-pty-linux <dir>` / `AZITO_AGENT_NODE_PTY_LINUX` (a folder with `package.json` + `build/Release/pty.node` built on Linux x64; it must be the same node-pty version as the checkout, and an ELF x86-64
  file — Mach-O / PE / arm64 are refused). Without it a Windows / macOS / arm64 host fails with the reason, never a bundle that dies at the agent's first `require('node-pty')`. `AgentBundler.ensureBuild` passes the environment on.
  The release workflow builds that node-pty once (`agent-native`) and gives it to every platform job, so all hub tarballs / the zip carry the same agent (same bundle hash).
- Archives for another host are packed in Node (`shared/fs/tarGz.ts`: ustar + PAX for long/non-ASCII names, explicit modes), never with the hub's `tar`: the agent tarball (`run.sh` and node-pty's `spawn-helper`s are 0755), the harness (`#!` files are 0755, `HarnessInstaller.transferHarness`) and the
  sidekick packages (`scripts/` is 0755, `SidekickSyncService.buildTarball`). A symlink in a tree is packed as a link entry (`lstat` + `readlink`), never followed or read: a link that points outside, dangles or loops is carried as written. The mode of an npm-package file in the agent bundle is 0644 (not the package's own) except `run.sh` and the `spawn-helper`s: everything is started through `node`. `agent-deploy/agentBundleCheck.ts` reads the tarball back (files present, `run.sh` executable and LF, `pty.node` an ELF x86-64, the macOS / Windows prebuilds present and the darwin `spawn-helper`s executable); `build-agent.ts` and
  `build-hub.ts` run it. `.gitattributes` (`* text=auto eol=lf`, repository-wide) keeps every text file LF on a Windows checkout (a CRLF `run.sh` shebang, `\r` inside shell text embedded in TS, and a different bundle hash otherwise). `bundle-hash.txt` hashes forward-slash paths, so it is the same on every OS.
- CI: `agent-native` (Linux build + `scripts/verify-agent-tarball.ts`), `agent-bundle-windows` (the bundle built on Windows from that node-pty, read back by the hub's reader and `tar.exe`), `agent-bundle-from-windows` (same bundle hash as Linux; unpacked
  with the installer's tar flags on Linux, `run.sh` executable, node-pty spawns a pty), `ssh-windows` (`scripts/smoke-ssh-win32.ts`: the runner's real sshd over loopback with a key under the hub's home, the ssh-agent pipe with no key file, a stopped agent service as "no agent",
  a changed host key refused; it restores sshd / ssh-agent / `administrators_authorized_keys`). Unit tests run the agent protocol over a real named pipe on Windows (`SshClient.agent.test.ts`).

### Shell text (ShellDialect, #379 P9)
- `shared/os/shellDialect.ts`: `ShellDialect` (POSIX sh / PowerShell 5.1) is for the two places text goes through a shell on the target — a fixed SSH bootstrap script and the line typed
  into a pane — never for ordinary commands (those are a `CommandSpec`). `shellDialectFor(hostProfile)` is the one chooser (NULL / linux / darwin → POSIX, win32 → PowerShell). `shellQuote` is the POSIX
  `quote`. Pane lines (`renderLaunchLine` / `buildWorkerLaunchCommand`, `wrapWithSupervisor`, the `cd` before a launch) take the server's dialect; a Windows worker is not a line (see Panes above)
  (`shellDialectFor(transportFactory.hostProfileFor(server))`). PowerShell `wrapScript` is the fixed `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <UTF-16LE base64>`
  (≤ 8191 characters, cmd.exe's limit); a native program with arbitrary arguments is `invoke`d through a fixed `node -e` launcher given `{ file, args }` as base64 JSON (nothing is placed on the host; `node` must be on PATH).
  A Windows agent's bare cmd.exe pane works (`paneShell.ts`); a worker is started as the window's first pane (#371).
- Tasks on Windows (#371 T6; `hostFeatureSupport` has no `taskExecution` row any more). The worker is the window's first pane, so the task's worktree must exist before the window: `ExecuteTaskUseCase.execute` runs
  `createTaskWorktree` (`tasks/execution/TaskWorktreeSetup.ts`, the same step POSIX runs after the window) inside the old-window-closed / new-window span and passes `programFor(launchPlan.launch, worktree)` to `openWindow`
  (a failed window removes the worktree again); `followUp` creates a sleeping / lost window again with the resume launch (`planResumeWorkerLaunch`) instead of waking a shell window; `TaskRestoreService.restore` makes the
  worktree first and resumes the saved session as the program. `IWorkerRuntime.launch` gets `startedAsProgram` and only waits for the TUI. POSIX order and text are unchanged. The prompt envelope takes an `EnvelopeHost`
  (`resolveEnvelopeHost`, `AzitoctlPath.ts`): POSIX keeps `cat <<EOF` / `echo >>` / the bash azitoctl; Windows gets no shell syntax, only `node "<home>/.azito/harness/bin/azitoctl.mjs" signal|output|complete|questions`
  with quoted forward-slash paths (file-writing tool for the output; questions in `<output>.questions.json`; a path with `"`, `$` or a backtick is refused). `harness/bin/azitoctl.mjs` is the Node azitoctl
  (`azitoctl.test.ts` compares it with the bash one); `pushing-default/scripts/push.mjs` is the Node push (`pushScriptNode.test.ts`); `{{sidekick.dir}}` is the host's full path (`resolveSidekickDirOnHost`).
  `ensureClaudeTrust` files the project under the backslash key Claude Code uses (`claudeProjectKey`, from 2.0.50 `cli.js`). Code distribution is closed on a Windows agent by `hostFeatureSupport(profile, 'codeDistribution')` (#464).
- The harness on Windows (#371 T5) is Node, not bash: `harness/setup.mjs` (+ `harness/lib/`) and `harness/hooks/azito-hook.mjs` (skills = directory junctions, rules = copies,
  `azitoctl*.env` in the JSON-string form, owner-only ACL). `HarnessInstaller.installOnAgent` sends the files through the agent's `IFileOps` and runs `node setup.mjs` through `run` (tokens in `env`, not argv);
  the status row and `HarnessUpdater` read through `IFileOps` for every agent. POSIX keeps `setup.sh` and the bash hooks; `hookParity.test.ts` runs both hooks against one HTTP server and compares the bodies,
  `harnessNodeParts.test.ts` fails when `harness/lib/winAclScripts.mjs` drifts from `windowsSecretFileGuard.ts`. Docs: `docs/{en,ja}/harness.md` (Windows).
- Unix-only install scripts (tmux / browser runtime / harness `setup.sh` on a Unix host / misao on an agent / hub-transfer `RemoteBundleOps` / isolation doctor / agent redeploy over SSH) stay sh; each entry point starts with
  `assertPosixHost(transport.hostProfile, label, operation)` and a win32 server gets `HostProfileError('unsupported_os')`, which `mapAppError` answers as 501 `{ error: <reason>, code }` (the UI shows `error`).
  A host with no recorded OS is a Unix one. Their Windows versions are separate functions (#369 / #380); what stays closed on a Windows agent is the `hostFeatureSupport` table (tmux, code distribution and isolation #464, browser runtime #500), and removing an agent from a Linux / macOS host is #499.
- Windows agent docs (#372): `docs/{en,ja}/windows-agent.md` is the one page for it (prepare, add, what works, update, remove, limits, troubleshooting); `install-and-update.md` and the area docs link to it instead of repeating it.

### File operations (IFileOps, #379 P7)
- `IServerTransport.files()` returns the host's `IFileOps` (list / stat / read / write / create / remove / rename / realpath): Node `fs` on the machine that owns the files, no shell,
  the same code on every OS. `LocalFileOps` (`shared/fs/`) is the hub's own and what the agent runs for each request; an agent server gets `RemoteFileOps` over `POST /api/fileops`
  (`shared/fs/fileOpsWire.ts`: Zod-validated request, the refusal in the 200 body as a `FileOpsError`). An agent registered before its OS was recorded (`hostProfile` NULL) has no such endpoint and gets
  `ShellFileOps` (the old sh commands); `AgentTransport.files()` chooses once, and a failing route is never retried through the other.
- Paths of another host are plain strings handled with `pathApiFor(platform)`; `invalidHostPathReason` refuses a Windows device path, a drive-relative path and an alternate data stream before the host is touched.
- Containment (`modules/git/PathContainment.ts`) resolves both sides on the host with `fs.realpath.native` and compares with `isHostPathContained` (the host's `relative()`, plus exact case on win32);
  `assertNewPathContained` resolves the nearest existing ancestor for a path that does not exist yet. A race with an ancestor swapped after the check remains (Node has no `openat2(RESOLVE_BENEATH)`).
- File content search is open on Windows (#370 R5a; it has no host feature, so nothing closes it): `FileSearchService` picks `rg`, else `grep` (Unix only), else `IFileOps.searchContent`
  (Node, `engine: 'builtin'`) on the Windows hub's local server and, through `RemoteFileOps` -> `/api/fileops`, on a Windows agent; hit paths are root-relative with `/` and the frontend turns them back into host paths.
  Git is open on Windows (#370 R5b; no host feature, no `assertGitSupported`): `runCommandSpec` resolves a bare `git` on a Windows host by itself (`shared/exec/windowsGit.ts` `GitLocator`, on the host that runs the spec: the hub for a local server, the agent for `POST /api/run`): PATH with the PATHEXT extensions, then `%ProgramFiles%` / `%ProgramFiles(x86)%\Git\cmd\git.exe` and `%LOCALAPPDATA%\Programs\Git\cmd\git.exe` (only `cmd\git.exe`; the PATH of a Task Scheduler agent is minimal and a winget install is not in a running process's PATH). A found path is kept (re-checked per call), a miss for 30 s. No Git for Windows: `GitNotFoundError` (`GIT_NOT_FOUND` over the agent wire), which `mapAppError` answers as 501 `{ error: <reason with `winget install --id Git.Git -e` and the searched places>, code: 'git_not_found' }`; the git routes that catch errors (`git/routes.ts`, `servers/routes.ts` branches / discover-repositories, `projects/routes.ts` discover-repositories) rethrow it. The UI shows that reason as the error of each git screen (`isGitNotFoundAnswer`). A restored file tab whose first `/servers` fetch fails shows the reason with a retry (`ServerStatusProvider.serversError`) instead of loading forever.
- New code that touches files on a server uses `transport.files()`, not `transport.exec(<sh string>)` (`execStringRatchet.test.ts` counts what is left).

### Resource guard (#531)
- `modules/servers/resources/ResourceGuard`: `measure()` returns `{ measurement, unavailable }` (5 s cache, shared in-flight). Where the values come from is decided by the host's OS (`hostProfileFor`):
  linux / darwin / an agent with no recorded OS keep the sh `MEASURE_COMMAND` (darwin's "available" is the reclaimable set, not `os.freemem()`); a **win32** host (the hub itself, or an agent) is measured with
  Node (`shared/os/hostResources.ts`: `os.totalmem/freemem`, `fs.statfs` of the `%SystemRoot%` drive). An agent serves it at `GET /api/host/resources` (`agent/hostResourcesRoutes.ts`, behind the token, not in `/health`);
  an older agent's 404 is `agent_outdated`. Windows has no loadavg, so `loadPerCore` is `null` there and only the load judgement is skipped (the memory one still runs; thresholds are unchanged).
- A server that cannot be measured has `measurement: null` and `unavailable.reason`: `agent_outdated` / `unreachable` / `timeout` / `failed`. `check()` still lets the operation through (fail-open), but
  `ResourceStatus.skipped` carries the reason: it is logged once per reason per server, appended to the task's execution log (`resource_guard_skipped`, shown by `TaskLogView`), and returned as `resourceCheck: { skipped }` by the window / session creation APIs.
  The UI shows it as the grey `unknown` health level ("not measurable (reason)"), never as red; `getWorstHealth` orders critical > warning > unknown > healthy.

### Agent Server Type
- Lightweight Node.js agent deployed to remote servers via SSH bootstrap
- Auto-install: bundles server code, copies via SSH, runs via nohup
- Auto-update: checks version hash, redeploys if changed
- Token-based authentication between hub and agent
- Uses HTTP REST for commands + WebSocket for terminal/file streaming
- DB migrations: 021 (agent server columns), 022 (agent bootstrap status)
- Windows agent (#369 A2): `AgentInstaller.install` branches on the preflight's OS to `WindowsAgentDeployer` (SFTP + PowerShell
  EncodedCommand over SSH; the Unix sh bootstrap is untouched). The bundle is unpacked by `tar.exe` into `%USERPROFILE%\.azito\agent\<version>\`
  (owner-only folder, no symlink: the task names the version folder), the settings go to an owner-only `agent.env`, and the service is a
  Task Scheduler logon task (`AzitoAgent`, Q2's `buildTaskXml` + `SchtasksClient` run on the host through `windowsSshRunner`) that starts
  `conhost.exe --headless node.exe --env-file=<agent.env> <entry>` (no console window; Windows 10 1809+): the agent runs only while that user is
  logged on. A reinstall is transactional (`WindowsDeployment.commit/rollback`: the previous task XML, `agent.env`, same-version folder and
  running state are kept aside until the new agent answers). `windowsFirewall.ts` checks (and, when the
  SSH session is elevated, adds) the inbound rule first. `AZITO_WIN_AGENT_TASK_NAME` / `AZITO_WIN_AGENT_DIR` / `AZITO_WIN_AGENT_PORT`
  (`windowsAgentConfig.ts`, resolved in `app/wiring.ts`) move the task, folder and port for a trial. The agent skips tmux hooks on win32, relays misao over its named pipe (A3, above) and writes `AZITO_AGENT_LOG_FILE`. Agent update (#372) runs the install's transaction (`windowsAgentUpdate.ts`: deploy, start, health, commit / rollback) with the agent's current token, holds the per-server lock so `AgentRecoveryWatchdog` cannot restart the agent mid-update, and keeps only the current and previous release folders (`WindowsAgentDeployer.pruneOldVersions`; a folder in use stays and is retried at the next update). Agent removal (#372): `POST /api/servers/:name/agent/uninstall` (`agent-deploy/agentUninstallRoutes.ts`, operator only, Windows agents only — 501 `unsupported_os` for the rest, #499; never deletes the row) runs `WindowsAgentDeployer.uninstall` (`windowsAgentUninstall.ts`) under the host and server locks: the task (only one that has a single Exec action equal to what the install writes, `agentTaskAction`, with the host's own node.exe), `~\.azito\agent`, and with `removeMisao` the misao task (`misaoTaskArgumentsOf`, shared) and folder (left in place, with the reason, when it is a hub's — the `AzitoHub` task's folder, or a hub process running without that task — or no task started it). AZITO stops no process itself (the task is ended; a process still running from the folder keeps the folder and is reported by pid and path; for misao, whose daemon outlives its task (ending the task does not end it, measured on Windows CI), the daemon is asked to stop through its own pipe (`misao.exe stop` of the recognised task's release) only when Windows says the process serving the task's pipe is a `misao.exe` of the user's own whose program lies under the folder (`misaoHolderScript` / `decideMisaoStop`); in any other case nothing is stopped and the step fails with the way to stop it by hand. "Uses the folder" = the process's program or command line contains the folder in any spelling — `/` or `\`, any case, long or 8.3 form, or its part below the home — and a process of the user's own whose program or command line the host did not give also stops the deletion; other users' processes are out of reach) and removes no firewall rule (it lists the rule with its Name and the command; the UI keeps the steps of a successful removal and, after the row is deleted, shows what was left in place — the rule and its command, a misao that is a hub's — in a dialog with a Close button and copyable commands). Each step answers `done` / `absent` / `failed` / `skipped`; links are never followed. The UI (`DeleteServerPanel`) removes the host first and deletes the row only on success.

### Subagent Delegation
- Worker delegation can route by worker type; per-task overrides are stored via `024_subagent_config`
- The `IAgentProvider` registry (`modules/agents/registry.ts`) is the single source of truth for agent/model definitions (codex shown as gpt-5-codex)
- `PromptModuleLoader` injects rule files (`harness/prompt-modules/rules/*`: common/typescript/php/ai-antipattern) and design/review/UI principles into subagent prompts; `025_inject_prompt_modules` controls injection
- `023_worker_extra_args` stores extra CLI args; worker launch command is derived from workerType + model + extra args

### Sidekick Package (Issue #263 Phase 4)
- **Sidekick** (new meaning, name freed up in Phase 3) = a Claude Skill-style skill package: a directory with a required
  `SKILL.md` (flat `key: value` frontmatter, no YAML lib — self-parsed) + optional `scripts/` + `references/`
- Two-layer resolution: builtin (`harness/sidekicks/`) + user (`data/sidekicks/`, overridable via `AZITO_SIDEKICKS_DIR`,
  resolved once at startup). Same name → user layer wins; `SidekickPackageLoader.list()` tags each entry with
  `layer`/`overridesBuiltin`. mtime-based caching (directory mtime for add/remove, per-`SKILL.md` mtime for edits)
- `renderSidekickBody()` expands `{{task.*}}`/`{{project.*}}`/`{{module.*}}`/`{{sidekick.dir}}`/`{{sidekick.name}}` via
  the existing `expandPromptTemplate`; script file contents are never template-expanded (values reach scripts only via
  env vars/args, to avoid injection)
- CRUD via `/api/sidekicks` (`SidekickPackageService`): POST scaffolds into the user layer; PUT copy-on-writes a
  builtin package into the user layer before editing; DELETE only removes the user-layer copy (reverts to builtin, or
  fully removes a user-only package); builtin-only DELETE is rejected
- 6 builtin packages ship in `harness/sidekicks/`: `planning-default`/`implementing-default`/`reviewing-default`/
  `testing-default`/`pushing-default` (bodies originally matched the final `phase_prompts` seed after migrations
  through 038; since Issue #263 Refine D they intentionally diverge — the seed-comparison migration's own expected
  seed constants are unchanged, but the shipped bodies no longer carry `PHASE_COMPLETE`/`QUESTIONS_JSON`/`TEST_FAILED`,
  see "Execution protocol envelope" below) and `issue-default` (no phase tag — a general-purpose package, ported from
  `harness/skills/azt-issue/SKILL.md`). `pushing-default` additionally
  ships `scripts/push.sh`: it commits and pushes the worktree's **current work branch** (never checks out; fails on
  detached HEAD), then creates a PR with `--head <work branch>`. Env vars: `AZITO_COMMIT_MESSAGE` (required),
  `AZITO_PR_BASE` (optional PR base; omitted → gh repo default), `AZITO_PR_BASE_FROM` (source branch to create a
  missing PR base from, via a remote-only ref push), `AZITO_SKIP_PR`, `AZITO_PR_TITLE`, `AZITO_PR_BODY`. The SKILL.md
  body keeps the same template variables (PushVerifier checks `git ls-remote --heads origin <work branch>` +
  `gh pr list --head <work branch>`); completion signaling is now added by the execution envelope, not the body
- `039_export_edited_phase_prompts` migration: compares each `phase_prompts.prompt` row against the known seed final
  form; unedited rows do nothing (builtin package takes over), edited rows are exported once to
  `<user-layer>/<phase>-default/SKILL.md` (never overwritten if already present). `enabled` is intentionally ignored
  when comparing — phase enable/disable is out of scope for the package format (deferred to Phase 5)
- This phase does **not** change the existing `phase_prompts`-based rendering path (`RenderSkillPromptUseCase`,
  `PhasePromptRenderer`) — that replacement is Phase 5
- Harness skills (Issue #263 Phase 7): `/azt-sidekick <name> [task_id]` executes any Sidekick package on demand via
  `GET /api/sidekicks/:name?render=1`; `/azt-summon` scaffolds a new Sidekick from the current conversation via
  `POST /api/sidekicks`. `azt-plan/implement/review/test/push` remain thin wrappers over `/api/phase-prompts`
  (server-side resolves the Unit's `phase_config` Sidekick); `azt-issue` is now a thin wrapper fetching
  `issue-default` (the implementation body lives there, not in `azt-issue/SKILL.md`). `/azt-mission
  [--parallel] <taskId|#issue>...` runs multiple tasks as one batch "mission": creates a mission integration
  branch, kicks each task via `/api/units/:id/execute`, supervises the run (plan approval, answers, failure
  recovery), reviews and merges each task PR into the mission branch, then opens one mission→base PR
  (final merge left to the user)
- **Execution protocol envelope** (Issue #263 Refine D, `modules/prompt/executionEnvelope.ts`): a `SKILL.md` body
  describes capability only, never the completion/question/test-failure signaling protocol. `stateMachineEnvelope()`
  (used by `PhaseLoopRunner` via `renderForStateMachine`) and `skillEnvelope()` (used by `RenderSkillPromptUseCase`
  via `renderForSkill`) each append that protocol on top of the rendered body, gated by
  `signalCapabilitiesForPhase(phase)`; the standalone `/api/sidekicks/:name?render=1` path applies no envelope at all

### Chat mode conversation logs (Issue #361)
- `modules/transcripts/`: `TranscriptReader` (sync; Claude/Codex JSONL parsing, runs on the machine that owns the files) is
  wrapped for the hub as the async `TranscriptSource`: `LocalTranscriptSource` (hub's own `~/.claude`/Codex dir) or
  `AgentTranscriptSource` (HTTP to the agent). `TranscriptSourceProvider.forServer(server)` picks per server
  (`local` -> hub files, `agent` -> agent API, anything else -> `null` = `unsupported_server`)
- The agent serves its own readers at `/api/transcripts/:agent/sessions[/:id/{meta,entries,tail}]` (`agent/transcriptRoutes.ts`,
  registered after the token `onRequest` hook, `agent/authHook.ts`). No endpoint takes a file path; `entries` is offset/before
  ranged. HOME / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` are the agent process's own. Changing it changes the agent bundle
  (agents update via the normal version-hash redeploy; an older agent yields `agent_outdated`)
- `WindowSessionResolver.resolve()` does session resolution (window/task link -> cwd match, process start-time gate) for agent
  servers too; `ps` goes through `transport.exec`, pane pids through the mux driver. Unresolved reasons: `unsupported_server`,
  `no_recent_session`, `agent_unreachable` (offline / breaker open), `agent_outdated`. `GET /api/transcripts/:agent/:id`
  takes `windowId` to pick the window's server (503 `agent_unreachable`, 501 `agent_outdated`). Activity probing
  (`getActivityStatus`) stays local-only. Isolated servers are not special-cased: docs/{en,ja}/isolated-execution.md section 8

### Token Usage Tracking
- `UsageService` aggregates Claude/Codex token usage from local JSONL session files (`ClaudeUsageCollector`, `CodexUsageCollector`)
- Exposed via `GET /api/usage`; rendered in the header `UsageDropdown`

### Webhooks
- `POST /api/webhooks/agent-done` receives agent completion notifications (validated request body); shared `AZITO_WEBHOOK_TOKEN` required
- `POST /api/webhooks/agent-activity` receives event-driven agent activity signals (`{serverName, sessionName, windowIndex, windowName, paneIndex, event: 'start'|'stop'}`)
  from the Claude Code `UserPromptSubmit`/`Stop` hooks (`harness/hooks/azito-activity.sh`, wired by `setup.sh --server-name`); same
  `AZITO_WEBHOOK_TOKEN`. `AgentActivityMonitor.recordHookSignal()` resolves the signal against the `windows` table and, when matched,
  flips that key's state immediately (Tier 1), bypassing the sliding-window heuristic (Tier 2) until either a crash-failsafe
  (foreground pane reverts to a bare shell without a Stop signal) or the window disappears clears the hook state
- `POST /api/webhooks/agent-interaction` receives pending-answer signals (`azito-interaction.sh` = Notification hook, no question
  text; `azito-question.sh` = PermissionRequest hook, with the AskUserQuestion `tool_input`), which drive `InteractionMonitor`
  and the chat question card. Full spec of the activity tiers, hook profile resolution (`AZITO_PREFIX`) and the question
  lifecycle: `docs/ja/activity-detection.md` (canonical) / `docs/en/activity-detection.md`

### Worker
- Runs in tmux pane via `send-keys`
- Long text (>500 bytes) sent via `tmux load-buffer` + `paste-buffer`
- Auto-approve confirmation prompts (y/n, Continue?, etc.)
- Worker types: claude (--dangerously-skip-permissions), codex (--dangerously-bypass-approvals-and-sandbox), generic
- The prompt body never goes through the pane (#532): `PromptFileDelivery` writes it to a task temp file (`azito-prompt-<taskId>-<nonce>.md`, through the host's `files()`) and
  `TuiWorkerRuntime.sendPrompt` types one shell-harmless line that names the file (`AZITO prompt file. ...: <path>`; a path with any shell-special character is refused). Before that the
  screen is read (`runtime/workerScreen.ts`): a Claude/Codex dialog (trust, bypass, Codex update prompt) or a pane back at a shell stops the task with `worker_not_ready: <reason>` and nothing is typed.
  Codex is launched with `-c check_for_update_on_startup=false`, and its worktree is trusted in `$CODEX_HOME/config.toml` (`agents/codex/ensureCodexTrust.ts`, appended section only) when the worktree is made

### Worktree Service
- `IWorktreeService` interface abstracts git worktree operations (create/exists/remove/getBranch/getDiff/getPrUrl)
- `RemoteWorktreeService`: the only implementation, for `local` servers too (`WorktreeServiceFactory.create(transport)`): git runs through `transport.run` (argv, no shell) and file operations through `transport.files()`; paths use the host OS rules (`hostPathFor`), a leading `~` / `~\` is resolved against the host home by `resolveGitPath` (`runGit` does it for `cwd` and `-C`); paths are checked with `assertGitPathArg`, branch names with `assertSafeBranch`
- `WorktreeServiceFactory`: wraps the server's transport (local/ssh/agent alike) in a `RemoteWorktreeService`
- Worktree creation fails fast: on failure, task is set to `failed` status (no fallback to original directory)
- Optional `branchName` parameter: user-specified branch checks for existing branch before creating; auto-generated branch always recreates
- `skipPr` option: when enabled, pushing phase skips PR creation (commit+push only), `verifyPushCompleted` skips PR existence check
- SSH code:0 detection: `RemoteWorktreeService` uses `hasGitError()` to detect `fatal:`/`error:` in stdout/stderr (SSH transports always return exit code 0)
- Stale worktree recovery: when `git worktree add` fails with "already used by worktree", extracts the stale path, prunes or force-removes, then retries
- Post-creation verification: `assertWorktreeSuccess()` confirms worktree directory actually exists after creation

### Task Execution (pipe-pane based)
- `tmux pipe-pane` streams pane output to a file with ANSI stripping (`sed -u`)
- `PaneOutputStream` monitors the file via `fs.watch` + polling
- Unique markers per phase: `AZITO_DONE_<taskId>_<nonce>`, `AZITO_QUESTIONS_<taskId>_<nonce>`
- `QUESTIONS_JSON` structured output for agent questions (parsed as JSON)
- `PaneClassifier` provides LLM-based fallback classification when markers are not detected
- `LlmContentExtractor` extracts plan markdown from pane output via LLM
- Design doc: `docs/task-execution-design.md`

### Terminal Handling
- **Linked sessions**: Each browser tab creates `tmux new-session -t <source> -s <unique>` to allow independent window selection across tabs
- **Resize guard**: ResizeObserver skips fit when container < 10px (prevents 0-size on hidden tabs)
- **WebSocket modes**: `terminal` (node-pty / agent proxy), `task-logs` (EventEmitter), `events` (notification stream), `file-tail` (agent-process WS, streaming file content)

### Startup Task Recovery
- `RecoverStuckTasksUseCase` が起動時に非終端タスク（planning/implementing/reviewing/testing/pushing/in_progress）を自動検出・復旧
- local サーバーのみ対象（v1）。ペイン生存確認 → done-marker 検査 → resume or advance
- `in_progress`（follow-up 中断）は execution_log から最後の phase_prompt を検索してフェーズを推定
- done-marker の signal ファイル（`/tmp/azito-pipe-<taskId>-sig-*.log`）で完了判定。完了済みは次フェーズへ前進、未完了は現フェーズ再実行
- pushing 完了済みは `review` に直接遷移（PR 重複防止）
- 同時 resume は最大3件、`app.listen` をブロックしない（fire-and-forget）

### Database
- SQLite (better-sqlite3) with WAL mode
- Migration files in `packages/server/src/shared/db/migrations/`
- DB path: `<project-root>/data.db`
- Current migrations: 001-080 (080 server host profile `host_platform`/`host_arch`, 023 worker extra args, 024 subagent config, 025 inject prompt modules, 026 task target branch, 027 pushing target branch, 028 deduplicate project windows, 029 task summary, 030 agent session id, 031 task skip pr, 032 task working directory, 033 pushing prompt skip pr template vars, 036-038 Sidekick redesign split/rename, 039-041 Sidekick package export/phase-config/tags, 042 merge Operation+WorkerProfile into Unit, 043 agent turns, 044 agent watches, 045 server mux runtime, 046 remove orchestrator mode, 047 task current phase, 048 unit type column, 049 worker runtime, 050 window supervised, 051 resource guard settings, 052 project secrets, 053 browser tab snapshots, 054 ssh host fingerprint, 069 window mux ref, 070 supervisor launch pane ref and watch normalize, 071 agent watches window_id, 072-073 mux_ref kind fixes, 074 herdr navigation lock, 075 remove herdr remnants, 076 pending follow-up, 077 server default mux (servers.default_mux split from mux_runtime), 078 normalize misao window rows (mux_ref kind misao, tmux_target `<workspace>:<window id>`, duplicate rows merged), 079 merge duplicate `type=local` servers into one (rows re-pointed, `server_aliases` keeps the old names for webhooks / saved tabs for one release, #313))

### SSH (Tailscale)
- Persistent shell pool with `\x02AGENTMGR_B/E` markers for command execution
- `none` auth support (Tailscale SSH)
- `user@host:port` format supported

## Frontend

### Unified Workspace
- Single `/workspace/:id` route serves as the primary UI
- Global pages (Projects, Tasks, Units, Settings) are tabs within the workspace
- `TaskDetail.tsx` removed — task details shown inline in workspace TaskPanel

### Tab Groups (Chrome-style)
- Tabs are grouped by project with colored headers
- `useTabGroups` hook manages group state (collapse/expand, auto-expand on tab select)
- Group headers stay visible via sticky overlay when scrolled out of view
- Tab dropdown menu (▾) always visible for quick navigation
- Active tab auto-scrolls into visible area (100ms delay for group expand)
- Drag & drop reordering within and between groups

### Terminal Mode (xterm.js)
- Dynamic import of @xterm/xterm
- FitAddon, WebLinksAddon
- WebSocket to `/ws?server=X&target=Y&cols=C&rows=R` (legacy). Terminal mode also accepts `windowId=<id>&pane=<ordinal>` (registered window) and `ref=<formatMuxRef>&pane=<ordinal>` (by MuxRef); `target=` is a compatibility fallback
- Touch swipe scrolling via `useTmuxTouchScroll` hook (converts touch gestures to synthetic WheelEvents for xterm.js viewport)
- Mobile quick action buttons (Enter/Tab/Esc/Ctrl+C/Arrow Up/Arrow Down) shown when viewport <= 768px

### File Preview
- `StorageFilePreview`: image preview on file selection in FileExplorer
- PDF preview support via embedded viewer
- Mobile: clicking image preview closes sidebar

### Pane Session Recovery
- `TmuxClient.checkPaneExists`: lightweight pane alive check via `list-panes`
- `GET /api/tasks/:id` includes dynamic `paneAlive` flag (true/false/null)
- `POST /api/tasks/:id/recover-session`: resumes agent via `claude --resume <session-id>`
- TaskPanel polls pane status every 30s; shows recovery button when pane is lost
- Session ID validated as UUID to prevent command injection

### Task UI Enhancements
- `TaskRefBadges`: displays task ID, Issue number, and PR number as badges in task list/kanban
- Task summary: extracted as JSON after task completion, stored in `task_summary` column
- Agent session ID: saved on task creation (`agent_session_id` column) for session recovery
- `skipPr` toggle in task create/edit form: skips PR creation in pushing phase
- User-specified branch name field (when skipPr enabled): uses existing branch or creates from base
- Window Remove in ProjectSettings auto-closes associated terminal tabs
- Cross-project task lookup: TaskPanel falls back to `allTasks` when task not found in current project scope
- Per-task working directory override: `workingDirectory` field in task form overrides project server's default directory (migration 032)
- Unit default subagent config display: when subagent override is unchecked and a Unit is selected, shows the Unit's default Review/Implement subagent provider and model
- Pushing prompt template improved: `pushTaskDescription`, `pushRules`, `pushOutput` template variables replace `pushMode` for clearer skipPr support (migration 033)

### Mobile UX
- `useTmuxTouchScroll` hook: converts touch swipe gestures to synthetic WheelEvents with inertia/momentum scrolling, applied to Terminal and XTermView
- `useLongPress` hook: 500ms long-press detection for mobile context menus, exports `longPressStyle` to suppress text selection
- Long-press context menus in ServersSidebar: server, session, window, and pane rows support long-press to open context menus
- `useContextMenu` `showAt(x, y, items)` method: programmatic context menu positioning for touch coordinates
- TabBar `onTabLongPress` prop: enables long-press context menu on tabs
- Kanban board multi-line title wrapping with `-webkit-line-clamp: 2` for better mobile readability
- Mobile detection: `window.matchMedia('(max-width: 768px)')` with reactive MediaQueryList change listener

### Agent Reinstall
- ServerDetailPanel "Reinstall" button for `aztHarness` and `agent` dependencies (with confirmation dialog)
- ServersSidebar context menu "Reinstall agent" option for agent/SSH servers

### Task Status: `waiting_input`
- When an agent asks questions via `QUESTIONS_JSON`, task enters `waiting_input` status
- Questions displayed as structured UI (select/text inputs) in TaskPanel
- Submit answers via `POST /api/tasks/:id/answer`
- After submission, task resumes automatically (follow-up loop detects additional questions)

## API Patterns
- All routes return camelCase JSON
- Request bodies accept snake_case (for historical reasons in some endpoints)
- Session cache: 5s TTL for tmux session listings
- File APIs (path containment enforced via `assertDirectoryContained`/`assertPathContained`; write/create/delete/rename
  reject targets outside the project's `workingDirectory`, and delete additionally rejects `.git` and the root itself):
  - `GET /api/servers/:name/files?path=&showHidden=` (listing)
  - `GET /api/servers/:name/files/content?path=` (content, returns sha256 hash)
  - `GET /api/servers/:name/files/download?path=` (download)
  - `PUT /api/servers/:name/files/content` (save; requires `projectId`; optimistic-lock via `baseMtime`/`baseHash`
    unless `force: true`)
  - `POST /api/servers/:name/files` (create file/directory), `DELETE /api/servers/:name/files` (delete),
    `PATCH /api/servers/:name/files` (rename via `newName`)
  - `GET /api/servers/:name/files/search?q=&project_id=&root=&case=&whole_word=&regex=&include=&exclude=` (rg-preferred,
    grep-fallback content/name search)
  - `GET /api/servers/:name/git/diff?path=&base=&commit=&scope=&includeUncommitted=` (uncommitted / base-branch
    merge-base / commit diff scopes)
  - `GET /api/servers/:name/git/worktrees?project_id=` (worktree list for the root switcher, joined to tasks)
- Directory autocomplete: `/api/servers/:name/directories?path=`
- Agent routes: `/api/agent/*` (authenticated via `X-Agent-Token` header)
- Process list (#371): `transport.listProcesses()` is the one way to list a host's processes (pid / ppid / startMs / executable / commandLine / rssBytes; `shared/os/processList.ts`). Unix runs `ps` and Windows `Get-CimInstance Win32_Process` (PowerShell EncodedCommand, FILETIME start times), both as a `CommandSpec`; an agent serves it at `GET /api/processes` (an older agent without it is read through `/api/run`, or its shell route when its host is unrecorded)
- Task answer: `POST /api/tasks/:id/answer` (submit question responses)
- Task recovery: `POST /api/tasks/:id/recover-session` (resume agent session)
- Task deletion: `DELETE /api/tasks/:id` (cleans up tmux window, worktree, temp files)
- Usage: `GET /api/usage` (aggregated Claude/Codex token usage)
- Webhooks: `POST /api/webhooks/agent-done` (agent completion notifications, shared `AZITO_WEBHOOK_TOKEN`)
- Install status: `/api/servers/:name/install-status` (dependency install detection for ServerDetailPanel)
- Branch search: `GET /api/servers/:name/branches?working_directory=` (optional working directory override for branch listing)
- Units: `/api/units` CRUD + `execute`/`follow-up`/`stop`/`approve-plan`/`logs` (merged Operation+WorkerProfile — behavior + runtime; Issue #263 Refine B)
- Window operations (5-A): `DELETE /api/windows/:id/kill`, `PUT /api/windows/:id/rename`, `POST /api/windows/:id/panes`,
  `GET /api/windows/:id/panes/:ordinal/capture`, `POST .../send-keys`, `POST .../zoom`, `POST .../unzoom`,
  `PUT .../rename`, `DELETE /api/windows/:id/panes/:ordinal` — windowId-based pane routes
- Ref-based window operations (5-A): `/api/servers/:name/mux/windows/:ref/{kill,rename,panes,...}` — same operations via MuxRef for unregistered windows
- `GET /api/windows/pane-loading-state` accepts `?windowId=` in addition to `?server_name=&tmux_target=`
- Operations: `GET /api/operations` (currently running execution runs — `{ unitId, taskId, target, windowId? }[]`; no operations table anymore)
- misao windows (a window whose `mux_ref.kind` is `misao`; a local server hosts tmux and misao windows side by side —
  `MuxDriverRegistry.resolve(server)` returns a `RoutingMuxClient` that routes each call by the ref's kind / the pane handle's
  shape and merges server-wide listings; `servers.default_mux` only decides where new windows are created and is separate from
  `servers.mux_runtime`, which only selects the tmux binary `system`/`managed` — migration 077; the API still reads the legacy
  `muxRuntime: 'misao'` as `defaultMux: 'misao'` for one release): no tui-supervisor (`shouldSupervise(..., windowKind)` is false for
  misao windows). `GET /api/servers/:name/sessions` stamps each session with `kind`; `?detail=1` returns `{ sessions, unavailable }`
  where `unavailable` lists the hosted muxes that could not be listed (their windows are kept, not treated as deleted). The daemon's `pane.state` events (`MisaoPaneStateEvents` → `MisaoActivityBridge`, first pane of a window only) drive
  `tier0_mux` through `recordMuxSignal()`; the Rust core does report `blocked` (from its agent profiles), and a `tier0_mux` working/idle row on a
  misao window is still confirmed against the window's first-pane screen (resolved from `mux_ref`, no title pre-check) and refined to
  blocked with `refinedBy: 'tier2_title'`. The three hooks send `misaoPaneId` (from `$MISAO_PANE_ID`) instead of tmux fields when
  `$TMUX_PANE` is absent; Diagnostics rows carry `mux: { status, decidedBy?, at }`.
  See `docs/{ja,en}/activity-detection.md` §13
- Activity diagnostics: `GET /api/debug/activity` (read-only Tier attribution per window — `decidedBy`
  (`tier0_supervisor`/`tier0_mux`/`tier1_hook`/`tier2_title`/`tier3_heuristic`/`tier4_probe`/`none`) plus the supervisor /
  hook / probe material and the last announced transition; rendered in Settings → System「稼働検知診断」).
  `refinedBy: 'tier2_title'` は「Tier 0 が idle と判定した行を Tier 2 の画面分類が blocked へ精緻化した」印
  （claude は AskUserQuestion 選択中もタイトルが idle グリフ `✳ ` のままで、タイトルしか見ない supervisor が
  idle を報告するため）。精緻化された行は稼働（blocked）のまま残り、完了遷移は発行されない。Tier 0 が沈黙して
  いるキー（supervisor 再接続直後など）では Tier 2 自身が同じ画面確認を行い、`decidedBy: 'tier2_title'` /
  `state: 'blocked'` として同じ結論に達する（idle → blocked の一方向のみ。working への昇格はしない）。
  画面確認は blocked / not_blocked / unknown の3値で、unknown（capture-pane 失敗・tmux スナップショット取得
  失敗）は「blocked でない」ではなく直前 tick の状態を最大30秒保持する。コスト面では、再描画のない
  （`window_activity` が進んでいない）ペインは再キャプチャせず、キャプチャはサーバー単位で最大4並列。
  Tier 判定・タイミング定数・reason・サーバータイプ別対応範囲の全仕様は `docs/ja/activity-detection.md`
  （正本）/ `docs/en/activity-detection.md` を参照
- Sidekick tags (Issue #263 Refine A): `tags: string[]` replaces the old single-value `phase:` frontmatter field. The five
  phase names are special-cased as "phase tags" (a Unit's `phaseConfig` can only assign a phase to a Sidekick carrying
  that tag; `isDefault` requires at least one phase tag); any other tag is free-form. `/azt-sidekick` accepts multiple
  names in one invocation and runs them in order

## Development Notes

### Running Tests
```bash
npx -w packages/server vitest run          # Unit tests (vitest 4.1.8)
npx -w packages/server tsc --noEmit        # Server type check
npx -w packages/frontend tsc --noEmit      # Frontend type check
npm run depcruise                          # Module dependency direction / circular dependency check
npm run e2e                                # Playwright E2E (activity detection suite; local only, not in CI)
```

`npm run e2e` builds the frontend + tui-supervisor, then runs `e2e/` against a throwaway hub instance:
temp `AZITO_DATA_DIR`, random free port, and an isolated tmux server via `TMUX_TMPDIR` (the host's tmux,
:3001 and :5173 are never touched). Agents are scripted fakes — no LLM is launched. First run needs
`npx playwright install chromium`. The server honours `AZITO_E2E_FAST_INTERVALS=1` to shorten the activity
monitor's *observation* periods only (probe refresh / cache TTL); judgment thresholds are unchanged and the
variable has no effect when unset.

`e2e/specs/misao.spec.ts` covers the misao runtime (settings switch, window creation, terminal
attach, task execution with the scripted `fake-agent/task-agent`, activity detection via `pane.state`,
daemon-down notice). It starts its own `misao serve` from a temp dir (`e2e/fixtures/misaoDaemon.ts`, never the
resident `~/.misao` daemon) and a hub with `MISAO_SOCKET` pointing at it (without `misaoSocket` the harness points it at a non-existent temp socket, so a hub never reaches the resident daemon)
(`Harness.start({ misaoSocket })`, `fixtures/misaoTest.ts`). It needs the misao **binary**: `MISAO_CLI` names the executable (a v0.3.0 release
binary, or `target/release/misao` of a misao checkout, which is the default `~/workspace/misao/target/release/misao`); without it the spec is
skipped with a reason. The `*.misaoIntegration.test.ts` files read the same `MISAO_CLI` (`shared/misaoTestBinary.ts`); the CI job "misao integration tests" fetches the pinned linux-x64 binary (`scripts/fetch-misao-binary.ts`) and runs `vitest --project misao-integration` on it. The
existing tmux specs and `fixtures/test.ts` are unaffected. Docs: `docs/{ja,en}/misao.md`.

### Adding a Migration
1. Create `packages/server/src/shared/db/migrations/NNN_description.ts`
2. Import in `Database.ts` and add to `migrations` array
3. Export: `version`, `description`, `up(db)` function

### E2E Test Task (State Machine Flow)
```bash
./scripts/create-test-task.sh <project_id> <unit_id> [PORT]   # default PORT=3001
```

### Adding a New Worker Type
1. Create `packages/server/src/domain/worker/XxxWorker.ts` implementing `IWorker`
2. Add to `WorkerFactory.ts`
3. Add to `WORKER_MODELS` in `packages/server/src/infrastructure/llm/LlmClient.ts`
4. Add to frontend `WORKER_COMMANDS` in Unit forms

## Environment
- Server: WSL2 Ubuntu 24.04, Node.js v24.14
- tmux 3.4
- Tailscale for multi-server SSH (none auth)
- Codex CLI (flat-rate plan)
- Claude Code CLI available
- vitest 4.1.8 (CVE-2026-47428/47429 patched)
