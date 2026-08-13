import { describe, it, expect } from 'vitest';
import { buildActivityDiagnostics } from './activityDiagnostics';
import type { ActivityDiagnosticEntry, AgentActivityMonitor } from './AgentActivityMonitor';
import type { SupervisorEntry, SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import type { IWindowRepository } from '../windows/Window';

function makeMonitor(entries: ActivityDiagnosticEntry[]): AgentActivityMonitor {
  return { diagnostics: () => entries } as unknown as AgentActivityMonitor;
}

function makeRegistry(entries: SupervisorEntry[]): SupervisorRegistry {
  return { snapshot: () => entries } as unknown as SupervisorRegistry;
}

const emptyWindows = { findAll: () => [] } as unknown as IWindowRepository;

function makeSupervisor(overrides: Partial<SupervisorEntry> = {}): SupervisorEntry {
  return {
    serverName: 'local',
    target: 'azito:agent-1',
    taskId: null,
    unitId: null,
    pid: 42,
    childCommand: 'claude',
    connectedAt: 1_000,
    lastHeartbeatAt: 1_000,
    ready: true,
    lastActivityFrameAt: null,
    lastReportedState: null,
    lastReportedStatus: null,
    ...overrides,
  };
}

const TIER0_ENTRY: ActivityDiagnosticEntry = {
  serverName: 'local',
  target: 'azito:agent-1',
  state: 'working',
  decidedBy: 'tier0_supervisor',
  evidenceAt: 900,
};

describe('buildActivityDiagnostics', () => {
  it('keeps a Tier 0 attribution whose evidence belongs to the current connection', () => {
    const rows = buildActivityDiagnostics(
      makeMonitor([{ ...TIER0_ENTRY, evidenceAt: 1_500 }]),
      makeRegistry([makeSupervisor({ connectedAt: 1_000, lastActivityFrameAt: 1_500 })]),
      emptyWindows,
    );
    expect(rows).toEqual([expect.objectContaining({ decidedBy: 'tier0_supervisor', state: 'working' })]);
  });

  it('reports a Tier 0 attribution left over from a previous connection as undecided', () => {
    // 再接続すると registry のフレーム情報はリセットされるが、monitor 側の Tier 0 状態は
    // 次のシグナルまで残る。古い接続の判定を「Tier 0 が生きている」と見せてはならない。
    const rows = buildActivityDiagnostics(
      makeMonitor([{ ...TIER0_ENTRY, evidenceAt: 900 }]),
      makeRegistry([makeSupervisor({ connectedAt: 1_000 })]),
      emptyWindows,
    );
    expect(rows).toEqual([expect.objectContaining({
      decidedBy: 'none',
      state: 'none',
      supervisor: expect.objectContaining({ lastActivityFrameAt: null }),
    })]);
  });

  it('leaves a Tier 0 attribution alone when no supervisor connection is registered for the key', () => {
    const rows = buildActivityDiagnostics(makeMonitor([TIER0_ENTRY]), makeRegistry([]), emptyWindows);
    expect(rows).toEqual([expect.objectContaining({ decidedBy: 'tier0_supervisor', supervisor: undefined })]);
  });

  it('adds a row for a connected supervisor the monitor has no decision for', () => {
    const rows = buildActivityDiagnostics(
      makeMonitor([]),
      makeRegistry([makeSupervisor({ target: 'azito:agent-2.1' })]),
      emptyWindows,
    );
    expect(rows).toEqual([expect.objectContaining({
      target: 'azito:agent-2',
      decidedBy: 'none',
      state: 'none',
    })]);
  });
});
