import type { PaneCandidate } from './transcriptTypes';

/** sessionStorage に保存するペイン選択。tmux 再起動で paneId が別ペインに再割当されうるため、
 * 復元時は全フィールドが現在の候補と一致する場合のみ選択を復元する。 */
interface StoredPaneSelection {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  currentPath: string;
}

function storageKey(sessionId: string): string {
  return `azito.transcript.selectedPane.${sessionId}`;
}

/** 保存値を読む。旧形式（paneId 単独の文字列）は JSON.parse に失敗するため自動的に破棄される。 */
function readStoredPaneSelection(sessionId: string): StoredPaneSelection | null {
  const raw = sessionStorage.getItem(storageKey(sessionId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null && typeof parsed === 'object' &&
      typeof (parsed as StoredPaneSelection).paneId === 'string' &&
      typeof (parsed as StoredPaneSelection).sessionName === 'string' &&
      typeof (parsed as StoredPaneSelection).windowIndex === 'number' &&
      typeof (parsed as StoredPaneSelection).paneIndex === 'number' &&
      typeof (parsed as StoredPaneSelection).currentPath === 'string'
    ) {
      return parsed as StoredPaneSelection;
    }
    return null;
  } catch {
    return null;
  }
}

function paneMatchesStored(pane: PaneCandidate, stored: StoredPaneSelection): boolean {
  return (
    pane.paneId === stored.paneId &&
    pane.sessionName === stored.sessionName &&
    pane.windowIndex === stored.windowIndex &&
    pane.paneIndex === stored.paneIndex &&
    pane.currentPath === stored.currentPath
  );
}

function writeStoredPaneSelection(sessionId: string, pane: PaneCandidate): void {
  const stored: StoredPaneSelection = {
    paneId: pane.paneId,
    sessionName: pane.sessionName,
    windowIndex: pane.windowIndex,
    paneIndex: pane.paneIndex,
    currentPath: pane.currentPath,
  };
  sessionStorage.setItem(storageKey(sessionId), JSON.stringify(stored));
}

/** 保存済みペイン選択のうち、現在の候補一覧に一致するものがあれば返す。 */
export function resolveStoredPaneSelection(sessionId: string, panes: PaneCandidate[]): PaneCandidate | null {
  const stored = readStoredPaneSelection(sessionId);
  if (!stored) return null;
  return panes.find((p) => paneMatchesStored(p, stored)) ?? null;
}

export { writeStoredPaneSelection };
