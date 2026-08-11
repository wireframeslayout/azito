import { describe, it, expect } from 'vitest';
import { processStatusKey, reconcileProcessStatus, type ProcessStatusEntry } from './agentActivityProcessSync';

function entry(overrides: Partial<ProcessStatusEntry> = {}): ProcessStatusEntry {
  return { serverName: 'local', target: 'main:1', status: 'working', ...overrides };
}

describe('reconcileProcessStatus', () => {
  it('reconciles: a previously-working key absent from the new list is dropped from workingByKey', () => {
    const prev = new Map([[processStatusKey('local', 'main:1'), entry()]]);
    const { workingByKey } = reconcileProcessStatus([], prev, new Set());
    expect(workingByKey.size).toBe(0);
  });

  it('reconciles: a previously-working key reported idle this poll is dropped from workingByKey', () => {
    const prev = new Map([[processStatusKey('local', 'main:1'), entry()]]);
    const { workingByKey } = reconcileProcessStatus([entry({ status: 'idle' })], prev, new Set());
    expect(workingByKey.size).toBe(0);
  });

  it('keeps a key in workingByKey while it stays working, with no transition emitted', () => {
    const prev = new Map([[processStatusKey('local', 'main:1'), entry()]]);
    const { workingByKey, newlyFinished } = reconcileProcessStatus([entry()], prev, new Set());
    expect(workingByKey.has(processStatusKey('local', 'main:1'))).toBe(true);
    expect(newlyFinished).toEqual([]);
  });

  it('synthesizes a finished entry on a working -> idle transition', () => {
    const prev = new Map([[processStatusKey('local', 'main:1'), entry({ taskId: 42, label: 'Task 42' })]]);
    const { newlyFinished } = reconcileProcessStatus([entry({ status: 'idle' })], prev, new Set());
    expect(newlyFinished).toEqual([
      { serverName: 'local', target: 'main:1', label: 'Task 42', taskId: 42, projectId: undefined },
    ]);
  });

  it('synthesizes a finished entry on a working -> offline transition', () => {
    const prev = new Map([[processStatusKey('local', 'main:1'), entry()]]);
    const { newlyFinished } = reconcileProcessStatus([entry({ status: 'offline' })], prev, new Set());
    expect(newlyFinished).toHaveLength(1);
  });

  it('synthesizes a finished entry when the window disappears from the response entirely', () => {
    const prev = new Map([[processStatusKey('local', 'main:1'), entry()]]);
    const { newlyFinished } = reconcileProcessStatus([], prev, new Set());
    expect(newlyFinished).toHaveLength(1);
  });

  it('does not double-count a transition already recorded by a hook-driven finish', () => {
    const key = processStatusKey('local', 'main:1');
    const prev = new Map([[key, entry()]]);
    const { newlyFinished } = reconcileProcessStatus([entry({ status: 'idle' })], prev, new Set([key]));
    expect(newlyFinished).toEqual([]);
  });

  it('only reports transitions for keys that were actually working in the previous poll', () => {
    // A key with no prior "working" history (e.g. brand new idle window) must not be
    // reported as newly-finished — there was nothing to finish.
    const { newlyFinished } = reconcileProcessStatus([entry({ status: 'idle' })], new Map(), new Set());
    expect(newlyFinished).toEqual([]);
  });

  it('handles multiple windows independently', () => {
    const prev = new Map([
      [processStatusKey('local', 'a'), entry({ target: 'a' })],
      [processStatusKey('local', 'b'), entry({ target: 'b' })],
    ]);
    const { workingByKey, newlyFinished } = reconcileProcessStatus(
      [entry({ target: 'a', status: 'working' }), entry({ target: 'b', status: 'idle' })],
      prev,
      new Set(),
    );
    expect(workingByKey.has(processStatusKey('local', 'a'))).toBe(true);
    expect(workingByKey.has(processStatusKey('local', 'b'))).toBe(false);
    expect(newlyFinished).toEqual([{ serverName: 'local', target: 'b', label: undefined, taskId: undefined, projectId: undefined }]);
  });
});
