/**
 * Supervisor <-> Hub WebSocket protocol.
 *
 * NOTE: この定義は hub 側 packages/server/src/modules/supervisors/protocol.ts と
 * 二重管理であり、変更時は必ず両方を同期させること。workspace 間 import は、
 * 将来 tui-supervisor を別リポジトリへ切り出す想定のため意図的にしていない。
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
   * Launch binding (Issue #28 Phase C, design v3 §8). Set when this process
   * was invoked with the `AZITO_SUPERVISOR_LAUNCH_ID`/`AZITO_SUPERVISOR_BOOTSTRAP`
   * env vars (or the legacy `--launch-id`/`--bootstrap-token` flags, or
   * `--session-token` on a reconnect). Absent for a manually started `azs` — the hub registers
   * those as `unbound` (display-only).
   */
  launchId?: string;
  /**
   * Exactly one of `bootstrapToken`/`sessionToken` accompanies `launchId`:
   * `bootstrapToken` on the FIRST register after this launch was wrapped
   * (one-shot), `sessionToken` on every reconnect after (see
   * RegisteredMessage.sessionToken).
   */
  bootstrapToken?: string;
  sessionToken?: string;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

export type ActivityState = 'active' | 'idle';

/**
 * Finer-grained agent status accompanying an 'active' state, derived from the
 * pane title (TitleStateTracker): 'blocked' = stalled on a permission/confirm
 * prompt. Optional for backward compatibility — supervisors predating the
 * title tracker (and byte-heuristic fallback mode) omit it, which the hub
 * treats as plain working.
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
 * review, Important finding). Sent immediately after a `RegisteredMessage`
 * carrying `sessionToken` arrives, on the same connection that just
 * registered with the one-shot `bootstrapToken` — see the hub-side copy of
 * this doc comment (packages/server/.../protocol.ts) for the full rationale.
 * A hub predating this message type simply ignores it (forward-compatible).
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
   * `bootstrapToken`. Must be held in memory and sent as `sessionToken` on
   * every subsequent register for this process's lifetime.
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
