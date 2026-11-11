import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { Chip, WindowActivityIndicator, Button } from '../ui';
import { useLookoutSummaries } from '../../hooks/useLookoutSummaries';
import { LookoutSummaryText } from '../lookout/LookoutSummaryText';
import type { LookoutSummary } from '../lookout/LookoutRow';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { useLookout } from '../../hooks/useLookout';
import type { LookoutItem } from '../../lib/lookoutSummary';
import { LookoutSection } from '../lookout/LookoutSection';
import { LookoutCounts } from '../lookout/LookoutCounts';
import { formatRelativeTime } from '../../utils/time';
import { openLookoutItem } from '../../lib/lookoutOpen';
import { useOpenTerminalTarget } from '../../hooks/useTerminalTargetOpener';
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


interface HomeFeedProps {
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
  const activityKnown = useAgentActivity().snapshotStatus === 'ready';

  const projectById = useMemo(() => new Map(allProjects.map((p) => [p.id, p])), [allProjects]);
  const attentionEntries = sections.attention;
  const summaries = useLookoutSummaries([...sections.attention, ...sections.active], true);
  const handleItemClick = (item: LookoutItem) => openLookoutItem(item, openTask, openTerminal);

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 720, padding: 'var(--space-4) var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <section aria-label={t('lookout:title')}>
          <h2 style={{ margin: 0, fontSize: 'var(--font-base)', fontWeight: 600 }}>{t('lookout:title')}</h2>
          <LookoutCounts counts={sections.counts} activityKnown={activityKnown} />
        </section>
        <LookoutSection name="attention" countKnown={activityKnown} items={attentionEntries} empty={activityKnown ? undefined : false} renderItem={(entry) => (
          <AttentionCard key={entry.key} entry={entry}
            project={entry.projectId != null ? projectById.get(entry.projectId) : undefined}
            onClick={() => handleItemClick(entry)} summary={summaries.get(entry.key)} t={t} />
        )} />
        <LookoutSection name="active" countKnown={activityKnown} items={sections.active} renderItem={(item) => <ActiveGroupCard key={item.key} group={item}
            project={item.projectId != null ? projectById.get(item.projectId) : undefined}
            onClick={() => handleItemClick(item)} summary={summaries.get(item.key)} t={t} />} empty={activityKnown ? <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)',
          padding: 'var(--space-5) var(--space-4)', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('workspace:home.noActive')}</span>
          <Button size="sm" onClick={onAddWindow}><Icon name="plus" size={14} />{t('workspace:windows.addWindow')}</Button>
        </div> : false} />
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
  summary?: LookoutSummary;
  onClick: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function AttentionCard({ entry, project, summary, onClick, t }: AttentionCardProps) {
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
        <LookoutSummaryText summary={summary} />
      </div>
      <Chip tone="orange" style={{ flexShrink: 0 }}>
        {t(`lookout:status.${entry.status}`)}
      </Chip>
    </button>
  );
}

interface ActiveGroupCardProps {
  group: LookoutItem;
  project?: ProjectSummary;
  summary?: LookoutSummary;
  onClick: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

const MAX_GLYPHS = 4;

function ActiveGroupCard({ group, project, summary, onClick, t }: ActiveGroupCardProps) {
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
        <LookoutSummaryText summary={summary} />
      </div>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}
