import { describe, it, expect } from 'vitest';
import type { MuxPaneInfo, MuxRef, MuxWindowInfo } from '@azito/shared';
import { paneInfoMatchesRef, windowInfoMatchesRef, windowSpecMatches } from './types';

const MISAO_WINDOW = 'w_01M3XFD8H97JCPKS5Y5BH3JZQH';
const OTHER_MISAO_WINDOW = 'w_01M3XFD8H97JCPKS5Y5BH3JZQJ';

function pane(over: Partial<MuxPaneInfo>): MuxPaneInfo {
  return { paneId: '%1', sessionName: 'main', windowIndex: 2, windowName: 'win-806', paneIndex: 0, currentPath: '/', currentCommand: 'bash', ...over };
}

function win(over: Partial<MuxWindowInfo>): MuxWindowInfo {
  return { index: 2, name: 'win-806', active: false, panes: [], activity: 0, ...over };
}

const tmuxRef = (workspace: string, window: string): MuxRef => ({ kind: 'tmux', workspace, window });

// Reference implementations: the matching logic WindowInputService / WindowSessionResolver used before refs.
const legacyPane = (p: MuxPaneInfo, ref: MuxRef): boolean => p.sessionName === ref.workspace && windowSpecMatches(ref.window, p.windowIndex, p.windowName);
const legacyWindow = (w: MuxWindowInfo, ref: MuxRef): boolean => windowSpecMatches(ref.window, w.index, w.name);

const tmuxCases: Array<{ label: string; ref: MuxRef; paneOver: Partial<MuxPaneInfo>; expected: boolean }> = [
  { label: 'window name', ref: tmuxRef('main', 'win-806'), paneOver: {}, expected: true },
  { label: 'numeric index', ref: tmuxRef('main', '2'), paneOver: {}, expected: true },
  { label: 'numeric index with pane suffix', ref: tmuxRef('main', '2.1'), paneOver: {}, expected: true },
  { label: 'window name with pane suffix', ref: tmuxRef('main', 'win-806.1'), paneOver: {}, expected: true },
  { label: 'window literally named with a dot suffix', ref: tmuxRef('main', 'foo.1'), paneOver: { windowName: 'foo.1' }, expected: true },
  { label: 'different window name', ref: tmuxRef('main', 'other'), paneOver: {}, expected: false },
  { label: 'different window index', ref: tmuxRef('main', '3'), paneOver: {}, expected: false },
  { label: 'different session', ref: tmuxRef('other', 'win-806'), paneOver: {}, expected: false },
  { label: 'empty window spec', ref: tmuxRef('main', ''), paneOver: {}, expected: false },
];

describe('paneInfoMatchesRef (tmux)', () => {
  it.each(tmuxCases)('$label -> $expected, identical to the pre-ref logic', ({ ref, paneOver, expected }) => {
    const p = pane(paneOver);
    expect(paneInfoMatchesRef(p, ref)).toBe(expected);
    expect(paneInfoMatchesRef(p, ref)).toBe(legacyPane(p, ref));
  });

  it('does not look at pane.ref for a tmux ref', () => {
    const p = pane({ ref: tmuxRef('elsewhere', 'nope') });
    expect(paneInfoMatchesRef(p, tmuxRef('main', 'win-806'))).toBe(true);
    expect(paneInfoMatchesRef(pane({}), tmuxRef('elsewhere', 'nope'))).toBe(false);
  });
});

describe('windowInfoMatchesRef (tmux)', () => {
  it.each(tmuxCases)('$label, identical to the pre-ref logic', ({ ref, paneOver }) => {
    const w = win({ name: paneOver.windowName ?? 'win-806' });
    expect(windowInfoMatchesRef(w, ref)).toBe(legacyWindow(w, ref));
  });
});

describe('paneInfoMatchesRef (misao)', () => {
  const ref: MuxRef = { kind: 'misao', workspace: 'proj', window: MISAO_WINDOW };

  it('matches a pane whose ref carries the same window id', () => {
    expect(paneInfoMatchesRef(pane({ ref: { kind: 'misao', workspace: 'proj', window: MISAO_WINDOW } }), ref)).toBe(true);
  });

  it('matches regardless of the workspace name in the pane ref', () => {
    expect(paneInfoMatchesRef(pane({ ref: { kind: 'misao', workspace: 'renamed', window: MISAO_WINDOW } }), ref)).toBe(true);
  });

  it('does not match another window id', () => {
    expect(paneInfoMatchesRef(pane({ ref: { kind: 'misao', workspace: 'proj', window: OTHER_MISAO_WINDOW } }), ref)).toBe(false);
  });

  it('does not match a pane without a ref, even when its tmux-shaped fields look equal', () => {
    expect(paneInfoMatchesRef(pane({ sessionName: 'proj', windowName: MISAO_WINDOW }), ref)).toBe(false);
  });

  it('does not match a tmux-kind pane ref', () => {
    expect(paneInfoMatchesRef(pane({ ref: tmuxRef('proj', MISAO_WINDOW) }), ref)).toBe(false);
  });
});

describe('windowInfoMatchesRef (misao)', () => {
  const ref: MuxRef = { kind: 'misao', workspace: 'proj', window: MISAO_WINDOW };

  it('matches by window id and rejects other ids or a missing ref', () => {
    expect(windowInfoMatchesRef(win({ ref: { kind: 'misao', workspace: 'proj', window: MISAO_WINDOW } }), ref)).toBe(true);
    expect(windowInfoMatchesRef(win({ ref: { kind: 'misao', workspace: 'proj', window: OTHER_MISAO_WINDOW } }), ref)).toBe(false);
    expect(windowInfoMatchesRef(win({ name: MISAO_WINDOW }), ref)).toBe(false);
  });
});

describe('tmux refs never match misao panes or windows of a merged listing (#311)', () => {
  const misaoPaneRef: MuxRef = { kind: 'misao', workspace: 'main', window: MISAO_WINDOW };

  it('rejects a misao pane in a same-named workspace whose window index and name equal the tmux window', () => {
    const misaoPane = pane({ paneId: 'p_01M3XFD8H97JCPKS5Y5BH3JZQK', ref: misaoPaneRef });
    expect(paneInfoMatchesRef(misaoPane, tmuxRef('main', 'win-806'))).toBe(false);
    expect(paneInfoMatchesRef(misaoPane, tmuxRef('main', '2'))).toBe(false);
  });

  it('tells a misao pane listed without a ref by its handle shape', () => {
    expect(paneInfoMatchesRef(pane({ paneId: 'p_01M3XFD8H97JCPKS5Y5BH3JZQK' }), tmuxRef('main', 'win-806'))).toBe(false);
    expect(paneInfoMatchesRef(pane({ paneId: '%9' }), tmuxRef('main', 'win-806'))).toBe(true);
  });

  it('rejects a misao window for a tmux ref', () => {
    expect(windowInfoMatchesRef(win({ ref: misaoPaneRef }), tmuxRef('main', 'win-806'))).toBe(false);
    expect(windowInfoMatchesRef(win({ ref: tmuxRef('main', 'win-806') }), tmuxRef('main', 'win-806'))).toBe(true);
  });

  it('keeps a tmux pane from matching a misao ref', () => {
    expect(paneInfoMatchesRef(pane({ ref: tmuxRef('main', 'win-806') }), misaoPaneRef)).toBe(false);
  });
});
