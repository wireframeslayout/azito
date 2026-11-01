// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTabPersistence, type PersistedTab } from './useTabPersistence';
import { serverPathApi } from '../lib/serverPath';

const KEY = 'tab-open-test';

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(confirmDiscard?: (tabs: PersistedTab[]) => Promise<boolean>) {
  const hook = renderHook(() => useTabPersistence(KEY, { confirmDiscard }));
  act(() => {
    hook.result.current.openStorageFile(1, 'notes.md', 'notes.md', 3);
    hook.result.current.setTabDirty('storage-file:1:notes.md', true);
  });
  return hook;
}

const ids = (tabs: PersistedTab[]): string[] => tabs.map((tab) => tab.id);

afterEach(() => localStorage.clear());

describe('useTabPersistence opening a tab over unsaved edits', () => {
  it('opens nothing and keeps the dirty tab when the discard is cancelled, whatever kind of tab is opened', async () => {
    const confirmDiscard = vi.fn(async (_tabs: PersistedTab[]) => false);
    const { result } = setup(confirmDiscard);
    const opens: Array<() => void> = [
      () => result.current.openTask(7, 'Task'),
      () => result.current.openUnit(3, 'Unit'),
      () => result.current.openSettings(1, 'P'),
      () => result.current.openDiff('local', '/repo'),
      () => result.current.openBrowser('local'),
      () => result.current.openServer('local'),
      () => result.current.openProjectTasks(1, 'P'),
      () => result.current.openIssueList(1, 'o', 'r'),
      () => result.current.openTaskForm({ mode: 'create', projectId: 1 }),
      () => result.current.connectTarget('local', 'main:1'),
    ];
    for (const open of opens) await act(async () => { open(); });
    expect(confirmDiscard).toHaveBeenCalledTimes(opens.length);
    expect(confirmDiscard.mock.calls[0][0].map((tab: PersistedTab) => tab.id)).toEqual(['storage-file:1:notes.md']);
    expect(ids(result.current.tabs)).toEqual(['storage-file:1:notes.md']);
    expect(result.current.activeTabId).toBe('storage-file:1:notes.md');
  });

  it('replaces the dirty tab once the discard is confirmed', async () => {
    const { result } = setup(async () => true);
    await act(async () => { result.current.openTask(7, 'Task'); });
    expect(ids(result.current.tabs)).toEqual(['task:7']);
    expect(result.current.activeTabId).toBe('task:7');
  });

  it('keeps a tab that became dirty while the confirmation was open', async () => {
    const answer = deferred();
    const confirmDiscard = vi.fn((_tabs: PersistedTab[]) => answer.promise);
    const { result, rerender } = renderHook(({ confirm }) => useTabPersistence(KEY, { confirmDiscard: confirm }), { initialProps: { confirm: undefined as typeof confirmDiscard | undefined } });
    act(() => {
      result.current.openStorageFile(1, 'a.md', 'a.md', 1);
      result.current.setTabDirty('storage-file:1:a.md', true);
    });
    act(() => { result.current.openFile('local', '/b.ts', 1, undefined, serverPathApi('linux')); });
    rerender({ confirm: confirmDiscard });
    act(() => { result.current.openTask(7, 'Task'); });
    expect(confirmDiscard.mock.calls[0][0].map((tab: PersistedTab) => tab.id)).toEqual(['storage-file:1:a.md']);
    act(() => { result.current.setTabDirty('file:local:/b.ts', true); });
    await act(async () => { answer.resolve(true); await answer.promise; });
    expect(ids(result.current.tabs)).toEqual(['file:local:/b.ts', 'task:7']);
  });

  it('opens at once without asking when no unpinned tab is dirty', () => {
    const confirmDiscard = vi.fn(async (_tabs: PersistedTab[]) => true);
    const { result } = setup(confirmDiscard);
    act(() => { result.current.togglePin('storage-file:1:notes.md'); });
    act(() => { result.current.openTask(7, 'Task'); });
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(ids(result.current.tabs)).toEqual(['storage-file:1:notes.md', 'task:7']);
  });

  it('keeps an open form tab when reopening it is cancelled', async () => {
    const { result } = renderHook(() => useTabPersistence(KEY, { confirmDiscard: async () => false }));
    act(() => { result.current.openTaskForm({ mode: 'create', projectId: 1 }); });
    act(() => { result.current.togglePin('task-form:new:1'); });
    act(() => { result.current.openStorageFile(1, 'notes.md', 'notes.md', 3); result.current.setTabDirty('storage-file:1:notes.md', true); });
    await act(async () => { result.current.openTaskForm({ mode: 'create', projectId: 1 }); });
    expect(ids(result.current.tabs)).toEqual(['task-form:new:1', 'storage-file:1:notes.md']);
  });

  it('keeps dirty tabs open when nobody can confirm a discard', () => {
    const { result } = setup(undefined);
    act(() => { result.current.openTask(7, 'Task'); });
    expect(ids(result.current.tabs)).toEqual(['storage-file:1:notes.md', 'task:7']);
  });
});
