/** misao daemon RPC error codes the hub reacts to (docs/protocol.md "Errors"). */
export const MISAO_PANE_NOT_FOUND = 1001;
/** The pane has exited (write), or was restored as `stopped` after a daemon restart (any operation needing a process). */
export const MISAO_PANE_EXITED = 1002;
/** The workspace / window named by the request does not exist (already closed). */
export const MISAO_WORKSPACE_NOT_FOUND = 1006;
export const MISAO_WINDOW_NOT_FOUND = 1007;
