// ─── Isolation credential mask (single source) ───
//
// Issue #29 review, Critical finding 1: `TmuxClient.uiTokenEnvForServer` and
// `TaskPaneEnvironmentService.applyTokenMaskingOrCompat` each hand-wrote
// their own `isolationIntent` mask independently — `uiTokenEnvForServer` only
// masked `AZITO_UI_TOKEN`, leaving `AZITO_AGENT_TOKEN` to leak into an
// isolated `agent`-type server's manual session/window/pane (and plain
// respawn) panes via tmux session-env inheritance (see
// `TaskPaneEnvironmentService`'s doc comment on why an explicit empty value,
// not omission, is required to override an inherited key). Both call sites —
// plus `buildServer.ts`'s `buildSecondaryWindowEnv` "task not found" fallback
// — now reference this ONE constant so the masked key set can never drift
// between them again.
//
// Every key AZITO's tmux panes are ever asked to carry that authenticates
// something (hub UI, hub<->agent-server) belongs here. Adding a new
// credential env var to either injection path means adding it here too.
export const ISOLATION_MASKED_ENV: Readonly<Record<string, string>> = Object.freeze({
  AZITO_UI_TOKEN: '',
  AZITO_AGENT_TOKEN: '',
});

/**
 * {@link ISOLATION_MASKED_ENV} plus the hub webhook token, for an ISOLATED server only. The webhook token is not in
 * the shared mask on purpose: a non-isolated server under scoped auth also applies that mask to task panes, and
 * there the hub-injected webhook token must stay (tui-supervisor reads it from the env). A driver that does not
 * isolate a pane from its parent's env (misao: the daemon's own env) or a session env that already carries the
 * token would otherwise hand it to an isolated pane.
 */
export const ISOLATION_HUB_SECRET_MASK: Readonly<Record<string, string>> = Object.freeze({
  ...ISOLATION_MASKED_ENV,
  AZITO_WEBHOOK_TOKEN: '',
});
