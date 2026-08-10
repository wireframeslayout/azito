import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { Chip, WindowActivityIndicator } from '../ui';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { formatRelativeTime } from '../../utils/time';
import { selectTaskTerminal } from './TaskPanel';
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

const ATTENTION_STATUSES = new Set(['waiting_input', 'pending_approval']);

interface AttentionEntry {
  task: Task;
  projectId?: number;
  updatedAtMs: number;
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
  allTasks: Task[];
  allProjects: ProjectSummary[];
  openTask: (taskId: number, title: string, projectId?: number) => void;
  connectPane: (serverName: string, target: string, projectId?: number) => void;
}

function statusLabelKey(status: string): string {
  return status === 'pending_approval' ? 'pendingApproval' : 'waitingInput';
}

export default function HomeFeed({ allTasks, allProjects, openTask, connectPane }: HomeFeedProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const { rows } = useActiveWindowRows();

  const projectById = useMemo(() => new Map(allProjects.map((p) => [p.id, p])), [allProjects]);
  const taskById = useMemo(() => new Map(allTasks.map((tk) => [tk.id, tk])), [allTasks]);

  const attentionEntries = useMemo<AttentionEntry[]>(() => {
    return allTasks
      .filter((tk) => ATTENTION_STATUSES.has(tk.status))
      .map((task) => ({ task, projectId: task.projectId, updatedAtMs: new Date(task.updatedAt).getTime() }))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }, [allTasks]);

  const activeGroups = useMemo<ActiveGroupEntry[]>(() => {
    const map = new Map<string, ActiveGroupEntry>();
    for (const row of rows) {
      if (row.status !== 'running') continue;
      const task = row.taskId != null ? taskById.get(row.taskId) : undefined;
      const groupKey = row.taskId != null ? `task:${row.taskId}` : `window:${row.key}`;
      const windowName = row.paneName || row.label || row.target;
      let group = map.get(groupKey);
      if (!group) {
        group = {
          key: groupKey,
          taskId: row.taskId,
          title: task?.title || windowName,
          projectId: row.projectId ?? task?.projectId,
          totalWindows: task?.windows?.length ?? 0,
          activeWindows: 0,
          windowNames: [],
          hasBlocked: false,
          primaryRow: row,
        };
        map.set(groupKey, group);
      }
      group.activeWindows += 1;
      group.windowNames.push(windowName);
      if (row.activityStatus === 'blocked') group.hasBlocked = true;
      // 「配下ウィンドウ」に稼働中ウィンドウが割り当てられている場合、少なくともその件数を分母に含める
      if (group.totalWindows < group.activeWindows) group.totalWindows = group.activeWindows;
    }
    return Array.from(map.values());
  }, [rows, taskById]);

  const isEmpty = attentionEntries.length === 0 && activeGroups.length === 0;

  const handleAttentionClick = (entry: AttentionEntry) => {
    openTask(entry.task.id, entry.task.title, entry.projectId);
  };

  const handleActiveGroupClick = (group: ActiveGroupEntry) => {
    if (group.taskId != null) {
      selectTaskTerminal(group.taskId, { serverName: group.primaryRow.serverName, target: group.primaryRow.target });
      openTask(group.taskId, group.title, group.projectId);
    } else {
      connectPane(group.primaryRow.serverName, group.primaryRow.target, group.projectId);
    }
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 720, padding: 'var(--space-4) var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {isEmpty ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: 'var(--text-dim)', fontSize: 'var(--font-base)', textAlign: 'center' }}>
            {t('workspace:pane.selectHint')}
          </div>
        ) : (
          <>
            {attentionEntries.length > 0 && (
              <FeedSection title={t('workspace:home.needsAttention')} count={attentionEntries.length}>
                {attentionEntries.map((entry) => (
                  <AttentionCard
                    key={entry.task.id}
                    entry={entry}
                    project={entry.projectId != null ? projectById.get(entry.projectId) : undefined}
                    onClick={() => handleAttentionClick(entry)}
                    t={t}
                  />
                ))}
              </FeedSection>
            )}

            {activeGroups.length > 0 && (
              <FeedSection title={t('workspace:home.active')} count={activeGroups.length}>
                {activeGroups.map((group) => (
                  <ActiveGroupCard
                    key={group.key}
                    group={group}
                    project={group.projectId != null ? projectById.get(group.projectId) : undefined}
                    onClick={() => handleActiveGroupClick(group)}
                    t={t}
                  />
                ))}
              </FeedSection>
            )}
          </>
        )}
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

function FeedSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <div style={{
        fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
        color: 'var(--text-dim)', padding: '0 4px 8px', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span>{title}</span>
        <span style={{ fontWeight: 400, fontSize: 'var(--font-2xs)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 'var(--radius-md)' }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </section>
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
  entry: AttentionEntry;
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
          {entry.task.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', minWidth: 0 }}>
          <ProjectMeta project={project} />
          {project && <span aria-hidden="true">·</span>}
          <span style={{ flexShrink: 0 }}>{formatRelativeTime(entry.updatedAtMs)}</span>
        </div>
      </div>
      <Chip tone="orange" style={{ flexShrink: 0 }}>
        {t(`common:status.${statusLabelKey(entry.task.status)}`)}
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
