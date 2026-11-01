import { describe, expect, it } from 'vitest';
import { formatWindowTitleLine, resolveWindowTitle } from './windowTitle';

describe('window title', () => {
  it('prioritizes a user label and exposes the next candidate', () => {
    expect(resolveWindowTitle({ id: 4, label: 'custom', labelSource: 'user', paneTitle: 'working', taskTitle: 'task' }))
      .toEqual({ title: 'custom', subtitle: 'working', idLabel: 'W-4', hasDisplayName: true });
  });
  it('uses a dynamic pane title ahead of an auto label, ignoring commands', () => {
    expect(resolveWindowTitle({ label: 'editor--ab12', paneTitle: 'working', paneCommand: 'bash' }).title).toBe('working');
    expect(resolveWindowTitle({ label: 'editor--ab12', paneTitle: 'bash', paneCommand: 'bash' }).title).toBe('editor');
  });
  it('ignores internal names and formats the ID once', () => {
    const display = resolveWindowTitle({ label: 'win--6t61', id: 42 });
    expect(formatWindowTitleLine(display)).toBe('W-42');
    expect(formatWindowTitleLine(resolveWindowTitle({ id: 42, workerType: 'claude' }))).toBe('Claude · W-42');
  });
  it('falls back to the target for unregistered windows', () => {
    expect(resolveWindowTitle({ tmuxTarget: 'main:0' }).title).toBe('main:0');
  });
  it('uses available activity fields in priority order', () => {
    expect(formatWindowTitleLine(resolveWindowTitle({ id: 10, paneTitle: 'building', tmuxTarget: 'azito:0' }))).toBe('building · W-10');
    expect(formatWindowTitleLine(resolveWindowTitle({ id: 10, workerType: 'claude' }))).toBe('Claude · W-10');
    expect(formatWindowTitleLine(resolveWindowTitle({ id: 5, label: 'my-window' }))).toBe('my-window · W-5');
    expect(formatWindowTitleLine(resolveWindowTitle({ id: 7, taskTitle: 'Deploy fix' }))).toBe('Deploy fix · W-7');
    expect(formatWindowTitleLine(resolveWindowTitle({ id: 10, label: 'task-42--ab12', taskTitle: 'Bug fix' }))).toBe('Bug fix · W-10');
  });
});
