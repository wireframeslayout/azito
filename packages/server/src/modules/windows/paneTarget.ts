/**
 * Mirrors the frontend's `packages/frontend/src/utils/tmuxTarget.ts` pane-suffix stripping rule
 * exactly, so a window/supervisor lookup here agrees with what the terminal UI considers "the
 * same window" (a stored tmuxTarget may itself carry a pane suffix — e.g. task windows are
 * stored as `session:window.1` — while a pane-qualified request target for any pane on that
 * window should still match). Duplicated rather than imported: server and frontend are separate
 * workspace packages with no shared-utility boundary for something this small.
 */
const PANE_SUFFIX_RE = /\.\d+$/;

export function stripPaneSuffix(target: string): string {
  return target.replace(PANE_SUFFIX_RE, '');
}

export function isSameWindowTarget(a: string, b: string): boolean {
  return stripPaneSuffix(a) === stripPaneSuffix(b);
}
