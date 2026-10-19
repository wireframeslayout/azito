import { describe, expect, it } from 'vitest';
import { buildWindowMenuItems, type WindowMenuParams } from './windowMenuItems';

const base: WindowMenuParams = { online: true, canRenamePane: true, hasLinkedTask: false, windowName: 'main' };
const kinds = (params: WindowMenuParams) => buildWindowMenuItems(params).map((i) => i.kind);
const find = (params: WindowMenuParams, kind: string) => buildWindowMenuItems(params).find((i) => i.kind === kind);

describe('buildWindowMenuItems', () => {
  it('offers delete-pane and delete-entire-window on a pane row of a multi-pane window', () => {
    const params = { ...base, paneTarget: 's:main.2', paneOrdinal: 2, paneHandle: '%7' };
    expect(kinds(params)).toContain('delete-pane');
    expect(find(params, 'delete-window')?.labelKey).toBe('windows.deleteEntireWindow');
  });

  it('offers only delete-window on a window row', () => {
    expect(kinds(base)).not.toContain('delete-pane');
    expect(find(base, 'delete-window')?.labelKey).toBe('windows.deleteWindow');
  });

  it('offers only delete-window on a single-pane row (pane target, no ordinal)', () => {
    const params = { ...base, paneTarget: 's:main.1' };
    expect(kinds(params)).not.toContain('delete-pane');
    expect(find(params, 'delete-window')?.labelKey).toBe('windows.deleteWindow');
  });

  it('carries the ordinal and handle on delete-pane', () => {
    const item = find({ ...base, paneTarget: 's:main.2', paneOrdinal: 2, paneHandle: '%7' }, 'delete-pane');
    expect(item).toMatchObject({ paneOrdinal: 2, paneHandle: '%7', danger: true });
  });

  it('carries the ordinal on rename-pane', () => {
    expect(find({ ...base, paneTarget: 's:main.3', paneOrdinal: 3 }, 'rename-pane')?.paneOrdinal).toBe(3);
  });

  it('omits rename-pane when the mux cannot title panes', () => {
    expect(kinds({ ...base, paneTarget: 's:main.1', canRenamePane: false })).not.toContain('rename-pane');
  });

  it('disables mux actions on a stale row', () => {
    const params = { ...base, stale: true, paneTarget: 's:main.2', paneOrdinal: 2 };
    expect(find(params, 'delete-pane')?.disabled).toBe(true);
    expect(find(params, 'delete-window')?.disabled).toBe(true);
    expect(find(params, 'rename-label')?.disabled).toBeUndefined();
  });

  it('offers respawn instead of mux actions when offline', () => {
    const k = kinds({ ...base, online: false });
    expect(k).toContain('respawn');
    expect(k).not.toContain('capture-panes');
    expect(find({ ...base, online: false, sleeping: true }, 'respawn')?.labelKey).toBe('common:terminal.wake');
  });
});
