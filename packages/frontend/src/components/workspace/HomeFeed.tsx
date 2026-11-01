import type { ActivityTitleData } from '../../lib/windowDisplay';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { Chip, WindowActivityIndicator, Button } from '../ui';
import { useLookout } from '../../hooks/useLookout';
import type { LookoutItem } from '../../lib/lookoutSummary';
import { LookoutSection } from '../lookout/LookoutSection';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { formatRelativeTime } from '../../utils/time';
import { openActivityTarget } from '../../lib/activityOpen';
import { useOpenTerminalTarget } from '../../hooks/useTerminalTargetOpener';
import type { Task } from '../../pages/workspace/types';
import { getProjectColorFallback } from '../../pages/workspace/types';

// タブ未選択時のホーム（Issue #69 Phase F-2）。「要対応」（質問待ち/承認待ちタスク）と
// 「稼働中」（稼働中ウィンドウをタスク単位に集約）の2節で構成する。全プロジェクト横断。
// 稼働判定は F-1 の useAgentActivity/useActiveWindowRows をそのまま再利用し、独自の
// ポーリングは増やさない。

/** Workspace.tsx の allProjects（useWorkspaceData 由来、プロジェクト切替メニュー用の軽量な形）に合わせた形。 */
interface ProjectSummary {
  id: number;
  name: string;
  color?: string;
}


interface ActiveGroupEntry {
  key: string;
  taskId?: number;
  title: string;
  projectId?: number;
  totalWindows: number;
  activeWindows: number;
  windowNames: string[];
  hasBlocked: boolean;
  primaryRow: ActiveWindowRow;
}

interface HomeFeedProps {
  titleData: ActivityTitleData;
  allTasks: Task[];
  allProjects: ProjectSummary[];
  openTask: (taskId: number, title: string, projectId?: number) => void;
  connectPane: (refOrServerName: import('../../lib/terminalRef').TerminalRef | string, targetOrProjectId?: string | number, projectId?: number) => void;
  /** サイドバーの「ウィンドウ」セクションを開く導線（Workspace.tsx の handleOpenAddTabFromSwitcher 相当）。
   *  「稼働中」節が空のときの「+ ウィンドウを追加」アクションから呼ぶ。 */
  onAddWindow: () => void;
}

export default function HomeFeed({ allProjects, openTask, connectPane, onAddWindow }: HomeFeedProps) {
  const openTerminal = useOpenTerminalTarget(connectPane);
  const { t } = useTranslation(['workspace', 'common', 'lookout']);
  const { sections } = useLookout();

  const projectById = useMemo(() => new Map(allProjects.map((p) => [p.id, p])), [allProjects]);
  const attentionEntries = sections.attention;
  const activeGroups: ActiveGroupEntry[] = sections.active.map((item) => ({
    key: item.key, taskId: item.task?.id ?? item.primaryRow?.taskId, title: item.title,
    projectId: item.projectId, totalWindows: item.totalWindows, activeWindows: item.activeWindows,
    windowNames: item.windowNames, hasBlocked: item.hasBlocked, primaryRow: item.primaryRow!,
  }));

  const handleAttentionClick = (entry: LookoutItem) => {
    if (entry.task) openTask(entry.task.id, entry.task.title, entry.projectId);
    else if (entry.primaryRow) openActivityTarget(
      { taskId: entry.primaryRow.taskId, windowId: entry.primaryRow.windowId, serverName: entry.primaryRow.serverName, target: entry.primaryRow.target, projectId: entry.projectId },
      entry.title, openTask, openTerminal,
    );
  };

  const handleActiveGroupClick = (group: ActiveGroupEntry) => {
    openActivityTarget(
      { taskId: group.taskId, windowId: group.primaryRow.windowId, serverName: group.primaryRow.serverName, target: group.primaryRow.target, projectId: group.projectId },
      group.title,
      openTask,
      openTerminal,
    );
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 720, padding: 'var(--space-4) var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <section aria-label={t('lookout:title')}>
          <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', fontWeight: 600 }}>{t('lookout:title')}</div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-2)', color: 'var(--text)', fontSize: 'var(--font-sm)' }}>
            <span>{t('lookout:counts.attention')}: {sections.counts.attention}</span>
            <span>{t('lookout:counts.active')}: {sections.counts.active}</span>
          </div>
        </section>
        <LookoutSection name="attention" items={attentionEntries} onOpen={handleAttentionClick} renderItem={(entry) => (
          <AttentionCard key={entry.key} entry={entry}
            project={entry.projectId != null ? projectById.get(entry.projectId) : undefined}
            onClick={() => handleAttentionClick(entry)} t={t} />
        )} />
        <LookoutSection name="active" items={sections.active} onOpen={handleAttentionClick} renderItem={(item) => {
          const group = activeGroups.find((entry) => entry.key === item.key)!;
          return <ActiveGroupCard key={group.key} group={group}
            project={group.projectId != null ? projectById.get(group.projectId) : undefined}
            onClick={() => handleActiveGroupClick(group)} t={t} />;
        }} empty={<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)',
          padding: 'var(--space-5) var(--space-4)', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('workspace:home.noActive')}</span>
          <Button size="sm" onClick={onAddWindow}><Icon name="plus" size={14} />{t('workspace:windows.addWindow')}</Button>
        </div>} />
      </div>

      <style>{`
        .hf-card { transition: background-color 0.12s ease; }
        .hf-card:hover { background: var(--bg-hover) !important; }
        .hf-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) {
          .hf-card { transition: none !important; }
        }
      `}</style>
    </div>
  );
}

function ProjectMeta({ project }: { project?: ProjectSummary }) {
  if (!project) return null;
  const color = project.color ?? getProjectColorFallback(project.id);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
    </span>
  );
}

interface AttentionCardProps {
  entry: LookoutItem;
  project?: ProjectSummary;
  onClick: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function AttentionCard({ entry, project, onClick, t }: AttentionCardProps) {
  return (
    <button
      type="button"
      className="hf-card"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer', border: 'none',
        background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '12px 16px',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', minWidth: 0 }}>
          <ProjectMeta project={project} />
          {project && <span aria-hidden="true">·</span>}
          <span style={{ flexShrink: 0 }}>{entry.task && formatRelativeTime(new Date(entry.task.updatedAt).getTime())}</span>
        </div>
      </div>
      <Chip tone="orange" style={{ flexShrink: 0 }}>
        {t(`lookout:status.${entry.status}`)}
      </Chip>
    </button>
  );
}

interface ActiveGroupCardProps {
  group: ActiveGroupEntry;
  project?: ProjectSummary;
  onClick: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

const MAX_GLYPHS = 4;

function ActiveGroupCard({ group, project, onClick, t }: ActiveGroupCardProps) {
  const shown = group.windowNames.slice(0, MAX_GLYPHS);
  const overflowCount = group.windowNames.length - shown.length;

  return (
    <button
      type="button"
      className="hf-card"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer', border: 'none',
        background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '12px 16px',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <WindowActivityIndicator status={group.hasBlocked ? 'blocked' : 'working'} />
          <span style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {group.title}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', minWidth: 0, flexWrap: 'wrap' }}>
          <ProjectMeta project={project} />
          {project && <span aria-hidden="true">·</span>}
          <span style={{ flexShrink: 0 }}>{t('workspace:home.windowsActive', { active: group.activeWindows, total: group.totalWindows })}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          {shown.map((name, i) => (
            <Chip key={i} tone="default" maxWidth={120} style={{ fontSize: 'var(--font-2xs)' }}>{name}</Chip>
          ))}
          {overflowCount > 0 && (
            <Chip tone="default" style={{ fontSize: 'var(--font-2xs)' }}>{t('workspace:home.moreWindows', { count: overflowCount })}</Chip>
          )}
        </div>
      </div>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}
