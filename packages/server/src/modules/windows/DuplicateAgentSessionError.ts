export class DuplicateAgentSessionError extends Error {
  readonly windowId: number;
  /** The full id of the conversation (session) that is already running in `windowId`. */
  readonly sessionId: string;
  constructor(windowId: number, sessionId: string) {
    super(`この窓の会話（${sessionId.slice(0, 8)}）は W-${windowId} で動作中です`);
    this.name = 'DuplicateAgentSessionError';
    this.windowId = windowId;
    this.sessionId = sessionId;
  }
}
