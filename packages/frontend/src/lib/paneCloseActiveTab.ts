export function resolveActiveTabAfterPaneClose(
  prevActiveTabId: string | null,
  closedTabId: string,
  paneSuccessorTabId: string | null,
): string | null {
  if (prevActiveTabId !== closedTabId) return prevActiveTabId;
  return paneSuccessorTabId ?? prevActiveTabId;
}
