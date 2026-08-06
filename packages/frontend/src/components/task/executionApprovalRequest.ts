/**
 * Race-condition guard for TaskPanel's execution-approval fetch/submit flow
 * (Issue #328 review). GET /api/tasks/:id/execution-approval had no
 * cancellation or generation tracking: switching between two
 * `pending_approval` tasks in quick succession let whichever request
 * happened to RESOLVE LAST win, regardless of which task was requested
 * first — so `approvalData` (and therefore the taskId the Approve/Deny
 * buttons submit against) could end up holding a DIFFERENT task than the
 * one on screen. Approval is a record of human judgment, so submitting it
 * against the wrong task is not a display glitch, it's a correctness bug.
 *
 * Extracted as plain state (no React) so this exact guard logic can be unit
 * tested without mounting TaskPanel's full render tree — mirroring
 * taskPaneLayout.ts, which was extracted from this same component for the
 * same reason.
 */
export class ApprovalRequestTracker {
  private requestId = 0;

  /**
   * Call when starting a new fetch. Returns the id to capture in the
   * fetch's closure and pass back to {@link isCurrent} when it resolves.
   */
  begin(): number {
    this.requestId += 1;
    return this.requestId;
  }

  /**
   * Call when the task stops being `pending_approval` (or the component
   * unmounts) — invalidates any fetch already in flight, so a response that
   * arrives after the fact cannot apply itself to state that has since
   * moved on.
   */
  invalidate(): void {
    this.requestId += 1;
  }

  /**
   * True if `requestId` (captured from a prior {@link begin}) is still the
   * most recent request, i.e. its response is safe to apply. False for a
   * superseded (stale) request — its response must be discarded, not
   * merged with or overwritten onto whatever the current request already
   * produced.
   */
  isCurrent(requestId: number): boolean {
    return requestId === this.requestId;
  }
}

/**
 * Second, independent guard checked immediately before submitting an
 * approval/denial decision (Issue #328 review — "defense in depth" beside
 * {@link ApprovalRequestTracker}): even if a stale GET response somehow made
 * it into state, the fetched data's own `taskId` is compared against the
 * task actually displayed at submit time, and a mismatch refuses to submit.
 */
export function isApprovalDataForTask(approvalData: { taskId: number } | null, displayedTaskId: number | null | undefined): boolean {
  return approvalData !== null && approvalData.taskId === displayedTaskId;
}
