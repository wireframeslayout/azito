/**
 * プロジェクトの作成/更新/削除を、既にマウント済みの ProjectSidebar 等に即時通知するための
 * 共有イベント。CustomEvent ではなく Event で十分（detail 不要 = 対象を選ばず全再取得させる）。
 */
export const PROJECTS_CHANGED_EVENT = 'azito:projects-changed';

export function notifyProjectsChanged(): void {
  window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
}
