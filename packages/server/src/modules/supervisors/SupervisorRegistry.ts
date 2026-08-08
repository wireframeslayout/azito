import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';

import {
  SUPERVISOR_PROTOCOL_VERSION,
  type ActivityState,
  type AgentStatus,
  type HubToSupervisorMessage,
  type InjectPromptMessage,
  type InterruptMessage,
  type RegisterMessage,
  type SendKeysMessage,
  type SupervisorToHubMessage,
} from './protocol';
import type {
  ISupervisorLaunchRepository,
  SupervisorLaunchExpectation,
  IssuedSupervisorLaunch,
} from './SupervisorLaunchRepository';
import type { AuditLogService } from '../../shared/audit/AuditLogService';

const ACK_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 15_000;
/** How long a `child_exit` marker (see SupervisorRegistry.exitedKeys) is honored before being
 * treated as expired. Bounds otherwise-unbounded growth of that map for keys that are never
 * reused (task windows get a fresh random-suffixed target every run, so `register()`'s own
 * clear-on-reconnect never fires for them). */
const EXITED_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** `T extends unknown ? ... : never` forces the conditional to distribute over
 * a union input instead of collapsing to `Pick<T, Exclude<keyof T, K>>`
 * (plain `Omit` over a union only keeps the fields common to every member —
 * here just `type` — which drops `text`/`keys` and breaks callers). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Commands a caller may send via `sendCommand` — deliberately excludes
 * `RegisteredMessage` (the hub->supervisor handshake ack, never sent by a
 * caller) so `type` narrows correctly to a real command.
 */
export type SupervisorCommand = DistributiveOmit<InjectPromptMessage | SendKeysMessage | InterruptMessage, 'id'>;

export type SupervisorCommandFailureReason =
  | 'not_sent' // never left the hub: not connected, or the socket write itself failed/was rejected explicitly (ok:false)
  | 'ack_timeout'; // written to the socket, but the outcome is unknown (ack never arrived, or the connection dropped before it did)

/**
 * Thrown by `sendCommand` so callers (WorkerInputService) can tell "safe to
 * retry via a different channel" (`not_sent`) apart from "already in flight,
 * retrying risks double-delivery" (`ack_timeout`).
 */
export class SupervisorCommandError extends Error {
  constructor(message: string, public readonly reason: SupervisorCommandFailureReason) {
    super(message);
    this.name = 'SupervisorCommandError';
  }
}

interface PendingAck {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface SupervisorConnection {
  socket: WebSocket;
  serverName: string;
  target: string;
  taskId: number | null;
  unitId: number | null;
  pid: number;
  childCommand: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  /** Ping/pong liveness bookkeeping — see startPing(). */
  missedPongs: number;
  pendingAcks: Map<string, PendingAck>;
  /** Set once the child TUI has reported 'ready' on this connection. See handleMessage's 'ready' case. */
  ready: boolean;
  /**
   * True iff this connection's identity was verified against a persisted
   * `supervisor_launches` row (Issue #28 Phase C, design v3 §8). False for a
   * launchId-less registration (manual `azs`) once `AZITO_SCOPED_AUTH` is
   * on — an "unbound" connection is display-only: it must never drive
   * AgentActivityMonitor's Tier 0 override or a task turn's idle-timer
   * refresh, since nothing verified it actually corresponds to the task/unit
   * it claims. See resolveLaunchAuth().
   */
  bound: boolean;
  launchId: string | null;
}

export interface SupervisorEntry {
  serverName: string;
  target: string;
  taskId: number | null;
  unitId: number | null;
  pid: number;
  childCommand: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  ready: boolean;
  bound: boolean;
}

export interface SupervisorActivityEvent {
  serverName: string;
  target: string;
  taskId: number | null;
  unitId: number | null;
  state: ActivityState;
  /** Title-derived agent status ('blocked' = stalled on a permission prompt).
   * Absent from supervisors predating the title tracker → treated as working. */
  status?: AgentStatus;
  /** First-launch child command (e.g. `claude --dangerously-skip-permissions`) —
   * carried through so callers can derive a display label for supervised
   * panes that have no `windows` table row. */
  childCommand: string;
  /** See SupervisorConnection.bound's doc comment — false means "display only, do not drive Tier 0 / turn idle refresh". */
  bound: boolean;
}

export interface SupervisorReadyEvent {
  serverName: string;
  target: string;
  taskId: number | null;
  unitId: number | null;
}

export interface SupervisorChildExitEvent {
  serverName: string;
  target: string;
  taskId: number | null;
  exitCode: number | null;
  signal: number | null;
  bound: boolean;
}

export interface SupervisorDisconnectedEvent {
  serverName: string;
  target: string;
  bound: boolean;
}

function keyFor(serverName: string, target: string): string {
  return `${serverName}::${target}`;
}

/**
 * Hub-side registry for `tui-supervisor` WebSocket connections (`/ws/supervisor`).
 * Tracks one live connection per `${serverName}::${target}` key, forwards
 * hub->supervisor commands with ack/timeout semantics, and re-emits
 * supervisor->hub activity/child_exit/ready signals — plus its own
 * 'disconnected' event on WS close — for upstream consumers to bridge into
 * AgentActivityMonitor/turns/notifications (out of scope here — see callers).
 *
 * All incoming JSON parsing/shape-validation of the initial `register` message
 * happens in ws/supervisorSocketHandler.ts; this class only deals with
 * already-typed messages.
 */
type LaunchAuthResult =
  | { ok: true; bound: boolean; launchId: string | null; sessionToken?: string }
  | { ok: false; event: string; reason: string };

export class SupervisorRegistry extends EventEmitter {
  /**
   * @param launchRepo Persists/validates `--launch-id`/`--bootstrap-token` launches (Issue #28
   *   Phase C). Undefined only where no DB is available (e.g. some test/dev infra) — a
   *   launchId-bearing register is then rejected outright (fail closed) rather than silently
   *   trusted, since there is no way to validate it.
   * @param auditLogService Best-effort audit trail for launch bind/reject/unbound decisions
   *   (design v3 §10). Undefined is tolerated (tests) — audit calls are then skipped.
   * @param scopedAuthEnabled Compat gate (design v3 §12): while false, a launchId-less register
   *   (manual `azs`, or a pre-Phase-C supervisor) is treated as `bound` exactly like before this
   *   phase — flipping it to `unbound` only takes effect once the flag is on.
   */
  constructor(
    private launchRepo?: ISupervisorLaunchRepository,
    private auditLogService?: AuditLogService,
    private scopedAuthEnabled: boolean = false,
  ) {
    super();
  }

  private connections = new Map<string, SupervisorConnection>();
  private socketKeys = new WeakMap<WebSocket, string>();
  private pingTimers = new Map<string, NodeJS.Timeout>();
  /**
   * In-memory marker of "this key's child TUI exited and nothing new has registered since" —
   * consulted by GET /api/windows/pane-loading-state so a pane whose supervised worker already
   * finished doesn't make the frontend wait out the full loading-overlay timeout on every open
   * (there is no live connection/ready state left to check by then). Deliberately in-memory only:
   * a hub restart just degrades back to "wait the full timeout" for that pane, same as before this
   * marker existed — not worth persisting for. Keyed by the same `keyFor(serverName, target)` as
   * `connections`; set on `child_exit`, cleared the moment a new connection registers for the key.
   * Entries older than `EXITED_KEY_TTL_MS` are treated as expired (and swept opportunistically —
   * see `child_exit` and `hasRecentChildExit`) so a key that's never reused (e.g. a task window's
   * random-suffixed target) doesn't linger in this map forever on a long-running hub.
   */
  private exitedKeys = new Map<string, number>();

  /** Removes expired entries from exitedKeys. Called from child_exit (the only place new entries
   * are added) rather than on a timer — cheap enough given how infrequently child_exit fires, and
   * avoids one more interval to manage/tear down alongside the ping timers. */
  private sweepExpiredExitedKeys(): void {
    const cutoff = Date.now() - EXITED_KEY_TTL_MS;
    for (const [key, exitedAt] of this.exitedKeys) {
      if (exitedAt < cutoff) this.exitedKeys.delete(key);
    }
  }

  /**
   * Issues a fresh `supervisor_launches` row for a launch about to be wrapped
   * (`wrapWithSupervisor()`, called immediately after) — Issue #28 Phase C,
   * design v3 §8. Returns undefined when no `launchRepo` was injected (no DB
   * available at this hub instance); callers fall back to wrapping without
   * `--launch-id`/`--bootstrap-token`, which registers as `unbound` under
   * scoped auth (or `bound` under the compat flag, same as always).
   *
   * Issue #28 third-party review finding (Important): `launchRepo.create()`
   * below invalidates any prior `supervisor_launches` row for this
   * `(serverName, target)` (its own doc comment's "supersede step") — but
   * that only affects the PERSISTED row, not whatever in-memory `connections`
   * entry is still live for the key. If the OLD supervisor process's
   * WebSocket is still connected when this is called (the hub hasn't yet
   * observed its disconnect) and the NEW supervisor process then fails to
   * start/register at all, the OLD connection would otherwise stay `bound`
   * — still driving AgentActivityMonitor's Tier 0 override and the task
   * turn's idle-timer refresh — forever, as the authority for a launch that
   * was just superseded and no longer has a valid token. Downgrading it to
   * `unbound` HERE (immediately, at issuance) rather than waiting for the
   * new registration to evict it (`register()`'s own eviction path) or for
   * the new supervisor's activity to arrive is the cheap option: it's a
   * single in-memory map lookup on the rare (re-launch) path, with no new
   * I/O, no new persisted state, and no behavior change for the common case
   * (no existing connection for the key). The connection itself is left
   * alone — still displayed, still able to reconnect — only its authority to
   * drive Tier 0/turn-idle-refresh is revoked; `register()`'s later replace
   * either evicts it for real (successful new registration) or never comes
   * (new supervisor never starts), in which case it now correctly shows as
   * unbound/display-only instead of silently remaining authoritative.
   */
  issueLaunch(expectation: SupervisorLaunchExpectation): IssuedSupervisorLaunch | undefined {
    const issued = this.launchRepo?.create(expectation);
    if (issued) this.downgradeToUnbound(keyFor(expectation.serverName, expectation.target));
    return issued;
  }

  /**
   * Demotes an existing bound connection for `key` to unbound in place —
   * does NOT close/replace the socket. See {@link issueLaunch}'s doc comment
   * for why this exists. No-op if there is no connection for the key, or it
   * is already unbound.
   */
  private downgradeToUnbound(key: string): void {
    const existing = this.connections.get(key);
    if (!existing || !existing.bound) return;
    existing.bound = false;
    existing.launchId = null;
    this.audit('supervisor_launch.superseded_downgrade', {
      serverName: existing.serverName,
      target: existing.target,
    });
  }

  private audit(event: string, detail: Record<string, unknown>): void {
    try {
      this.auditLogService?.record({ actorClass: 'runtime', actorId: null, event, detail });
    } catch {
      // Best-effort — never let an audit write failure affect registration handling.
    }
  }

  /**
   * Decides whether `info` is `bound` (verified against a persisted launch)
   * or should be rejected outright. Never throws. See SupervisorConnection.bound's
   * doc comment for what `bound` gates downstream.
   */
  private resolveLaunchAuth(info: RegisterMessage): LaunchAuthResult {
    if (info.launchId === undefined) {
      // Manual `azs`, or a supervisor build predating launch binding.
      if (!this.scopedAuthEnabled) {
        // Compat mode (design v3 §12): unchanged behavior — treated as bound.
        return { ok: true, bound: true, launchId: null };
      }
      this.audit('supervisor_launch.unbound', { serverName: info.serverName, target: info.target });
      return { ok: true, bound: false, launchId: null };
    }

    if (!this.launchRepo) {
      return { ok: false, event: 'supervisor_launch.no_repo', reason: 'launch repository unavailable' };
    }

    const row = this.launchRepo.findByLaunchId(info.launchId);
    if (!row) {
      this.audit('supervisor_launch.unknown', { launchId: info.launchId, serverName: info.serverName, target: info.target });
      return { ok: false, event: 'supervisor_launch.unknown', reason: 'unknown launch id' };
    }

    const mismatch =
      row.serverName !== info.serverName ||
      row.target !== info.target ||
      row.taskId !== info.taskId ||
      row.unitId !== info.unitId;
    if (mismatch) {
      this.audit('supervisor_launch.mismatch', {
        launchId: info.launchId,
        expected: { serverName: row.serverName, target: row.target, taskId: row.taskId, unitId: row.unitId },
        claimed: { serverName: info.serverName, target: info.target, taskId: info.taskId, unitId: info.unitId },
      });
      return { ok: false, event: 'supervisor_launch.mismatch', reason: 'declared identity does not match the issued launch' };
    }

    if (info.sessionToken !== undefined) {
      if (!this.launchRepo.verifySession(row, info.sessionToken)) {
        this.audit('supervisor_launch.session_rejected', { launchId: info.launchId });
        return { ok: false, event: 'supervisor_launch.session_rejected', reason: 'invalid session token' };
      }
      this.launchRepo.touchRegistered(info.launchId);
      return { ok: true, bound: true, launchId: info.launchId };
    }

    if (info.bootstrapToken !== undefined) {
      if (!this.launchRepo.verifyBootstrap(row, info.bootstrapToken)) {
        this.audit('supervisor_launch.bootstrap_rejected', { launchId: info.launchId, status: row.status });
        return { ok: false, event: 'supervisor_launch.bootstrap_rejected', reason: 'invalid or already-consumed bootstrap token' };
      }
      const sessionToken = this.launchRepo.activateWithSession(info.launchId);
      this.audit('supervisor_launch.bound', { launchId: info.launchId, serverName: info.serverName, target: info.target });
      return { ok: true, bound: true, launchId: info.launchId, sessionToken };
    }

    return { ok: false, event: 'supervisor_launch.missing_credential', reason: 'launchId present without a bootstrap/session token' };
  }

  /**
   * Registers a supervisor connection. Same-key re-registration replaces the
   * previous connection (closes the old socket with code 1000 and rejects its
   * pending acks) rather than rejecting the new one — a supervisor process
   * reconnecting after a hub restart/network blip is the expected case.
   *
   * EXCEPTION (Issue #28 Phase C): if the existing connection on this key is
   * `bound` to a launchId and the new registration's launchId differs (or is
   * absent), the new registration is normally rejected and the existing
   * connection is left untouched — a different launch must never evict a
   * bound one (design v3 §8: "異なる launchId からの置換（追い出し）は拒否").
   *
   * Sub-exception (Issue #28 Phase C review, Important finding): credentials
   * are checked BEFORE that eviction guard, not after. A legitimate
   * re-launch for the same key (e.g. WindowRespawnService re-executing a
   * task) issues a fresh `supervisor_launches` row that supersedes the old
   * one — `SqliteSupervisorLaunchRepository.create()` invalidates the prior
   * row so its bootstrap/session token stops verifying. If the OLD
   * supervisor's WebSocket is still connected (hub hasn't yet observed the
   * disconnect) when the NEW supervisor process registers with its NEW,
   * already-authenticated launchId, `resolveLaunchAuth` below has already
   * confirmed the new registration IS the current launch for this key (an
   * old/superseded/forged launchId simply fails auth and never reaches this
   * branch as "authenticated"). Refusing it anyway — as a pre-auth ordering
   * used to — would strand the task with a dead old connection forever,
   * since the old process is never coming back to free the key. Only a
   * registration that failed authentication (unknown/mismatched/invalid
   * token, or no launchId at all) is still refused outright here, leaving
   * the existing bound connection untouched.
   */
  register(socket: WebSocket, info: RegisterMessage): void {
    if (info.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) {
      console.warn(
        `[supervisors] protocol version mismatch for ${info.serverName}::${info.target}: ` +
          `got ${info.protocolVersion}, expected ${SUPERVISOR_PROTOCOL_VERSION}`,
      );
      this.safeClose(socket, 4000, 'protocol version mismatch');
      return;
    }

    const key = keyFor(info.serverName, info.target);
    const existing = this.connections.get(key);
    const authResult = this.resolveLaunchAuth(info);

    if (existing?.bound && existing.launchId !== null && existing.launchId !== (info.launchId ?? null)) {
      const isAuthenticatedReplacement = info.launchId !== undefined && authResult.ok;
      if (!isAuthenticatedReplacement) {
        this.audit('supervisor_launch.replace_rejected', {
          serverName: info.serverName,
          target: info.target,
          existingLaunchId: existing.launchId,
          newLaunchId: info.launchId ?? null,
        });
        this.safeClose(socket, 4009, 'existing bound connection retained (launch id mismatch)');
        return;
      }
      // Falls through: authResult.ok is true, so the new registration is the
      // verified current launch for this key — evict the stale connection below.
    }

    if (!authResult.ok) {
      this.safeClose(socket, 4001, authResult.reason);
      return;
    }

    if (existing) {
      this.socketKeys.delete(existing.socket);
      this.teardown(key, existing, new Error('replaced by new registration'));
      this.safeClose(existing.socket, 1000, 'replaced by new registration');
    }
    // A fresh registration means whatever previously exited on this key no longer describes the
    // current state — clear the stale marker so pane-loading-state stops suppressing `supervised`.
    this.exitedKeys.delete(key);

    const conn: SupervisorConnection = {
      socket,
      serverName: info.serverName,
      target: info.target,
      taskId: info.taskId,
      unitId: info.unitId,
      pid: info.pid,
      childCommand: info.childCommand,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      missedPongs: 0,
      pendingAcks: new Map(),
      // Supervisors that don't report `reportsReady: true` predate the boot-readiness signal
      // entirely and will never send a `ReadyMessage` — there is no way to observe their child
      // TUI's boot completion, so treat them as ready immediately (matches pre-readiness-signal
      // behavior) rather than leaving `ready: false` forever and forcing every frontend open of
      // that pane to sit out the full loading-overlay timeout.
      ready: info.reportsReady === true ? false : true,
      bound: authResult.bound,
      launchId: authResult.launchId,
    };
    this.connections.set(key, conn);
    this.socketKeys.set(socket, key);

    socket.on('pong', () => {
      conn.missedPongs = 0;
    });

    this.safeSend(socket, authResult.sessionToken ? { type: 'registered', sessionToken: authResult.sessionToken } : { type: 'registered' });
    this.startPing(key, conn);
  }

  /** Routes an already-parsed non-register message to its connection. Ignores unmatched/unknown messages. */
  handleMessage(socket: WebSocket, msg: SupervisorToHubMessage): void {
    const key = this.socketKeys.get(socket);
    if (!key) return; // message arrived before (or without) registration
    const conn = this.connections.get(key);
    if (!conn) return;

    switch (msg.type) {
      case 'heartbeat':
        conn.lastHeartbeatAt = Date.now();
        break;

      case 'activity':
        this.emit('activity', {
          serverName: conn.serverName,
          target: conn.target,
          taskId: conn.taskId,
          unitId: conn.unitId,
          state: msg.state,
          status: msg.status,
          childCommand: conn.childCommand,
          bound: conn.bound,
        } satisfies SupervisorActivityEvent);
        break;

      case 'ready':
        // Idempotent per connection: a reconnected supervisor re-sends 'ready'
        // once its handshake completes (see protocol.ts's ReadyMessage doc),
        // which is expected and should re-emit (a fresh connection always
        // starts at ready:false — this is how the hub recovers ready state
        // after its own restart). A duplicate on the *same* connection is not
        // expected and is suppressed here.
        if (conn.ready) break;
        conn.ready = true;
        this.emit('ready', {
          serverName: conn.serverName,
          target: conn.target,
          taskId: conn.taskId,
          unitId: conn.unitId,
        } satisfies SupervisorReadyEvent);
        break;

      case 'child_exit': {
        this.exitedKeys.set(key, Date.now());
        this.sweepExpiredExitedKeys();
        this.emit('child_exit', {
          serverName: conn.serverName,
          target: conn.target,
          taskId: conn.taskId,
          exitCode: msg.exitCode,
          signal: msg.signal,
          bound: conn.bound,
        } satisfies SupervisorChildExitEvent);
        this.socketKeys.delete(conn.socket);
        this.teardown(key, conn, new Error('supervisor child exited'));
        break;
      }

      case 'ack': {
        const pending = conn.pendingAcks.get(msg.id);
        if (!pending) break;
        conn.pendingAcks.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve();
        } else {
          // The supervisor explicitly confirmed it did NOT apply the command
          // (ok:false) — safe for the caller to retry via another channel.
          pending.reject(new SupervisorCommandError(msg.error ?? 'command failed', 'not_sent'));
        }
        break;
      }

      default:
        // Unknown message types are ignored (forward compatibility).
        break;
    }
  }

  /** Call from the socket's 'close' handler. No-op if the socket was already replaced/removed. */
  handleSocketClosed(socket: WebSocket): void {
    const key = this.socketKeys.get(socket);
    if (!key) return;
    this.socketKeys.delete(socket);
    const conn = this.connections.get(key);
    if (!conn || conn.socket !== socket) return; // stale close from an already-replaced socket
    this.teardown(key, conn, new Error('supervisor disconnected'));
    // A closed connection is not itself proof the agent stopped (e.g. the
    // supervisor process crashing and being relaunched) — unlike an explicit
    // child_exit, this only releases the key back to Tier 1/2 detection
    // rather than asserting idle. See AgentActivityMonitor.recordSupervisorSignal.
    this.emit('disconnected', { serverName: conn.serverName, target: conn.target, bound: conn.bound } satisfies SupervisorDisconnectedEvent);
  }

  isConnected(serverName: string, target: string): boolean {
    return this.connections.has(keyFor(serverName, target));
  }

  /** True if this key's supervisor child exited (within EXITED_KEY_TTL_MS) and no new connection
   * has registered for it since. A stale (expired) entry is deleted here rather than left for the
   * next child_exit-triggered sweep — this is the more frequently-called path in practice. */
  hasRecentChildExit(serverName: string, target: string): boolean {
    const key = keyFor(serverName, target);
    const exitedAt = this.exitedKeys.get(key);
    if (exitedAt === undefined) return false;
    if (Date.now() - exitedAt >= EXITED_KEY_TTL_MS) {
      this.exitedKeys.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Clears a stale `child_exit` marker for a key ahead of a fresh supervised launch. `register()`
   * already clears it once the new supervisor completes its handshake, but sendKeys completing is
   * NOT the same moment as that handshake completing — there is a real gap between "command typed
   * into the pane" and "tui-supervisor process has started and registered with the hub". Every
   * site that starts a new supervised launch (windows/routes.ts launch-agent, WindowRespawnService,
   * ExecuteTaskUseCase, tasks/routes.ts resume) must call this immediately before sendKeys/launch,
   * so pane-loading-state doesn't suppress `supervised` (via a leftover exit marker from the
   * *previous* run on this same target) during that exact gap — which is exactly when a
   * newly-typed, not-yet-wrapped-looking raw launch command would otherwise be visible to the user.
   */
  clearExitMarker(serverName: string, target: string): void {
    this.exitedKeys.delete(keyFor(serverName, target));
  }

  snapshot(): SupervisorEntry[] {
    return [...this.connections.values()].map((conn) => ({
      serverName: conn.serverName,
      target: conn.target,
      taskId: conn.taskId,
      unitId: conn.unitId,
      pid: conn.pid,
      childCommand: conn.childCommand,
      connectedAt: conn.connectedAt,
      lastHeartbeatAt: conn.lastHeartbeatAt,
      ready: conn.ready,
      bound: conn.bound,
    }));
  }

  /**
   * Sends a hub->supervisor command and resolves once the matching ack arrives
   * (ok:true), or rejects with a `SupervisorCommandError` — check `.reason` to
   * tell an unsent command (`not_sent`, safe to retry elsewhere) apart from
   * one whose outcome is unknown after being written to the socket
   * (`ack_timeout`, NOT safe to blindly retry — it may already have been
   * applied).
   */
  sendCommand(serverName: string, target: string, cmd: SupervisorCommand): Promise<void> {
    const key = keyFor(serverName, target);
    const conn = this.connections.get(key);
    if (!conn) {
      return Promise.reject(new SupervisorCommandError(`supervisor not connected: ${key}`, 'not_sent'));
    }

    const id = randomUUID();
    const message = { ...cmd, id } as HubToSupervisorMessage;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingAcks.delete(id);
        reject(new SupervisorCommandError(`ack timeout: ${key}`, 'ack_timeout'));
      }, ACK_TIMEOUT_MS);
      timer.unref?.();
      conn.pendingAcks.set(id, { resolve, reject, timer });

      if (!this.safeSend(conn.socket, message)) {
        conn.pendingAcks.delete(id);
        clearTimeout(timer);
        reject(new SupervisorCommandError(`failed to send command: ${key}`, 'not_sent'));
      }
    });
  }

  private teardown(key: string, conn: SupervisorConnection, err: Error): void {
    this.connections.delete(key);
    this.stopPing(key);
    for (const pending of conn.pendingAcks.values()) {
      clearTimeout(pending.timer);
      // A pending ack means the command was already written to the socket
      // (see sendCommand) before this connection went away — its outcome is
      // unknown, same ambiguity as an ack timeout, so tag it that way rather
      // than as a plain (retry-safe) Error.
      pending.reject(new SupervisorCommandError(err.message, 'ack_timeout'));
    }
    conn.pendingAcks.clear();
  }

  private startPing(key: string, conn: SupervisorConnection): void {
    const timer = setInterval(() => {
      if (conn.missedPongs >= 1) {
        // No pong seen since the previous ping — two consecutive misses.
        try {
          conn.socket.terminate();
        } catch {
          // ignore — 'close' handler drives cleanup either way
        }
        return;
      }
      conn.missedPongs += 1;
      try {
        conn.socket.ping();
      } catch {
        // ignore — 'close'/'error' handler drives cleanup
      }
    }, PING_INTERVAL_MS);
    timer.unref?.();
    this.pingTimers.set(key, timer);
  }

  private stopPing(key: string): void {
    const timer = this.pingTimers.get(key);
    if (timer) clearInterval(timer);
    this.pingTimers.delete(key);
  }

  private safeSend(socket: WebSocket, msg: unknown): boolean {
    try {
      if (socket.readyState !== socket.OPEN) return false;
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private safeClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // ignore
    }
  }
}
