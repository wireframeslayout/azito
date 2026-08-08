/**
 * `operator_required` 403 handling (Issue #28 Phase D-1).
 *
 * The browser normally authenticates with `AZITO_UI_TOKEN` (principal class
 * `operator`), which `evaluateRouteAuth()` (server-side) always lets through
 * regardless of a route's declared `auth.classes` — so this 403 is not part
 * of any expected browser flow. It surfaces only when the browser's stored
 * token is, in fact, shaped like a task token (`azt.task.<taskId>.<secret>`)
 * — e.g. a human pasted one into `TokenGate` by mistake, thinking it was the
 * UI token (`TokenGate` accepts free-form text with no format check). That
 * is an anomaly to report, not a flow to design a screen around: a toast
 * naming the blocked operation is sufficient (design doc: "新しい画面は作らない").
 *
 * Kept as a pure predicate + a `window` event dispatch (same event-bus
 * pattern as `api/token.ts`'s `azito:token-changed`) so `api/client.ts` — a
 * plain module, not a React component — can report the condition without
 * depending on `useToast`'s React context. `ToastProvider` is the sole
 * subscriber, wired in `useToast.tsx`.
 */

export const OPERATOR_REQUIRED_EVENT = 'azito:operator-required';

export interface OperatorRequiredEventDetail {
  operation: string;
}

/** Narrows an already-parsed JSON response body to the `operator_required` 403 shape buildServer.ts's onRequest hook sends. */
export function isOperatorRequiredError(status: number, body: unknown): body is { error: 'operator_required'; operation: string } {
  if (status !== 403) return false;
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return b['error'] === 'operator_required' && typeof b['operation'] === 'string';
}

export function dispatchOperatorRequired(operation: string): void {
  window.dispatchEvent(new CustomEvent<OperatorRequiredEventDetail>(OPERATOR_REQUIRED_EVENT, { detail: { operation } }));
}

/** Checks an API response's (status, parsed body) and dispatches the event when it matches — the single call site every `api/client.ts` helper routes through. */
export function reportIfOperatorRequired(status: number, body: unknown): void {
  if (isOperatorRequiredError(status, body)) {
    dispatchOperatorRequired(body.operation);
  }
}
