/**
 * The host could not tell whether the conversation (session) a window is to resume exists: its folder could not be decided or read.
 * A respawn that cannot tell stops before the window is touched, because starting a new conversation silently would hide the loss
 * of the old one.
 */
export class ConversationCheckError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, reason: string) {
    super(`会話（${sessionId.slice(0, 8)}）のファイルがあるか確かめられないため、窓を作り直しませんでした: ${reason}`);
    this.name = 'ConversationCheckError';
    this.sessionId = sessionId;
  }
}
