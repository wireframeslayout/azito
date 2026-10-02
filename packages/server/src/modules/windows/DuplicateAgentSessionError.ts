export class DuplicateAgentSessionError extends Error {
  readonly windowId: number;
  constructor(windowId: number, message?: string) {
    super(message ?? `この会話は W-${windowId} で動作中です`);
    this.name = 'DuplicateAgentSessionError';
    this.windowId = windowId;
  }
}
