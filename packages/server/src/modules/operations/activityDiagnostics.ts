import type { IWindowRepository } from '../windows/Window';
import { isAgentWindow } from '../windows/Window';
import { stripPaneSuffix } from '../windows/paneTarget';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import type { ActivityDiagnosticEntry, AgentActivityMonitor } from './AgentActivityMonitor';

/**
 * One row of `GET /api/debug/activity`: the monitor's own per-key attribution
 * joined with the two facts it deliberately does not hold — the `windows` row's
 * id and the live supervisor connection (AgentActivityMonitor never imports
 * SupervisorRegistry; see its recordSupervisorSignal doc).
 */
export interface ActivityDiagnosticRow extends ActivityDiagnosticEntry {
  windowId?: number;
  supervisor?: {
    pid: number;
    ready: boolean;
    connectedAt: number;
    lastActivityFrameAt: number | null;
    lastReportedState: 'active' | 'idle' | null;
    lastReportedStatus: 'working' | 'blocked' | null;
  };
}

function keyOf(serverName: string, target: string): string {
  return `${serverName}::${stripPaneSuffix(target)}`;
}

/**
 * True when a Tier 0 attribution rests on evidence that predates the supervisor
 * connection currently registered for the key. A supervisor state inside the
 * monitor survives until its next signal, so after a reconnect (a supervisor
 * process restart, or the hub restarting and every supervisor re-registering)
 * the key would keep reading "decided by Tier 0" against a brand-new connection
 * that has not sent a single activity frame — the exact false reassurance this
 * panel exists to prevent. Such a row is reported as undecided instead, which
 * the UI renders as "waiting for frames".
 */
function isStaleTier0(
  entry: ActivityDiagnosticEntry,
  supervisor: { connectedAt: number } | undefined,
): boolean {
  if (entry.decidedBy !== 'tier0_supervisor') return false;
  if (!supervisor) return false;
  return entry.evidenceAt === undefined || entry.evidenceAt < supervisor.connectedAt;
}

/** working/blocked first, then stable by server + target so the live table does not jump around. */
const STATE_ORDER: Record<ActivityDiagnosticEntry['state'], number> = {
  working: 0, blocked: 1, idle: 2, offline: 3, none: 4,
};

/**
 * Read-only aggregation for the activity diagnostics panel. Adds nothing to the
 * judgment path: every value here was already computed by the last monitor tick
 * or recorded on the supervisor connection as its frames arrived.
 *
 * Supervisor connections with no monitor decision at all still produce a row —
 * that is exactly the "Tier 0 wired but silent" case the panel exists to make
 * visible (a supervisor only enters the monitor's state once it sends its first
 * activity frame).
 */
export function buildActivityDiagnostics(
  monitor: AgentActivityMonitor,
  supervisorRegistry: SupervisorRegistry,
  windowRepo: IWindowRepository,
): ActivityDiagnosticRow[] {
  const supervisors = new Map(supervisorRegistry.snapshot().map((s) => [keyOf(s.serverName, s.target), s]));

  // Same dedup rule as AgentActivityMonitor.collect(): several `windows` rows
  // can point at one tmux window; the task-owned one wins.
  const windowIds = new Map<string, number>();
  const windowTaskIds = new Map<string, number | null>();
  for (const w of windowRepo.findAll()) {
    if (!isAgentWindow(w)) continue;
    const key = keyOf(w.serverName, w.tmuxTarget);
    if (!windowIds.has(key) || (w.taskId != null && windowTaskIds.get(key) == null)) {
      windowIds.set(key, w.id);
      windowTaskIds.set(key, w.taskId);
    }
  }

  const rows: ActivityDiagnosticRow[] = monitor.diagnostics().map((entry) => {
    const key = keyOf(entry.serverName, entry.target);
    const supervisor = supervisors.get(key);
    supervisors.delete(key);
    return {
      ...entry,
      ...(isStaleTier0(entry, supervisor) ? { decidedBy: 'none' as const, state: 'none' as const } : {}),
      windowId: windowIds.get(key),
      supervisor: supervisor && {
        pid: supervisor.pid,
        ready: supervisor.ready,
        connectedAt: supervisor.connectedAt,
        lastActivityFrameAt: supervisor.lastActivityFrameAt,
        lastReportedState: supervisor.lastReportedState,
        lastReportedStatus: supervisor.lastReportedStatus ?? null,
      },
    };
  });

  for (const [key, supervisor] of supervisors) {
    rows.push({
      serverName: supervisor.serverName,
      target: stripPaneSuffix(supervisor.target),
      taskId: supervisor.taskId ?? undefined,
      state: 'none',
      decidedBy: 'none',
      windowId: windowIds.get(key),
      supervisor: {
        pid: supervisor.pid,
        ready: supervisor.ready,
        connectedAt: supervisor.connectedAt,
        lastActivityFrameAt: supervisor.lastActivityFrameAt,
        lastReportedState: supervisor.lastReportedState,
        lastReportedStatus: supervisor.lastReportedStatus ?? null,
      },
    });
  }

  return rows.sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || a.serverName.localeCompare(b.serverName)
    || a.target.localeCompare(b.target));
}
