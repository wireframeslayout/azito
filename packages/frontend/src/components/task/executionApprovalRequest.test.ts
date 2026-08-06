import { describe, it, expect } from 'vitest';
import { ApprovalRequestTracker, isApprovalDataForTask } from './executionApprovalRequest';

// Issue #328 review — TaskPanel's execution-approval GET had no
// cancellation/generation tracking, so switching between two
// pending_approval tasks quickly let whichever request resolved LAST win,
// regardless of request order. These tests exercise ApprovalRequestTracker
// in isolation (the exact guard TaskPanel.tsx's fetchApprovalData wires up)
// against every ordering that used to produce a wrong result.

describe('ApprovalRequestTracker', () => {
  it('a lone request is current when it resolves', () => {
    const tracker = new ApprovalRequestTracker();
    const requestId = tracker.begin();
    expect(tracker.isCurrent(requestId)).toBe(true);
  });

  it('an OLDER request is no longer current once a NEWER one has begun — even if the older one resolves LAST (the actual race)', () => {
    const tracker = new ApprovalRequestTracker();
    const taskAId = tracker.begin(); // fetch for task A starts first
    const taskBId = tracker.begin(); // user switches to task B before A resolves

    // Task B's response arrives first — still current.
    expect(tracker.isCurrent(taskBId)).toBe(true);
    // Task A's response arrives AFTER B's — this is the bug scenario: without
    // the guard, A's late response would overwrite B's already-applied data.
    expect(tracker.isCurrent(taskAId)).toBe(false);
  });

  it('a request started before invalidate() is never current again, even with no new request', () => {
    const tracker = new ApprovalRequestTracker();
    const requestId = tracker.begin();
    tracker.invalidate(); // e.g. task navigated away from pending_approval
    expect(tracker.isCurrent(requestId)).toBe(false);
  });

  it('re-fetching the SAME task (e.g. after a fingerprint_mismatch refetch) still supersedes the earlier in-flight request for that task', () => {
    const tracker = new ApprovalRequestTracker();
    const first = tracker.begin();
    const second = tracker.begin(); // re-fetch triggered before `first` resolved
    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
  });

  it('three interleaved requests (A, B, C) resolving out of order — only the LAST STARTED is ever current', () => {
    const tracker = new ApprovalRequestTracker();
    const a = tracker.begin();
    const b = tracker.begin();
    const c = tracker.begin();
    // Simulate resolution order B, A, C (arbitrary network timing).
    expect(tracker.isCurrent(b)).toBe(false);
    expect(tracker.isCurrent(a)).toBe(false);
    expect(tracker.isCurrent(c)).toBe(true);
  });
});

describe('isApprovalDataForTask', () => {
  it('true when the fetched approval data belongs to the currently displayed task', () => {
    expect(isApprovalDataForTask({ taskId: 42 }, 42)).toBe(true);
  });

  it('false when approvalData belongs to a DIFFERENT task than what is displayed (the submit-time guard)', () => {
    expect(isApprovalDataForTask({ taskId: 42 }, 43)).toBe(false);
  });

  it('false when there is no approval data yet', () => {
    expect(isApprovalDataForTask(null, 42)).toBe(false);
  });

  it('false when no task is displayed at all', () => {
    expect(isApprovalDataForTask({ taskId: 42 }, undefined)).toBe(false);
    expect(isApprovalDataForTask({ taskId: 42 }, null)).toBe(false);
  });
});
