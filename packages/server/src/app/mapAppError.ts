import { MuxDriverUnavailableError, MuxOperationUnsupportedError } from '../modules/tmux/MuxCapabilityError';
import { HostProfileError } from '../shared/os/hostProfile';
import { AgentUnreachableError } from '../modules/servers/transport/AgentUnreachableError';
import { ConversationCheckError } from '../modules/agents/ConversationCheckError';
import { GitNotFoundError } from '../shared/exec/commandSpec';

export interface AppErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Maps domain errors that have a dedicated HTTP answer; null means "use the default error handler". */
export function mapAppError(err: unknown): AppErrorResponse | null {
  if (err instanceof MuxDriverUnavailableError) {
    return { status: 503, body: { error: 'mux_driver_unavailable', kind: err.kind, reason: err.reason } };
  }
  if (err instanceof AgentUnreachableError) {
    return { status: 503, body: { error: 'agent_unreachable', server: err.serverName, reason: err.reason } };
  }
  if (err instanceof MuxOperationUnsupportedError) {
    return { status: 501, body: { error: 'mux_operation_unsupported', kind: err.kind, operation: err.operation } };
  }
  if (err instanceof HostProfileError) {
    // `error` is the reason in words, like the other install routes answer: the UI shows it as it is. `code` is `unsupported_os` / `unsupported_host`.
    return { status: 501, body: { error: err.message, code: err.code } };
  }
  if (err instanceof ConversationCheckError) {
    // A respawn stopped before the window was touched because the conversation it would resume could not be looked up: the reason is the message.
    return { status: 409, body: { error: 'conversation_unverifiable', sessionId: err.sessionId, message: err.message } };
  }
  if (err instanceof GitNotFoundError) {
    // Same shape as the host-OS reasons above: the reason (with how to install Git for Windows) in `error`, `git_not_found` in `code`.
    return { status: 501, body: { error: err.message, code: 'git_not_found' } };
  }
  return null;
}
