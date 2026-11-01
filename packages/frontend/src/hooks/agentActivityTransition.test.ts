import { describe, expect, it } from 'vitest';
import { snapshotToMap, transitionActivityEntries } from './useAgentActivity';
import { mergeFinishedEntry, upsertFinished } from '../lib/finishedWindows';
import type { AgentActivityPayload } from '../types/notification';

const running: AgentActivityPayload = { serverName: 'local', target: 's:w', windowId: 1, source: 'manual', operation: false, running: true, paneName: 'First' };

describe('activity transitions', () => {
  it('preserves the latest title after snapshot and consecutive events through storage', () => {
    const snapshot = snapshotToMap([running]);
    const updated = transitionActivityEntries(snapshot, { ...running, paneName: 'Latest' });
    const completed = transitionActivityEntries(updated.entries, { ...running, running: false, paneName: '', reason: 'completed' });
    const finished = mergeFinishedEntry({ serverName: 'local', target: 's:w', windowId: 1, finishedAt: 123, paneName: '' }, completed.previous);
    const reloaded = JSON.parse(JSON.stringify(upsertFinished([], finished)));
    expect(reloaded[0].paneName).toBe('Latest');
    expect(completed.entries.size).toBe(0);
  });
});
