import { MISAO_PANE_EXITED, MISAO_PANE_NOT_FOUND, MISAO_WINDOW_NOT_FOUND, MISAO_WORKSPACE_NOT_FOUND } from './misaoErrorCodes';

/** Return only fixed text; RPC messages may contain the pane's environment. */
export function misaoFailureReason(err: unknown): string {
  const source = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; message?: unknown };
  const message = typeof source.message === 'string' ? source.message : '';
  if (source.code === 'ENOENT' || /command not found|program not found|executable not found|failed to resolve.*(?:program|executable)|(?:program|executable).*not found/i.test(message)) return 'program not found';
  switch (source.code) {
    case MISAO_PANE_NOT_FOUND: return 'pane not found';
    case MISAO_PANE_EXITED: return 'pane has exited';
    case MISAO_WORKSPACE_NOT_FOUND: return 'workspace not found';
    case MISAO_WINDOW_NOT_FOUND: return 'window not found';
    default: return 'execution failed';
  }
}
