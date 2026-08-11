/**
 * Pure reconciliation logic for the process-based activity supplement
 * (`GET /api/windows/activity-status`, Issue #338 T12).
 *
 * Split out of `useAgentActivity.tsx` so it can be unit-tested directly — this project's
 * vitest config runs in a plain 'node' environment with no jsdom/@testing-library/react
 * (see `paneLayoutTree.test.ts` for the same precedent), so React-hook-shaped logic has to
 * live in a pure function to get test coverage.
 *
 * Fixes a real bug (not the hook-wiring gap, which is environment-specific — see AGENTS.md
 * "Webhooks"): windows launched without the Stop hook wired never receive a "stopped" signal
 * from `AgentActivityMonitor`, so they used to stay in the "working" list forever. This module
 * derives a "working → idle/offline" transition directly from the poll-based process-liveness
 * check, independent of the hook, so those windows still surface a finished state.
 */

export interface ProcessStatusEntry {
  serverName: string;
  target: string;
  status: 'working' | 'idle' | 'offline';
  taskId?: number;
  projectId?: number;
  label?: string;
}

export interface ProcessSyncFinishedEntry {
  serverName: string;
  target: string;
  label?: string;
  taskId?: number;
  projectId?: number;
}

export interface ProcessSyncResult {
  /** This poll's reconciled "working" set, keyed by `serverName::target` — always built fresh
   * from `list`; entries not reported as `working` this time are never carried over. */
  workingByKey: Map<string, ProcessStatusEntry>;
  /** Windows that were `working` in the previous poll and are not anymore (idle/offline/missing
   * from the response), excluding any key already present in `existingFinishedKeys` (a
   * hook-driven stop signal already recorded that finish — do not double-count it). */
  newlyFinished: ProcessSyncFinishedEntry[];
}

export function processStatusKey(serverName: string, target: string): string {
  return `${serverName}::${target}`;
}

export function reconcileProcessStatus(
  list: ProcessStatusEntry[],
  prevWorkingByKey: ReadonlyMap<string, ProcessStatusEntry>,
  existingFinishedKeys: ReadonlySet<string>,
): ProcessSyncResult {
  const workingByKey = new Map<string, ProcessStatusEntry>();
  for (const e of list) {
    if (e.status !== 'working') continue;
    workingByKey.set(processStatusKey(e.serverName, e.target), e);
  }

  const newlyFinished: ProcessSyncFinishedEntry[] = [];
  for (const [key, prevEntry] of prevWorkingByKey) {
    if (workingByKey.has(key)) continue; // still working — no transition
    if (existingFinishedKeys.has(key)) continue; // already recorded (hook-driven finish)
    newlyFinished.push({
      serverName: prevEntry.serverName,
      target: prevEntry.target,
      label: prevEntry.label,
      taskId: prevEntry.taskId,
      projectId: prevEntry.projectId,
    });
  }

  return { workingByKey, newlyFinished };
}
