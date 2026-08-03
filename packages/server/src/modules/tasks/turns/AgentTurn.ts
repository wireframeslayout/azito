// ─── Agent turn domain types ───
//
// An "agent turn" is one invocation of a worker agent within a task phase (or
// a follow-up exchange). It tracks how the turn ended and how confident we
// are in that signal, independent of the transport (tmux pipe-pane vs. an
// in-process HTTP signal from `azitoctl`).

export type AgentTurnKind = 'phase' | 'follow_up';

export type AgentTurnStatus =
  | 'running'
  | 'completed'
  | 'test_failed'
  | 'questions'
  | 'failed'
  | 'aborted'
  | 'superseded';

export type AgentTurnCompletionSource =
  | 'azitoctl'
  | 'signal_file'
  | 'classifier'
  | 'probe'
  | 'timeout'
  | 'abort';

export type AgentTurnConfidence = 'explicit' | 'inferred' | 'low';

export interface AgentTurn {
  id: number;
  taskId: number;
  unitId: number | null;
  kind: AgentTurnKind;
  phase: string | null;
  nonce: string;
  status: AgentTurnStatus;
  completionSource: AgentTurnCompletionSource | null;
  confidence: AgentTurnConfidence | null;
  serverName: string | null;
  tmuxTarget: string | null;
  outputFilePath: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface AgentTurnEvent {
  id: number;
  turnId: number;
  type: string;
  payload: string | null;
  source: string;
  createdAt: string;
}

/**
 * `azitoctl` (or any external signal source) identifies the turn it is
 * reporting on via an opaque token embedded in the phase prompt, of the
 * shape `<taskId>.<turnId>.<nonce>`. The nonce doubles as a lightweight
 * anti-spoofing check (see AgentSignalService).
 */
export function buildTurnToken(turn: Pick<AgentTurn, 'taskId' | 'id' | 'nonce'>): string {
  return `${turn.taskId}.${turn.id}.${turn.nonce}`;
}

export interface ParsedTurnToken {
  taskId: number;
  turnId: number;
  nonce: string;
}

export function parseTurnToken(token: string): ParsedTurnToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [taskIdStr, turnIdStr, nonce] = parts;
  if (!/^\d+$/.test(taskIdStr) || !/^\d+$/.test(turnIdStr) || nonce.length === 0) return null;
  return { taskId: Number(taskIdStr), turnId: Number(turnIdStr), nonce };
}
