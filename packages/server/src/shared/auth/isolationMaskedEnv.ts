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
