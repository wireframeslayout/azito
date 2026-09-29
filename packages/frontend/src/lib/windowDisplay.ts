/**
 * オブジェクト一覧のウィンドウ行の表示テキスト（主表示・検索対象）を決める（純関数）。
 *
 * 主表示はペインタイトル（例: claude がペインに出す「libghostty の wasm 版導入検討」の
 * ような動的タイトル）。tmux はタイトル未設定のペインで実行コマンド名を返すため、
 * `paneTitle` がコマンド名そのものの場合は「タイトルなし」とみなす。
 *
 * 取得できないとき（オフライン・タイトル空）のフォールバックは
 * ウィンドウラベル → タスクタイトル → tmux ターゲット の順。
 */

import { formatWindowId, isInternalWindowName, stripGeneratedSuffix } from '@azito/shared';

/**
 * ペインの実タイトル（エージェントが設定した動的タイトル）。タイトル未設定のペインでは
 * tmux がコマンド名を返すため、その場合は「タイトルなし」として undefined を返す。
 */
export function resolvePaneDisplayTitle(paneTitle?: string, paneCommand?: string): string | undefined {
  const title = paneTitle?.trim();
  if (!title || title === paneCommand?.trim()) return undefined;
  return title;
}

export interface WindowDisplayInput {
  paneTitle?: string;
  paneCommand?: string;
  label?: string;
  taskTitle?: string;
  tmuxTarget?: string;
  windowId?: number;
  workerType?: string;
  windowType?: string;
}

export interface WindowDisplay {
  title: string;
  idLabel?: string;
  hasDisplayName: boolean;
}

export const TYPE_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  generic: 'Terminal',
  terminal: 'Terminal',
};

export interface WindowIndexEntry {
  id: number;
  serverName: string;
  tmuxTarget: string;
  label?: string;
  workerType?: string;
  windowType?: string;
  taskId?: number;
}

export function buildWindowIndex<T extends WindowIndexEntry>(
  allProjects: Array<{ windows?: T[] }>,
  allTasks: Array<{ windows?: T[] }>,
  currentProject?: { windows: T[] } | null,
): Map<number, T> {
  const map = new Map<number, T>();
  for (const p of allProjects) {
    for (const w of p.windows ?? []) map.set(w.id, w);
  }
  for (const t of allTasks) {
    for (const w of t.windows ?? []) map.set(w.id, w);
  }
  if (currentProject) {
    for (const w of currentProject.windows) map.set(w.id, w);
  }
  return map;
}

export function formatWindowDisplayLabel(display: WindowDisplay): string {
  return display.hasDisplayName && display.idLabel
    ? `${display.title} · ${display.idLabel}`
    : display.title;
}

export function resolveWindowDisplay(i: WindowDisplayInput): WindowDisplay {
  const idLabel = i.windowId != null ? formatWindowId(i.windowId) : undefined;
  const paneDisplay = resolvePaneDisplayTitle(i.paneTitle, i.paneCommand);
  if (paneDisplay) return { title: paneDisplay, idLabel, hasDisplayName: true };

  const label = i.label?.trim();
  if (label && !isInternalWindowName(label)) {
    return { title: stripGeneratedSuffix(label), idLabel, hasDisplayName: true };
  }

  const taskTitle = i.taskTitle?.trim();
  if (taskTitle) return { title: taskTitle, idLabel, hasDisplayName: true };

  const typeLabel = (i.workerType && TYPE_LABEL[i.workerType]) || (i.windowType && TYPE_LABEL[i.windowType]);
  if (typeLabel) return { title: typeLabel, idLabel, hasDisplayName: true };

  if (idLabel) return { title: idLabel, idLabel: undefined, hasDisplayName: false };

  return { title: i.tmuxTarget ?? '', idLabel, hasDisplayName: false };
}

/**
 * ActiveWindowRow (稼働中ウィンドウ行) のフィールドから表示ラベルを組み立てる。
 * `paneName` をペインタイトルとして `resolveWindowDisplay` に渡し、
 * `formatWindowDisplayLabel` で「表示名 · W-123」形式に整形する。
 */
export function formatActiveWindowLabel(row: {
  windowId?: number;
  label?: string;
  paneName?: string;
  taskTitle?: string;
  workerType?: string;
  windowType?: string;
  target?: string;
}): string {
  const display = resolveWindowDisplay({
    windowId: row.windowId,
    paneTitle: row.paneName,
    label: row.label,
    taskTitle: row.taskTitle,
    workerType: row.workerType,
    windowType: row.windowType,
    tmuxTarget: row.target,
  });
  return formatWindowDisplayLabel(display);
}
