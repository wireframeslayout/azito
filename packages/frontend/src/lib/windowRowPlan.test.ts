import { describe, it, expect } from 'vitest';
import { formatMuxRef } from '@azito/shared';
import type { MuxRef } from '@azito/shared';
import { planWindowRow, canRenamePane, canActOnMux } from './windowRowPlan';
import type { Pane, Session, TmuxWindow } from '../pages/workspace/types';

const ULID = 'w_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const misaoRef: MuxRef = { kind: 'misao', workspace: 'ws', window: ULID } as MuxRef;

function pane(index: number): Pane {
  return { index, title: 'bash', command: 'bash', width: 80, height: 24, active: index === 1 };
}

function win(name: string, panes: Pane[], over: Partial<TmuxWindow> = {}): TmuxWindow {
  return { index: 1, name, ref: formatMuxRef({ kind: 'tmux', workspace: 'main', window: name }), windowId: null, panes, ...over };
}

describe('planWindowRow', () => {
  it('plans a tmux window with one pane as a single row addressed by the DB target', () => {
    const sessions: Session[] = [{ name: 'main', windows: [win('win--ab12', [pane(1)])] }];
    const plan = planWindowRow({ id: 5, tmuxTarget: 'main:win--ab12.1' }, sessions);
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(plan.panes).toEqual([{ index: 1, target: 'main:win--ab12.1', menuPaneTarget: 'main:win--ab12.1' }]);
    expect(plan.clickTarget).toBe('main:win--ab12.1');
  });

  it('plans a tmux window with several panes as a multi row, with a pane target per pane', () => {
    const sessions: Session[] = [{ name: 'main', windows: [win('editor', [pane(1), pane(2)])] }];
    const plan = planWindowRow({ id: 5, tmuxTarget: 'main:editor' }, sessions);
    expect(plan.kind).toBe('multi');
    if (plan.kind !== 'multi') return;
    expect(plan.baseTarget).toBe('main:editor');
    expect(plan.clickTarget).toBe('main:editor');
    expect(plan.panes.map((p) => p.target)).toEqual(['main:editor.1', 'main:editor.2']);
  });

  it('plans a misao window (ULID target, display-name listing) by windowId as online and keeps the DB target', () => {
    const sessions: Session[] = [{ name: 'ws', windows: [win('win--xxxx', [pane(1)], { windowId: 42, ref: formatMuxRef(misaoRef) })] }];
    const plan = planWindowRow({ id: 42, tmuxTarget: `ws:${ULID}`, muxRef: misaoRef }, sessions);
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(plan.panes[0].target).toBe(`ws:${ULID}.1`);
    expect(plan.clickTarget).toBe(`ws:${ULID}.1`);
  });

  it('plans a misao window without a windowId in the listing by its muxRef', () => {
    const sessions: Session[] = [{ name: 'ws', windows: [win('shell', [pane(1), pane(2)], { ref: formatMuxRef(misaoRef) })] }];
    expect(planWindowRow({ id: 42, tmuxTarget: `ws:${ULID}`, muxRef: misaoRef }, sessions).kind).toBe('multi');
  });

  it('plans a misao window without a windowId or a muxRef as offline', () => {
    const sessions: Session[] = [{ name: 'ws', windows: [win('win--xxxx', [pane(1)], { ref: formatMuxRef(misaoRef) })] }];
    expect(planWindowRow({ id: 42, tmuxTarget: `ws:${ULID}` }, sessions).kind).toBe('offline');
  });

  it('plans a window without panes as empty and clicks it at pane 1', () => {
    const sessions: Session[] = [{ name: 'ws', windows: [win('win--xxxx', [], { windowId: 42, ref: formatMuxRef(misaoRef) })] }];
    const plan = planWindowRow({ id: 42, tmuxTarget: `ws:${ULID}`, muxRef: misaoRef }, sessions);
    expect(plan.kind).toBe('empty');
    if (plan.kind !== 'empty') return;
    expect(plan.panes).toEqual([]);
    expect(plan.clickTarget).toBe(`ws:${ULID}.1`);
  });

  it('plans a sleeping window as sleeping even when a session window matches', () => {
    const sessions: Session[] = [{ name: 'main', windows: [win('editor', [pane(1)])] }];
    expect(planWindowRow({ id: 5, tmuxTarget: 'main:editor.1', sleeping: true }, sessions).kind).toBe('sleeping');
  });

  it('plans a window whose session is gone as offline', () => {
    expect(planWindowRow({ id: 5, tmuxTarget: 'main:editor.1' }, []).kind).toBe('offline');
  });

  it('addresses menu actions by window index when the name is ambiguous in the session', () => {
    const sessions: Session[] = [{ name: 'main', windows: [win('dup', [pane(1)], { index: 0 }), win('dup', [pane(1)], { index: 1 })] }];
    const plan = planWindowRow({ id: 5, tmuxTarget: 'main:1.1' }, sessions);
    expect(plan.kind === 'single' && plan.panes[0].menuPaneTarget).toBe('main:1.1');
  });
});

describe('canRenamePane', () => {
  it('is false for a misao window and true for a tmux window or one without a muxRef', () => {
    expect(canRenamePane({ muxRef: misaoRef })).toBe(false);
    expect(canRenamePane({ muxRef: { kind: 'tmux', workspace: 'main', window: 'editor' } })).toBe(true);
    expect(canRenamePane({})).toBe(true);
  });
});

describe('stale rows (#311)', () => {
  const misaoWin = win('main', [pane(1)], { ref: formatMuxRef(misaoRef) });

  it('marks a window of a session kept from an earlier listing as stale', () => {
    const sessions: Session[] = [{ name: 'ws', kind: 'misao', stale: true, windows: [misaoWin] }];
    const plan = planWindowRow({ id: 5, tmuxTarget: `ws:${ULID}`, muxRef: misaoRef }, sessions);
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(plan.stale).toBe(true);
    expect(canActOnMux(plan)).toBe(false);
  });

  it('keeps a freshly listed window actionable', () => {
    const sessions: Session[] = [{ name: 'ws', kind: 'misao', windows: [misaoWin] }];
    const plan = planWindowRow({ id: 5, tmuxTarget: `ws:${ULID}`, muxRef: misaoRef }, sessions);
    if (plan.kind !== 'single') throw new Error(plan.kind);
    expect(plan.stale).toBe(false);
    expect(canActOnMux(plan)).toBe(true);
  });

  it('decides menu and session actions the same way', () => {
    expect(canActOnMux({ stale: true })).toBe(false);
    expect(canActOnMux({ online: true } as { stale?: boolean })).toBe(true);
    expect(canActOnMux(undefined)).toBe(true);
  });
});
