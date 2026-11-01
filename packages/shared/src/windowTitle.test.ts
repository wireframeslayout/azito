import { describe, expect, it } from 'vitest';
import { formatWindowTitle, resolveWindowTitle } from './windowTitle';

describe('window title', () => {
  it('prioritizes a user label and exposes the next candidate', () => {
    expect(resolveWindowTitle({ windowId: 4, label: 'custom', labelSource: 'user', paneTitle: 'working', taskTitle: 'task' }))
      .toEqual({ title: 'custom', subtitle: 'working', idLabel: 'W-4', hasDisplayName: true });
  });
  it('uses a dynamic pane title ahead of an auto label, ignoring commands', () => {
    expect(resolveWindowTitle({ label: 'editor--ab12', paneTitle: 'working', paneCommand: 'bash' }).title).toBe('working');
    expect(resolveWindowTitle({ label: 'editor--ab12', paneTitle: 'bash', paneCommand: 'bash' }).title).toBe('editor');
  });
  it('ignores internal names and formats the ID once', () => {
    const display = resolveWindowTitle({ label: 'win--6t61', windowId: 42 });
    expect(formatWindowTitle(display)).toBe('W-42');
    expect(formatWindowTitle(resolveWindowTitle({ windowId: 42, workerType: 'claude' }))).toBe('Claude · W-42');
  });
  it('falls back to the target for unregistered windows', () => {
    expect(resolveWindowTitle({ tmuxTarget: 'main:0' }).title).toBe('main:0');
  });
});
