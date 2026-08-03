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

export type SupervisorToHubMessage =
  | RegisterMessage
  | HeartbeatMessage
  | ActivityMessage
  | ChildExitMessage
  | ReadyMessage
  | AckMessage;

// ---- Hub -> Supervisor ----

export interface RegisteredMessage {
  type: 'registered';
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
