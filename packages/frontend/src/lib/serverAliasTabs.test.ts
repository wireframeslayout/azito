import { describe, it, expect } from 'vitest';
import { renameServerInTabs, type AliasableTab } from './serverAliasTabs';

// TODO(#313): remove with the server alias compatibility.
const aliases = new Map([['local-misao', 'local']]);
const tab = (over: Partial<AliasableTab> & { id: string }): AliasableTab => ({ type: 'terminal', label: 'x', ...over });

describe('renameServerInTabs', () => {
  it('re-points terminal tabs (windowId and ref forms, legacy form) at the merged server', () => {
    const result = renameServerInTabs([
      tab({ id: 'terminal:local-misao::w5.1', serverName: 'local-misao', terminalRef: { kind: 'windowId', serverName: 'local-misao', windowId: 5, pane: 1 } }),
      tab({ id: 'terminal:local-misao::ref:abc.2', terminalRef: { kind: 'ref', serverName: 'local-misao', ref: 'abc', pane: 2 } }),
      tab({ id: 'terminal:local-misao/ws:main.1', serverName: 'local-misao' }),
    ], aliases);
    expect(result.changed).toBe(true);
    expect(result.tabs.map((t) => t.id)).toEqual(['terminal:local::w5.1', 'terminal:local::ref:abc.2', 'terminal:local/ws:main.1']);
    expect(result.tabs[0].terminalRef?.serverName).toBe('local');
    expect(result.tabs[0].serverName).toBe('local');
    expect(result.idMap.get('terminal:local-misao::w5.1')).toBe('terminal:local::w5.1');
  });

  it('re-points file, diff, browser and server tabs and the opener id', () => {
    const result = renameServerInTabs([
      tab({ id: 'file:local-misao:/a/b.ts', type: 'file', serverName: 'local-misao', openerTabId: 'server:local-misao' }),
      tab({ id: 'diff:local-misao:/a:HEAD', type: 'diff', diffData: { serverName: 'local-misao' } }),
      tab({ id: 'browser:local-misao/default', type: 'browser', browserData: { serverName: 'local-misao' } }),
      tab({ id: 'server:local-misao', type: 'server', label: 'local-misao', serverName: 'local-misao' }),
    ], aliases);
    expect(result.tabs.map((t) => t.id)).toEqual(['file:local:/a/b.ts', 'diff:local:/a:HEAD', 'browser:local/default', 'server:local']);
    expect(result.tabs[0].openerTabId).toBe('server:local');
    expect(result.tabs[1].diffData?.serverName).toBe('local');
    expect(result.tabs[2].browserData?.serverName).toBe('local');
    expect(result.tabs[3].label).toBe('local');
  });

  it('does not touch a server whose name merely starts with an old name, or other tabs', () => {
    const tabs = [tab({ id: 'terminal:local-misao-2::w1.1', serverName: 'local-misao-2' }), tab({ id: 'task:3', type: 'task' })];
    const result = renameServerInTabs(tabs, aliases);
    expect(result.changed).toBe(false);
    expect(result.tabs).toBe(tabs);
  });

  it('folds a renamed tab into the tab that already has the new id and reconnects it', () => {
    const result = renameServerInTabs([
      tab({ id: 'terminal:local::w5.1', serverName: 'local' }),
      tab({ id: 'terminal:local-misao::w5.1', serverName: 'local-misao' }),
    ], aliases);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]).toMatchObject({ id: 'terminal:local::w5.1', reconnectKey: 1 });
    expect(result.idMap.get('terminal:local-misao::w5.1')).toBe('terminal:local::w5.1');
  });
});
