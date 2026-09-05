/**
 * Supervisor <-> Hub WebSocket protocol.
 *
 * NOTE: この定義は packages/tui-supervisor/src/protocol.ts と二重管理であり、
 * 変更時は必ず両方を同期させること（workspace 間 import は将来 tui-supervisor を
 * 別リポジトリへ切り出す想定のため意図的にしていない）。破壊的変更は
 * SUPERVISOR_PROTOCOL_VERSION で管理する。
 */

export const SUPERVISOR_PROTOCOL_VERSION = 1;

// ---- Supervisor -> Hub ----

export interface RegisterMessage {
  type: 'register';
  protocolVersion: number;
  serverName: string;
  target: string;
  taskId: number | null;
  unitId: number | null;
  pid: number;
  childCommand: string;
  /**
   * Marks this supervisor as one that will send a `ReadyMessage` once the child TUI finishes
   * booting. Supervisors predating this field (and thus omitting it) have no way to observe
   * boot completion, so the hub treats their connection as ready immediately on register —
   * otherwise the frontend's loading overlay would wait out its full timeout on every open for
   * a signal that never arrives. Always `true` for current builds (see HubClient); the field
   * exists so older, still-running supervisor processes keep working without a protocol bump.
   */
  reportsReady?: true;
  /**
   * Launch binding (Issue #28 Phase C, design v3 §8). Set by `tui-supervisor`
   * when it was invoked via `wrapWithSupervisor()`'s launchId/bootstrapToken
   * (passed as `AZITO_SUPERVISOR_LAUNCH_ID`/`AZITO_SUPERVISOR_BOOTSTRAP` env
   * vars, or the legacy `--launch-id`/`--bootstrap-token`/`--session-token`
   * flags for backward compat). Absent for a manually
   * started `azs` (or a supervisor process too old to know about launch
   * binding) — the hub registers those as `unbound` (display-only; see
   * SupervisorRegistry's doc comment) rather than rejecting them outright,
   * so a manual debugging session still shows up in the UI.
   */
  launchId?: string;
  /**
   * Exactly one of `bootstrapToken`/`sessionToken` accompanies `launchId`:
   * `bootstrapToken` on the FIRST register after this launch was wrapped
   * (one-shot — the hub rejects it a second time), `sessionToken` on every
   * reconnect after the hub accepted that first register (see
   * RegisteredMessage.sessionToken).
   */
  bootstrapToken?: string;
  sessionToken?: string;
  /** tmux の `$TMUX_PANE` (`%N`)。後続段階でのペイン逆引きに使う（現段階では保持のみ）。 */
  muxPaneRef?: string;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

export type ActivityState = 'active' | 'idle';

/**
 * Finer-grained agent status accompanying an 'active' state, derived from the
 * pane title (tui-supervisor's TitleStateTracker): 'blocked' = stalled on a
 * permission/confirm prompt. Optional for backward compatibility —
 * supervisors predating the title tracker (and byte-heuristic fallback mode)
 * omit it, which the hub treats as plain working.
 */
export type AgentStatus = 'working' | 'blocked';

export interface ActivityMessage {
  type: 'activity';
  state: ActivityState;
  bytesInWindow: number;
  ts: number;
  status?: AgentStatus;
}

export interface ChildExitMessage {
  type: 'child_exit';
  exitCode: number | null;
  signal: number | null;
  ts: number;
}

/**
 * Notifies the hub that the child TUI has finished booting (the ReadinessGate
 * latched). Sent exactly once per latch. If the supervisor reconnects after
 * already latching, it is re-sent when the register handshake completes (the
 * hub treats it idempotently — a duplicate is harmless).
 */
export interface ReadyMessage {
  type: 'ready';
  ts: number;
}

export interface AckMessage {
  type: 'ack';
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Confirms receipt of a freshly-issued `sessionToken` (Issue #28 third-party
 * review, Important finding — "bootstrap 失効の瞬間が来ない"). Sent by the
 * supervisor immediately after a `RegisteredMessage` carrying `sessionToken`
 * arrives, on the SAME connection that just registered with the one-shot
 * `bootstrapToken`. Until this ack lands, the hub leaves the launch `pending`
 * (bootstrap retry stays possible, e.g. across a disconnect before the ack);
 * once it lands, the hub promotes the launch to `active` — the actual moment
 * the bootstrap token retires. `sessionToken` here is the value the
 * supervisor just received; the hub verifies it hashes to the launch's
 * `session_hash` before promoting, so an ack cannot be spoofed by a party
 * that never saw the real session token. A hub predating this message type
 * simply ignores it (unknown `type`, forward-compatible); a supervisor
 * predating it never sends one, leaving the existing sessionToken-reconnect
 * promotion (see touchRegistered) as the fallback path — see
 * SupervisorRegistry.resolveLaunchAuth's sessionToken branch.
 */
export interface RegisterAckMessage {
  type: 'register_ack';
  sessionToken: string;
}

export type SupervisorToHubMessage =
  | RegisterMessage
  | HeartbeatMessage
  | ActivityMessage
  | ChildExitMessage
  | ReadyMessage
  | AckMessage
  | RegisterAckMessage;

// ---- Hub -> Supervisor ----

export interface RegisteredMessage {
  type: 'registered';
  /**
   * Returned exactly once, in the ack for a register that consumed a
   * `bootstrapToken` (a fresh launch's first register). The supervisor must
   * hold this in memory and send it as `sessionToken` on every subsequent
   * register (reconnects) for the process's lifetime — it is never re-issued.
   * Absent when the register was unbound (no launchId) or authenticated via
   * an already-valid `sessionToken`.
   */
  sessionToken?: string;
}

export interface InjectPromptMessage {
  type: 'inject_prompt';
  id: string;
  text: string;
  submit: boolean;
}

export interface SendKeysMessage {
  type: 'send_keys';
  id: string;
  keys: string[];
}

export interface InterruptMessage {
  type: 'interrupt';
  id: string;
}

export type HubToSupervisorMessage =
  | RegisteredMessage
  | InjectPromptMessage
  | SendKeysMessage
  | InterruptMessage;
