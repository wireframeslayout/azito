import type { TabItem } from '../ui';
import type { PersistedTab } from '../../hooks/useTabPersistence';

export interface TabGroupProjectItem {
  id: number;
  name: string;
  color?: string;
}

export interface TabGroupItem {
  tab: PersistedTab;
  item: TabItem;
  color?: string;
}

export interface TabGroup {
  projectId: number | null;
  name: string;
  color?: string;
  /** Cards to render for this group. Pinned tabs are excluded here — they are
   * already surfaced in the pinned section (buildPinnedItems) above the group
   * list, so re-listing them here would show every pinned tab twice. */
  items: Array<{ tab: PersistedTab; item: TabItem }>;
  /** Total tab count for this project, including pinned tabs (unlike
   * items.length), so the group header count matches "how many tabs does
   * this project have" rather than "how many cards are rendered below". */
  totalCount: number;
}

/**
 * Cross-project list of pinned tabs (Issue #338 T4), in `tabs` array order —
 * pinning doesn't reorder the underlying tabs array, so this preserves
 * whatever order the tabs already have (new tabs are inserted after existing
 * pinned ones; see useTabPersistence.openTab).
 */
export function buildPinnedItems(
  tabs: PersistedTab[],
  allProjects: TabGroupProjectItem[],
  buildTabItem: (tab: PersistedTab) => TabItem,
): TabGroupItem[] {
  return tabs
    .filter((tab) => tab.pinned)
    .map((tab) => {
      const project = tab.projectId != null ? allProjects.find((p) => p.id === tab.projectId) : undefined;
      return { tab, item: buildTabItem(tab), color: project?.color };
    });
}

/**
 * SP タブスイッチャー（MobileTabSwitcherSheet）用のグルーピング計算（純関数として抽出 — Issue #338）。
 *
 * タブを projectId ごとにグループ化し、既知プロジェクト（allProjects に存在する）は allProjects の
 * 順序で先頭に並べる。projectId が null のタブ、および allProjects に存在しない projectId
 * （削除済みプロジェクト・未ロードのプロジェクトなど）のタブは、グループごと落とさず「未分類」
 * フォールバック（名前は ungroupedLabel、色はグレードット相当の undefined）として必ず末尾に表示する
 * — 既知プロジェクトのみで整列していた旧実装は、未知 projectId のグループを整列ループから漏らして
 * サイレントに消してしまい、該当タブを閉じる手段もなくなるバグがあった。
 *
 * ピン中のタブは items から除外する（buildPinnedItems の節に既出のため）が、totalCount には含める。
 */
export function buildTabGroups(
  tabs: PersistedTab[],
  allProjects: TabGroupProjectItem[],
  buildTabItem: (tab: PersistedTab) => TabItem,
  ungroupedLabel: string,
): TabGroup[] {
  const byProject = new Map<number | null, TabGroup>();
  for (const tab of tabs) {
    const projectId = tab.projectId ?? null;
    let group = byProject.get(projectId);
    if (!group) {
      const project = projectId != null ? allProjects.find((p) => p.id === projectId) : undefined;
      group = {
        projectId,
        name: project?.name ?? ungroupedLabel,
        color: project?.color,
        items: [],
        totalCount: 0,
      };
      byProject.set(projectId, group);
    }
    group.totalCount += 1;
    if (!tab.pinned) group.items.push({ tab, item: buildTabItem(tab) });
  }

  // Order: groups matching a known project follow allProjects' order (stable,
  // predictable position across renders). Every remaining group — the null-projectId
  // bucket and any group whose projectId no longer matches a known project — is
  // still appended (as an "ungrouped" fallback) rather than dropped, so its tabs
  // stay reachable and closable.
  const ordered: TabGroup[] = [];
  const knownProjectIds = new Set(allProjects.map((p) => p.id));
  for (const p of allProjects) {
    const g = byProject.get(p.id);
    if (g) ordered.push(g);
  }
  for (const [projectId, group] of byProject) {
    if (projectId !== null && knownProjectIds.has(projectId)) continue; // already added above
    ordered.push(group);
  }
  return ordered;
}
