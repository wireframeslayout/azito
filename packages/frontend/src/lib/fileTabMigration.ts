import type { HostPathApi } from '@azito/shared';
import { fileDisplayName, fileTabPath } from './serverPath';

export interface MigratableFileTab {
  id: string;
  type: string;
  label: string;
  pinned?: boolean;
  serverName?: string;
  filePath?: string;
  openerTabId?: string;
}

/**
 * File tabs saved before a Windows server's paths were normalized are keyed by the string they were opened with
 * (`C:/x/a.ts`), so the same file opened again (`C:\x\a.ts`) would be a second tab. Once a server's OS is known this
 * moves its saved file tabs to the normalized path, id and label. POSIX tabs, and tabs of a server whose OS is not
 * known yet, are left alone.
 *
 * `idMap` lists the id renames, which the active tab, the openers and the pane layout follow. Tabs that end up with
 * one id are folded into one: the tab that already had that id stays (pinned if either was).
 */
export function normalizeFileTabs<T extends MigratableFileTab>(
  tabs: T[],
  pathApiFor: (serverName: string) => HostPathApi | null,
): { tabs: T[]; changed: boolean; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const moved = tabs.map((tab) => {
    if (tab.type !== 'file' || tab.serverName === undefined || tab.filePath === undefined) return tab;
    const api = pathApiFor(tab.serverName);
    if (!api) return tab;
    const filePath = fileTabPath(api, tab.filePath);
    const id = `file:${tab.serverName}:${filePath}`;
    if (filePath === tab.filePath && id === tab.id) return tab;
    if (id !== tab.id) idMap.set(tab.id, id);
    return { ...tab, id, filePath, label: fileDisplayName(api, filePath) };
  });
  if (moved.every((tab, i) => tab === tabs[i])) return { tabs, changed: false, idMap };

  const result: T[] = [];
  const indexById = new Map<string, number>();
  moved.forEach((tab, i) => {
    const existing = indexById.get(tab.id);
    if (existing === undefined) {
      indexById.set(tab.id, result.length);
      result.push(tab);
      return;
    }
    // Two tabs for one file: the one that already had this id stays.
    const keptIsOriginal = tabs[i].id === tab.id;
    const kept = keptIsOriginal ? tab : result[existing];
    result[existing] = { ...kept, pinned: kept.pinned || result[existing].pinned || tab.pinned || undefined };
  });
  const followed = result.map((tab) => {
    const opener = tab.openerTabId !== undefined ? idMap.get(tab.openerTabId) : undefined;
    return opener === undefined ? tab : { ...tab, openerTabId: opener };
  });
  return { tabs: followed, changed: true, idMap };
}
