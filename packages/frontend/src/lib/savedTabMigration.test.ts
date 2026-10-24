import { describe, expect, it } from 'vitest';
import type { HostPathApi } from '@azito/shared';
import { composeTabMigrations, type TabMigrationStep } from './savedTabMigration';
import { isFileTabSettled, normalizeFileTabs, type MigratableFileTab } from './fileTabMigration';
import { renameServerInTabs } from './serverAliasTabs';
import { serverPathApi } from './serverPath';

const win = serverPathApi('win32');
const pathApiFor = (name: string): HostPathApi | null => (name === 'win' ? win : null);

type Tab = MigratableFileTab & { label: string };
const fileTab = (server: string, filePath: string, extra: Partial<Tab> = {}): Tab => ({
  id: `file:${server}:${filePath}`, type: 'file', label: filePath, serverName: server, filePath, ...extra,
});

// The two steps the Workspace composes for these tests: server aliases, then Windows file paths.
const stepsFor = (aliases: Map<string, string>): TabMigrationStep<Tab>[] => [
  (tabs) => renameServerInTabs(tabs, aliases),
  (tabs) => normalizeFileTabs(tabs, pathApiFor),
];

describe('composeTabMigrations: server aliases and Windows file paths', () => {
  const aliases = new Map([['old-win', 'win']]);

  it('moves a tab under an old server name through the rename and then to its normalized path', () => {
    const { tabs, idMap } = composeTabMigrations([fileTab('old-win', 'C:/work/a.ts')], stepsFor(aliases));
    expect(tabs.map((t) => [t.id, t.serverName, t.filePath])).toEqual([['file:win:C:\\work\\a.ts', 'win', 'C:\\work\\a.ts']]);
    expect(idMap.get('file:old-win:C:/work/a.ts')).toBe('file:win:C:\\work\\a.ts');
  });

  it('applies both when both change something in the same pass, without one overwriting the other', () => {
    const input = [
      fileTab('old-win', 'C:/work/a.ts'), // renamed, then normalized
      fileTab('win', 'C:/work/b.ts'), // normalized only
      fileTab('old-win', 'C:\\work\\c.ts'), // renamed only
    ];
    const { tabs, changed } = composeTabMigrations(input, stepsFor(aliases));
    expect(changed).toBe(true);
    expect(tabs.map((t) => t.id)).toEqual(['file:win:C:\\work\\a.ts', 'file:win:C:\\work\\b.ts', 'file:win:C:\\work\\c.ts']);
  });

  it('folds an old-name tab into the tab of the same file under the current name', () => {
    const { tabs, idMap } = composeTabMigrations([fileTab('win', 'C:\\work\\a.ts'), fileTab('old-win', 'C:/work/a.ts')], stepsFor(aliases));
    expect(tabs.map((t) => t.id)).toEqual(['file:win:C:\\work\\a.ts']);
    expect(idMap.get('file:old-win:C:/work/a.ts')).toBe('file:win:C:\\work\\a.ts');
  });

  it('maps both original ids of two tabs folded into one, whichever of them was the survivor', () => {
    const oldTab = 'file:old-win:C:/x/a.ts';
    const currentTab = 'file:win:C:/x/a.ts';
    const { tabs, idMap } = composeTabMigrations([fileTab('old-win', 'C:/x/a.ts'), fileTab('win', 'C:/x/a.ts')], stepsFor(aliases));
    expect(tabs.map((t) => t.id)).toEqual(['file:win:C:\\x\\a.ts']);
    // the active tab (either one) and the pane layout (either one's pane) find the survivor
    expect(idMap.get(oldTab)).toBe('file:win:C:\\x\\a.ts');
    expect(idMap.get(currentTab)).toBe('file:win:C:\\x\\a.ts');
  });

  it('leaves ids that did not change out of the map', () => {
    const { idMap } = composeTabMigrations([fileTab('win', 'C:\\x\\a.ts'), fileTab('old-win', 'C:\\x\\b.ts')], stepsFor(aliases));
    expect([...idMap.keys()]).toEqual(['file:old-win:C:\\x\\b.ts']);
  });

  it('is idempotent: a second pass over the result changes nothing', () => {
    const first = composeTabMigrations([fileTab('old-win', 'C:/work/a.ts'), fileTab('win', 'C:/work/b.ts')], stepsFor(aliases));
    const second = composeTabMigrations(first.tabs, stepsFor(aliases));
    expect(second.changed).toBe(false);
    expect(second.tabs).toBe(first.tabs);
  });

  it('waits for a server whose OS is not reported, then finishes in a later pass', () => {
    const first = composeTabMigrations([fileTab('old-pending', 'C:/x/a.ts')], stepsFor(new Map()));
    expect(first.changed).toBe(false);
    // the alias shows up in a later list, and the renamed tab then gets its path settled in that same pass
    const later = composeTabMigrations(first.tabs, stepsFor(new Map([['old-pending', 'win']])));
    expect(later.tabs[0].id).toBe('file:win:C:\\x\\a.ts');
  });

  it('reports the ids a step dropped', () => {
    const drop: TabMigrationStep<Tab> = (tabs) => ({ tabs: tabs.slice(1), changed: true, idMap: new Map(), dropped: new Set([tabs[0].id]) });
    const { dropped } = composeTabMigrations([fileTab('nix', '/a')], [drop]);
    expect(dropped).toEqual(new Set(['file:nix:/a']));
  });
});

describe('isFileTabSettled', () => {
  it('is false until the server OS is known and the tab is in that OS form', () => {
    expect(isFileTabSettled(fileTab('win', 'C:/work/a.ts'), null)).toBe(false);
    expect(isFileTabSettled(fileTab('win', 'C:/work/a.ts'), win)).toBe(false);
    expect(isFileTabSettled(fileTab('win', 'C:\\work\\a.ts'), win)).toBe(true);
  });

  it('is true for a POSIX tab as soon as the OS is known, whatever its string', () => {
    expect(isFileTabSettled(fileTab('nix', '/work//app/./a.ts'), serverPathApi('linux'))).toBe(true);
  });

  it('stays false for a tab under an old server name (not in the list), until the rename', () => {
    expect(isFileTabSettled(fileTab('old-win', 'C:\\work\\a.ts'), pathApiFor('old-win'))).toBe(false);
  });
});
