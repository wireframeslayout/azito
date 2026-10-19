import type { MuxDriverKind } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import { resolveSupervisorCommand } from './SupervisorPath';
import type { ShellDialect } from '../../shared/os/shellDialect';

/** `windowKind` is the mux kind of the window being launched (its `MuxRef.kind`), not the server's default mux. */
export function shouldSupervise(serverType: ServerConfig['type'], windowType: string, windowKind: MuxDriverKind): boolean {
  return windowType === 'agent' && windowKind !== 'misao';
}

export interface WrapWithSupervisorOptions {
  server: Pick<ServerConfig, 'name' | 'type'>;
  /** The shell of the pane the wrapped line is typed into (the target host's `shellDialectFor(hostProfile)`). */
  dialect: ShellDialect;
  target: string;
  taskId?: number;
  unitId?: number;
  /**
   * Launch binding (Issue #28 Phase C, design v3 §8) — pass both together,
   * normally sourced from `SupervisorRegistry.issueLaunch()` right before
   * calling this function. Omitted only when no DB-backed launch repository
   * is available at this call site (falls back to an unbound launch, exactly
   * the pre-Phase-C behavior); every production call site has one.
   */
  launchId?: string;
  bootstrapToken?: string;
  /** When the hub runs with `--prefix`, pass it so the supervisor resolves
   *  `~/.azito/azitoctl-<prefix>.env` instead of the default `azitoctl.env`. */
  harnessPrefix?: string;
}

/**
 * Wraps a worker launch command with `tui-supervisor`, so the supervisor's
 * PTY sits between the tmux pane and the actual worker process (activity
 * tracking + prompt injection). The wrapped command is what gets typed into
 * the pane via tmux send-keys — see packages/tui-supervisor/src/cli.ts's
 * `parseArgs()`: everything after `--` is re-joined with spaces, so `cmd`
 * must be quoted as a single shell-level argument for it to survive that
 * round-trip intact (quotes/spaces/pipes preserved).
 */
export function wrapWithSupervisor(cmd: string, opts: WrapWithSupervisorOptions): string {
  const { dialect } = opts;
  const supervisorCmd = resolveSupervisorCommand(opts.server, dialect);
  const env: Record<string, string> = {};

  if (opts.harnessPrefix) {
    env.AZITO_PREFIX = opts.harnessPrefix;
  }

  if (opts.launchId !== undefined && opts.bootstrapToken !== undefined) {
    // Launch binding is passed via env vars prefixed onto the command line
    // (`NAME=value tui-supervisor ...`), not as `--launch-id`/`--bootstrap-token`
    // flags (changed from the original Issue #28 Phase C shape — see git
    // history for the flag-based version and its rationale).
    //
    // Reason: the wrapped command is typed BLIND into a tmux pane via
    // `send-keys`, with no handshake to learn which `tui-supervisor` binary
    // version is actually installed there before typing it. A binary
    // installed before Issue #28 (`packages/tui-supervisor/src/cli.ts`'s
    // `parseArgs`, pre-launch-binding revision) rejects ANY unrecognized
    // flag and exits immediately — `tui-supervisor: unknown flag:
    // --launch-id` — which broke every agent window launch during the
    // window between a hub update and the matching supervisor
    // reinstall/update on that server (observed in production; reproduced
    // on this host). An unrecognized env var, by contrast, is simply never
    // read by an old binary — the shell still execs the command
    // successfully.
    //
    // A newer `cli.ts` still accepts the old `--launch-id`/`--bootstrap-token`
    // flags for the reverse compatibility direction (old hub -> new
    // supervisor, which never emits env vars).
    //
    // Exposure note (unchanged from the prior review — Issue #28 third-party
    // review, second round, Fix 5): a same-uid (or root) process can still
    // read this value, now via `/proc/<pid>/environ` instead of
    // `/proc/<pid>/cmdline`/`ps`. That is not a new boundary this system
    // defends (same-uid isolation is not treated as in-scope anywhere else
    // in this codebase — mode-600 credential files, `.env`, the SQLite DB
    // are all already same-uid readable), so this change is a compatibility
    // fix, not a security hardening — it neither closes nor opens an
    // in-scope exposure.
    //
    // Fix 4's bootstrap TTL (`PENDING_BOOTSTRAP_TTL_MS`, 15 min) and the
    // `child_exit`/task-window-destroy expiry paths (`SupervisorRegistry.
    // expireLaunchId`/`resolveLaunchForExpiry`+`expireResolvedLaunch`)
    // still bound how long a captured token stays useful.
    env.AZITO_SUPERVISOR_LAUNCH_ID = opts.launchId;
    env.AZITO_SUPERVISOR_BOOTSTRAP = opts.bootstrapToken;
  }

  const parts = [
    supervisorCmd,
    '--server',
    dialect.quote(opts.server.name),
    '--target',
    dialect.quote(opts.target),
  ];

  if (opts.taskId !== undefined) {
    parts.push('--task-id', String(opts.taskId));
  }
  if (opts.unitId !== undefined) {
    parts.push('--unit-id', String(opts.unitId));
  }

  parts.push('--', dialect.quote(cmd));
  const line = parts.join(' ');
  return Object.keys(env).length > 0 ? dialect.withEnv(env, line) : line;
}
