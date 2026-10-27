/** Number of leading characters of a session id shown to the user. */
const SESSION_ID_DISPLAY_LENGTH = 8;

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH);
}

export class DuplicateAgentSessionError extends Error {
  readonly windowId: number;
  /** Short form of the conversation (session id) that is already running in `windowId`. */
  readonly sessionId: string;
  constructor(windowId: number, sessionId: string) {
    const sessionShort = shortSessionId(sessionId);
    super(`この窓の会話（${sessionShort}）は W-${windowId} で動作中です`);
    this.name = 'DuplicateAgentSessionError';
    this.windowId = windowId;
    this.sessionId = sessionShort;
  }
}
