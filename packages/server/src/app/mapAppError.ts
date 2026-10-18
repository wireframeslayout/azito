import { MuxDriverUnavailableError, MuxOperationUnsupportedError } from '../modules/tmux/MuxCapabilityError';
import { AgentUnreachableError } from '../modules/servers/transport/AgentUnreachableError';

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
  return null;
}
