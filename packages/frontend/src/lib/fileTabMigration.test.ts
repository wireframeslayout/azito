import { describe, expect, it } from 'vitest';
import type { HostPathApi } from '@azito/shared';
import { normalizeFileTabs, type MigratableFileTab } from './fileTabMigration';
import { serverPathApi } from './serverPath';

const win = serverPathApi('win32');
const posix = serverPathApi('linux');

const fileTab = (server: string, filePath: string, extra: Partial<MigratableFileTab> = {}): MigratableFileTab => ({
  id: `file:${server}:${filePath}`, type: 'file', label: filePath.split(/[\\/]/).pop() ?? filePath, serverName: server, filePath, ...extra,
});

/** `win` is a Windows server, `nix` a Unix one, anything else is not in the list yet. */
const known = (name: string): HostPathApi | null => (name === 'win' ? win : name === 'nix' ? posix : null);

describe('normalizeFileTabs', () => {
  it('moves a saved Windows file tab to the normalized path, id and label', () => {
    const { tabs, changed, idMap } = normalizeFileTabs([fileTab('win', 'C:/work/app/a.ts')], known);
    expect(changed).toBe(true);
    expect(tabs).toEqual([{ id: 'file:win:C:\\work\\app\\a.ts', type: 'file', label: 'a.ts', serverName: 'win', filePath: 'C:\\work\\app\\a.ts' }]);
    expect(idMap).toEqual(new Map([['file:win:C:/work/app/a.ts', 'file:win:C:\\work\\app\\a.ts']]));
  });

  it('leaves POSIX tabs, other tab types and tabs of servers not reported yet alone', () => {
    const input: MigratableFileTab[] = [
      fileTab('nix', '/work//app/./a.ts'),
      fileTab('pending', 'C:/work/a.ts'),
      { id: 'task:1', type: 'task', label: 't' },
    ];
    const result = normalizeFileTabs(input, known);
    expect(result.changed).toBe(false);
    expect(result.tabs).toBe(input);
    expect(result.idMap.size).toBe(0);
  });

  it('waits for a server, then moves its tabs when it is reported', () => {
    const input = [fileTab('late', 'C:/x/a.ts')];
    expect(normalizeFileTabs(input, known).changed).toBe(false);
    const later = (name: string): HostPathApi | null => (name === 'late' ? win : null);
    expect(normalizeFileTabs(input, later).tabs[0].id).toBe('file:late:C:\\x\\a.ts');
  });

  it('folds tabs of one file into the one that already had the normalized id, pinned if either was', () => {
    const { tabs, idMap } = normalizeFileTabs([
      fileTab('win', 'C:/work/a.ts', { pinned: true }),
      fileTab('win', 'C:\\work\\a.ts'),
      fileTab('win', 'C:\\work\\b.ts'),
    ], known);
    expect(tabs.map((t) => t.id)).toEqual(['file:win:C:\\work\\a.ts', 'file:win:C:\\work\\b.ts']);
    expect(tabs[0].pinned).toBe(true);
    // the active tab, the openers and the layout follow the renamed id to the kept tab
    expect(idMap.get('file:win:C:/work/a.ts')).toBe('file:win:C:\\work\\a.ts');
  });

  it('points openers at the renamed ids', () => {
    const { tabs } = normalizeFileTabs([
      fileTab('win', 'C:/work/a.ts'),
      fileTab('nix', '/w/b.ts', { openerTabId: 'file:win:C:/work/a.ts' }),
    ], known);
    expect(tabs[1].openerTabId).toBe('file:win:C:\\work\\a.ts');
  });

  it('is done after one pass', () => {
    const once = normalizeFileTabs([fileTab('win', 'C:/work/a.ts')], known).tabs;
    expect(normalizeFileTabs(once, known).changed).toBe(false);
  });
});
