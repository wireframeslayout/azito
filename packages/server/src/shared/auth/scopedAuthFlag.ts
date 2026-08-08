// ─── AZITO_SCOPED_AUTH flag resolution ───
//
// Single source for reading the staged-migration flag (design v3 §12) —
// previously computed inline in buildServer.ts alone; Issue #28 Phase A
//後半 needs the SAME value inside app/wiring.ts too (TaskPaneEnvironmentService
// decides whether to inject AZITO_UI_TOKEN/AZITO_AGENT_TOKEN based on it,
// and is constructed before buildServer.ts runs). Reading process.env in two
// places risked the two copies drifting (`'1'` vs `'true'` etc.) — this
// function is the one place that decides, called once at the boundary
// (main.ts's composition root) and threaded through as a resolved boolean
// from there on (Resolve at the Boundary).
export function resolveScopedAuthEnabled(): boolean {
  return process.env.AZITO_SCOPED_AUTH === '1' || process.env.AZITO_SCOPED_AUTH === 'true';
}
