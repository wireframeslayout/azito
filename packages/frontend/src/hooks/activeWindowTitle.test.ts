import { describe, expect, it } from 'vitest';
import { resolveActivityTitle } from '../lib/windowDisplay';

describe('activity window titles', () => {
  it('uses current window and task metadata for finished entries', () => {
    const row = { windowId: 1, target: 'session:window', taskId: 2, taskTitle: 'Old task' };
    const data = { windowById: new Map([[1, { id: 1, serverName: 'local', tmuxTarget: 'session:window', label: 'Named', labelSource: 'user' as const, taskId: 2 }]]), tasks: [{ id: 2, title: 'Current task' }] };
    expect(resolveActivityTitle(row, data)).toContain('Named');
  });

  it('uses saved pane name and supports missing window data', () => {
    expect(resolveActivityTitle({ windowId: 1, target: 'session:window', paneName: 'Saved pane' })).toContain('Saved pane');
  });
});
