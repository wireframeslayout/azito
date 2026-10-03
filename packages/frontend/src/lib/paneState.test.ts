import { describe, expect, it } from 'vitest';
import { isPaneLive, paneStateChip, preferredPaneOrdinal } from './paneState';

const pane = (index: number, processState?: 'running' | 'exited' | 'stopped' | 'unknown') => ({ index, processState });

describe('isPaneLive', () => {
  it('treats a pane without processState (tmux) as live', () => {
    expect(isPaneLive(pane(1))).toBe(true);
  });
  it('treats running and unknown as live, stopped and exited as not', () => {
    expect(isPaneLive(pane(1, 'running'))).toBe(true);
    expect(isPaneLive(pane(1, 'unknown'))).toBe(true);
    expect(isPaneLive(pane(1, 'stopped'))).toBe(false);
    expect(isPaneLive(pane(1, 'exited'))).toBe(false);
  });
});

describe('paneStateChip', () => {
  it('names stopped and exited panes only', () => {
    expect(paneStateChip(pane(1, 'stopped'))).toBe('stopped');
    expect(paneStateChip(pane(1, 'exited'))).toBe('exited');
    expect(paneStateChip(pane(1, 'running'))).toBeNull();
    expect(paneStateChip(pane(1, 'unknown'))).toBeNull();
    expect(paneStateChip(pane(1))).toBeNull();
  });
});

describe('preferredPaneOrdinal', () => {
  it('picks the first running pane', () => {
    expect(preferredPaneOrdinal({ panes: [pane(1, 'stopped'), pane(2, 'running'), pane(3, 'running')] })).toBe(2);
  });
  it('falls back to the first pane when none is running', () => {
    expect(preferredPaneOrdinal({ panes: [pane(1, 'stopped'), pane(2, 'exited')] })).toBe(1);
  });
  it('picks the first pane for a driver that reports no state', () => {
    expect(preferredPaneOrdinal({ panes: [pane(1), pane(2)] })).toBe(1);
  });
  it('returns null for an empty window', () => {
    expect(preferredPaneOrdinal({ panes: [] })).toBeNull();
  });
});
