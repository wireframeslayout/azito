import { describe, expect, it } from 'vitest';
import { resolveActivityTitle, type ActivityTitleData } from '../lib/windowDisplay';

const emptyData: ActivityTitleData = { windowById: new Map(), taskById: new Map() };
const base = { windowId: 12, target: 'session:window', taskId: 2 };
const data: ActivityTitleData = {
  windowById: new Map([[12, { id: 12, serverName: 'local', tmuxTarget: 'session:window', label: 'Named', labelSource: 'user', taskId: 2 }]]),
  taskById: new Map([[2, { title: 'Current task' }]]),
};

describe('activity window titles', () => {
  it('prefers the current user label to pane and saved task titles', () => {
    expect(resolveActivityTitle({ ...base, paneName: 'Pane', taskTitle: 'Old task' }, data)).toBe('Named · W-12');
  });
  it('does not restore a saved label when the current window label was cleared', () => {
    const cleared = { ...data, windowById: new Map([[12, { id: 12, serverName: 'local', tmuxTarget: 'session:window', label: null, labelSource: 'auto' as const, taskId: 2 }]]) };
    expect(resolveActivityTitle({ ...base, label: 'Saved', labelSource: 'user' }, cleared)).toBe('Current task · W-12');
  });
  it('prefers a pane to task and type, and the current task to the saved task', () => {
    expect(resolveActivityTitle({ ...base, paneName: 'Pane', taskTitle: 'Old task' }, emptyData)).toBe('Pane · W-12');
    expect(resolveActivityTitle({ ...base, taskTitle: 'Old task', workerType: 'codex' }, { ...data, windowById: new Map() })).toBe('Current task · W-12');
    expect(resolveActivityTitle({ ...base, workerType: 'codex' }, emptyData)).toBe('Codex · W-12');
  });
  it('uses saved metadata for deleted windows and falls back to ID or target', () => {
    expect(resolveActivityTitle({ ...base, label: 'Saved', labelSource: 'user' }, { ...data, windowById: new Map() })).toBe('Saved · W-12');
    expect(resolveActivityTitle(base, emptyData)).toBe('W-12');
    expect(resolveActivityTitle({ target: 'session:window' }, emptyData)).toBe('session:window');
    expect(resolveActivityTitle({ ...base, paneTitle: '', paneName: 'Saved pane' }, emptyData)).toBe('Saved pane · W-12');
  });
});
