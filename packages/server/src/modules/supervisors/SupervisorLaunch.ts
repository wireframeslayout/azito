import type { ServerConfig } from '../servers/Server';
import { resolveSupervisorCommand } from './SupervisorPath';
import { shellQuote } from '../../shared/shellQuote';

export function shouldSupervise(serverType: ServerConfig['type'], windowType: string): boolean {
  return windowType === 'agent';
}

export interface WrapWithSupervisorOptions {
  server: Pick<ServerConfig, 'name' | 'type'>;
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
  const supervisorCmd = resolveSupervisorCommand(opts.server);
  const parts = [
    supervisorCmd,
    '--server',
    shellQuote(opts.server.name),
    '--target',
    shellQuote(opts.target),
  ];

  if (opts.taskId !== undefined) {
    parts.push('--task-id', String(opts.taskId));
  }
  if (opts.unitId !== undefined) {
    parts.push('--unit-id', String(opts.unitId));
  }
  if (opts.launchId !== undefined && opts.bootstrapToken !== undefined) {
    // Known limitation, investigated and left as argv (Issue #28 third-party
    // review, second round, Fix 5): `--bootstrap-token` on the command line
    // is readable by any other process on the same host via `ps`/
    // `/proc/<pid>/cmdline` — a same-uid (or root) attacker could read it,
    // whereas passing it via env would only be readable through
    // `/proc/<pid>/environ`, which is EUID-gated (same user or root only).
    // That's a real reduction against a DIFFERENT uid, but a same-uid
    // process can already read plenty else this hub writes for itself and
    // its agents under $HOME (mode-600 credential files, `.env`, the SQLite
    // DB) — same-uid isolation is not a boundary this codebase currently
    // defends anywhere else, so moving just this one value off argv would
    // not close any attack this system's threat model actually treats as
    // in scope; it would only look like a fix.
    //
    // It was also not adopted for a second, compatibility reason: this
    // command is typed BLIND into a tmux pane (`send-keys`) with no
    // handshake to learn which `tui-supervisor` binary version is actually
    // installed there before typing it — the hub cannot tell whether the
    // pane will exec the new supervisor (which could read an env var) or an
    // older one (`packages/tui-supervisor/src/cli.ts`'s `parseArgs` only
    // ever reads `--bootstrap-token` from argv, no version negotiation
    // exists). Switching the hub to emit only an env var would silently
    // break every "new hub -> old (not yet updated) supervisor" launch —
    // worse than the exposure it would close. Emitting BOTH (env + argv) to
    // stay compatible would leave the argv copy exposed anyway, closing
    // nothing.
    //
    // Fix 4's bootstrap TTL (`PENDING_BOOTSTRAP_TTL_MS`, 15 min) and the
    // `child_exit`/task-window-destroy expiry paths (`SupervisorRegistry.
    // expireLaunchId`/`markLaunchExpired`) already bound how long a
    // captured token stays useful even under the current argv exposure.
    parts.push('--launch-id', shellQuote(opts.launchId), '--bootstrap-token', shellQuote(opts.bootstrapToken));
  }

  parts.push('--', shellQuote(cmd));
  return parts.join(' ');
}
