import type { TerminalRef } from './terminalRef';

/**
 * Re-points saved tabs at the server a merged server's old name now stands for (migration 079 on the hub,
 * `aliases` in GET /api/servers).
 *
 * TODO(#313): compatibility for one release only; remove with the server-side `server_aliases` table.
 */
export interface AliasableTab {
  id: string;
  type: string;
  label: string;
  serverName?: string;
  terminalRef?: TerminalRef;
  diffData?: { serverName: string };
  browserData?: { serverName: string };
  openerTabId?: string;
  reconnectKey?: number;
}

/** Id prefixes that embed a server name, and the character that ends the name (`''` = the name ends the id). */
const SERVER_ID_FORMS: ReadonlyArray<{ prefix: string; separators: readonly string[] }> = [
  { prefix: 'terminal:', separators: ['/', '::'] },
  { prefix: 'file:', separators: [':'] },
  { prefix: 'diff:', separators: [':'] },
  { prefix: 'browser:', separators: ['/'] },
  { prefix: 'server:', separators: [''] },
];

function renameId(id: string, aliases: ReadonlyMap<string, string>): string {
  for (const { prefix, separators } of SERVER_ID_FORMS) {
    if (!id.startsWith(prefix)) continue;
    for (const [oldName, newName] of aliases) {
      for (const separator of separators) {
        const head = `${prefix}${oldName}${separator}`;
        if (id === head || (separator !== '' && id.startsWith(head))) return `${prefix}${newName}${id.slice(prefix.length + oldName.length)}`;
      }
    }
  }
  return id;
}

function renameTab<T extends AliasableTab>(tab: T, aliases: ReadonlyMap<string, string>): T {
  const id = renameId(tab.id, aliases);
  const resolve = (name: string): string => aliases.get(name) ?? name;
  const renamed: T = { ...tab, id };
  if (tab.serverName !== undefined) renamed.serverName = resolve(tab.serverName);
  if (tab.terminalRef) renamed.terminalRef = { ...tab.terminalRef, serverName: resolve(tab.terminalRef.serverName) };
  if (tab.diffData) renamed.diffData = { ...tab.diffData, serverName: resolve(tab.diffData.serverName) };
  if (tab.browserData) renamed.browserData = { ...tab.browserData, serverName: resolve(tab.browserData.serverName) };
  if (tab.type === 'server' && tab.serverName !== undefined) renamed.label = resolve(tab.label);
  if (tab.openerTabId !== undefined) renamed.openerTabId = renameId(tab.openerTabId, aliases);
  return renamed;
}

/**
 * `idMap` lists the id renames (the active tab and the pane layout follow them). When the renamed id already
 * belongs to another tab, that tab is kept and reconnected, and the renamed one is folded into it.
 */
export function renameServerInTabs<T extends AliasableTab>(
  tabs: T[],
  aliases: ReadonlyMap<string, string>,
): { tabs: T[]; changed: boolean; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const renamedIds = new Set<string>();
  const renamed = tabs.map((tab) => {
    const next = renameTab(tab, aliases);
    if (next.id !== tab.id) { idMap.set(tab.id, next.id); renamedIds.add(tab.id); }
    return next;
  });
  const sameServer = (a: T, b: T): boolean => a.serverName === b.serverName && a.terminalRef?.serverName === b.terminalRef?.serverName;
  const changed = renamed.some((tab, i) => tab.id !== tabs[i].id || !sameServer(tab, tabs[i]) || tab.label !== tabs[i].label);
  if (!changed) return { tabs, changed: false, idMap };

  const seen = new Map<string, number>();
  const result: T[] = [];
  renamed.forEach((tab, i) => {
    const existing = seen.get(tab.id);
    if (existing === undefined) {
      seen.set(tab.id, result.length);
      result.push(tab);
      return;
    }
    // Keep the tab that already had this id (not the renamed one), reconnected.
    const keepOriginal = !renamedIds.has(tabs[i].id);
    const kept = keepOriginal ? tab : result[existing];
    result[existing] = { ...kept, reconnectKey: (kept.reconnectKey ?? 0) + 1 };
  });
  return { tabs: result, changed: true, idMap };
}
