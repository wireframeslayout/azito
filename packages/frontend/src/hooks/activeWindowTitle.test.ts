import { describe, expect, it } from 'vitest';
import { resolveActivityTitle, type ActivityTitleData } from '../lib/windowDisplay';

const base = { windowId: 12, target: 'session:window', taskId: 2 };
const data: ActivityTitleData = {
  windowById: new Map([[12, { id: 12, serverName: 'local', tmuxTarget: 'session:window', label: 'Named', labelSource: 'user', taskId: 2 }]]),
  tasks: [{ id: 2, title: 'Current task' }],
};

describe('activity window titles', () => {
  it('prefers the current user label to pane and saved task titles', () => {
    expect(resolveActivityTitle({ ...base, paneName: 'Pane', taskTitle: 'Old task' }, data)).toBe('Named · W-12');
  });
  it('prefers a pane to task and type, and the current task to the saved task', () => {
    expect(resolveActivityTitle({ ...base, paneName: 'Pane', taskTitle: 'Old task' })).toBe('Pane · W-12');
    expect(resolveActivityTitle({ ...base, taskTitle: 'Old task', workerType: 'codex' }, { ...data, windowById: new Map() })).toBe('Current task · W-12');
    expect(resolveActivityTitle({ ...base, workerType: 'codex' })).toBe('Codex · W-12');
  });
  it('uses saved metadata for deleted windows and falls back to ID or target', () => {
    expect(resolveActivityTitle({ ...base, label: 'Saved', labelSource: 'user' }, { ...data, windowById: new Map() })).toBe('Saved · W-12');
    expect(resolveActivityTitle(base)).toBe('W-12');
    expect(resolveActivityTitle({ target: 'session:window' })).toBe('session:window');
    expect(resolveActivityTitle({ ...base, paneTitle: '', paneName: 'Saved pane' })).toBe('Saved pane · W-12');
  });
});
