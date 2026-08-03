import { describe, it, expect } from 'vitest';
import { paneDisplayName, resolveActivePane } from './tmuxPane';
import type { Session } from '../pages/workspace/types';

describe('paneDisplayName', () => {
  it('returns title when different from command', () => {
    expect(paneDisplayName({ title: 'implementing-default', command: 'claude' })).toBe('implementing-default');
  });

  it('returns command when title equals command', () => {
    expect(paneDisplayName({ title: 'bash', command: 'bash' })).toBe('bash');
  });

  it('returns command when title is empty', () => {
    expect(paneDisplayName({ title: '', command: 'zsh' })).toBe('zsh');
  });
});

describe('resolveActivePane', () => {
  const sessions: Session[] = [
    {
      name: 'main',
      windows: [
        {
          index: 0,
          name: 'editor',
          panes: [
            { index: 0, title: 'vim', command: 'vim', width: 80, height: 24, active: false },
            { index: 1, title: 'implementing-default', command: 'claude', width: 80, height: 24, active: true },
          ],
        },
        {
          index: 1,
          name: 'shell',
          panes: [
            { index: 0, title: 'bash', command: 'bash', width: 80, height: 24, active: true },
          ],
        },
      ],
    },
  ];

  it('resolves active pane by window name', () => {
    const pane = resolveActivePane(sessions, 'main:editor');
    expect(pane).toEqual(sessions[0].windows[0].panes[1]);
  });

  it('resolves active pane by window index', () => {
    const pane = resolveActivePane(sessions, 'main:0');
    expect(pane).toEqual(sessions[0].windows[0].panes[1]);
  });

  it('resolves with pane index suffix', () => {
    const pane = resolveActivePane(sessions, 'main:editor.0');
    expect(pane).toEqual(sessions[0].windows[0].panes[1]);
  });

  it('returns null for unknown session', () => {
    expect(resolveActivePane(sessions, 'unknown:editor')).toBeNull();
  });

  it('returns null for unknown window', () => {
    expect(resolveActivePane(sessions, 'main:nonexistent')).toBeNull();
  });

  it('returns null for target without colon', () => {
    expect(resolveActivePane(sessions, 'main')).toBeNull();
  });

  it('falls back to pane index when no active pane', () => {
    const noActive: Session[] = [{
      name: 's',
      windows: [{
        index: 0,
        name: 'w',
        panes: [
          { index: 0, title: 'a', command: 'a', width: 80, height: 24, active: false },
          { index: 1, title: 'b', command: 'b', width: 80, height: 24, active: false },
        ],
      }],
    }];
    const pane = resolveActivePane(noActive, 's:w.1');
    expect(pane).toEqual(noActive[0].windows[0].panes[1]);
  });

  it('handles window name containing a dot', () => {
    const dotName: Session[] = [{
      name: 's',
      windows: [{
        index: 0,
        name: 'foo.1',
        panes: [
          { index: 0, title: 'dotted', command: 'bash', width: 80, height: 24, active: true },
        ],
      }],
    }];
    const pane = resolveActivePane(dotName, 's:foo.1');
    expect(pane).toEqual(dotName[0].windows[0].panes[0]);
  });

  it('falls back to first pane when no active and no pane index', () => {
    const noActive: Session[] = [{
      name: 's',
      windows: [{
        index: 0,
        name: 'w',
        panes: [
          { index: 0, title: 'first', command: 'bash', width: 80, height: 24, active: false },
        ],
      }],
    }];
    const pane = resolveActivePane(noActive, 's:w');
    expect(pane).toEqual(noActive[0].windows[0].panes[0]);
  });
});
