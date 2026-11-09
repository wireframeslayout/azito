import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useWakeWindow } from '../../hooks/useWakeWindow';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { useOrchestrationLinks, type LinkTarget } from '../../hooks/useOrchestrationLinks';
import { useVisibleIds } from '../../hooks/useVisibleIds';
import { useWindowSnapshots } from '../../hooks/useWindowSnapshots';
import { useWorkspaceCatalog } from '../../hooks/useWorkspaceCatalog';
import { buildAttentionContext, countAttention, orchestratorStatus, type OrchestratorNode } from '../../lib/orchestrationModel';
import { acknowledgeLinkedCompletion, isLinkedCompletionAcknowledged, groupLinkedWindows, resolveLinkedWindows, type LinkedFilter } from '../../lib/linkedWindowsModel';
import type { Server, Session, Window } from '../../pages/workspace/types';
import { Button } from '../ui/Button';
import { SegmentedToggle } from '../ui/SegmentedToggle';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { AddLinkPopover, type LinkCandidate } from './AddLinkPopover';
import { LinkedGroup } from './LinkedGroup';
import { LinkedSnapshot } from './LinkedSnapshot';
import { formatRelativeTime } from '../../utils/time';
import { ChildOrchestratorCard } from './ChildOrchestratorCard';
import { LinkedWindowCard } from './LinkedWindowCard';

interface Props { windowId: number; enabled: boolean; onOpen: (window: Window) => void; onExpand: (window: Window) => void; onProject: (id: number) => void; excludedWindowIds: number[]; children: OrchestratorNode[]; onEnter: (id: number) => void; onWindowOrder?: (windows: Window[]) => void }

export function LinkedPanel({ windowId, enabled, onOpen, onExpand, onProject, excludedWindowIds, children, onEnter, onWindowOrder }: Props) {
  const { t } = useTranslation('workspace');
  const { links, loading, error, refresh, add, unlink, undo } = useOrchestrationLinks(windowId);
  const { allTasks, allProjects, projectsLoaded, error: catalogError, refresh: refreshCatalog } = useWorkspaceCatalog();
  const wake = useWakeWindow();
  const [waking, setWaking] = useState<number | null>(null);
  const [wakeError, setWakeError] = useState(false);
  const { windows: orchestrators } = useOrchestrators();
  const { entries, snapshotStatus } = useAgentActivity();
  const previousAttention = useRef<Set<number> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focused, setFocused] = useState(false);
  const previousOrder = useRef<number[]>([]);
  const [filter, setFilter] = useState<LinkedFilter>('all');
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [sessionCandidates, setSessionCandidates] = useState<LinkCandidate[]>([]);
  const [candidateError, setCandidateError] = useState(false);
  const candidateRequest = useRef(0);
  useEffect(() => () => { candidateRequest.current++; }, []);
  const openAdd = () => {
    setAdding(true); setCandidateError(false);
    const version = ++candidateRequest.current;
    void api<Server[]>('/servers').then(async servers => {
      if (!Array.isArray(servers)) throw new Error('invalid_server_list');
      const responses = await Promise.allSettled(servers.map(async server => ({ server, sessions: await api<Session[]>(`/servers/${encodeURIComponent(server.name)}/sessions`) })));
      if (version !== candidateRequest.current) return;
      setCandidateError(responses.some(response => response.status === 'rejected' || !Array.isArray(response.value.sessions)));
      setSessionCandidates(responses.flatMap(response => response.status === 'fulfilled' && Array.isArray(response.value.sessions) ? response.value.sessions.flatMap(session => session.windows.flatMap(window => typeof window.windowId !== 'number' ? [] : [{ key: `window:${window.windowId}`, label: window.name, target: { targetWindowId: window.windowId }, group: response.value.server.name }])) : []));
    }).catch(() => { if (version === candidateRequest.current) setCandidateError(true); });
  };
  const [, setAcknowledgementVersion] = useState(0);
  const [removed, setRemoved] = useState<LinkTarget | null>(null);
  const { visibleIds, register } = useVisibleIds(root);
  const windows = [...new Map([...allProjects.flatMap(project => project.windows ?? []), ...allTasks.flatMap(task => task.windows ?? []), ...orchestrators].map(window => [window.id, window])).values()];
  const childById = new Map(children.map(child => [child.window.id, child]));
  const items = resolveLinkedWindows(links, [...windows, ...children.map(child => child.window)], allTasks, allProjects, buildAttentionContext(entries, allTasks)).map(item => {
    const child = item.link.resolvedWindowId === null ? undefined : childById.get(item.link.resolvedWindowId);
    return child && countAttention(child) !== null && countAttention(child)! > 0 ? { ...item, status: 'attention' as const } : item;
  });
  const attentionKey = items.filter(item => item.status === 'attention').map(item => item.link.id).sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (loading || !projectsLoaded || catalogError || snapshotStatus !== 'ready') return;
    const next = new Set(attentionKey ? attentionKey.split(',').map(Number) : []);
    if (previousAttention.current) { const changed = items.find(item => next.has(item.link.id) && !previousAttention.current!.has(item.link.id)); if (changed) setAnnouncement(t('linkedPanel.attentionAnnouncement', { id: changed.link.resolvedWindowId ?? changed.link.resolvedTaskId, name: changed.task?.title ?? changed.window?.label ?? t('linkedPanel.attention'), reason: changed.task?.status ? t(`linkedPanel.reason_${changed.task.status}`, { defaultValue: t('linkedPanel.reason_blocked') }) : t('linkedPanel.reason_blocked') })); }
    previousAttention.current = next;
  }, [attentionKey, loading, projectsLoaded, catalogError, snapshotStatus, t]);
  const attentionIds = items.filter(item => item.status === 'attention' && item.window && !childById.has(item.window.id) && visibleIds.has(item.link.id)).map(item => item.window!.id).sort((a, b) => a - b);
  const normalIds = items.filter(item => item.status !== 'attention' && item.window && !childById.has(item.window.id) && !attentionIds.includes(item.window.id) && visibleIds.has(item.link.id)).map(item => item.window!.id).sort((a, b) => a - b);
  const attention = useWindowSnapshots(enabled ? [...new Set(attentionIds)] : [], { enabled, intervalMs: 2000 });
  const normal = useWindowSnapshots(enabled ? [...new Set(normalIds)] : [], { enabled, intervalMs: 3000 });
  const groups = groupLinkedWindows(items.map(item => { const activity = item.window ? (attention.snapshots.get(item.window.id) ?? normal.snapshots.get(item.window.id))?.activity : null; return activity ? { ...item, lastActivityAt: new Date(activity * 1000).toISOString() } : item; }), filter);
  if (focused) {
    const index = (id: number) => { const position = previousOrder.current.indexOf(id); return position < 0 ? Number.MAX_SAFE_INTEGER : position; };
    for (const group of groups) group.items.sort((a, b) => index(a.link.id) - index(b.link.id));
    groups.sort((a, b) => index(a.items[0].link.id) - index(b.items[0].link.id));
  } else previousOrder.current = groups.flatMap(group => group.items.map(item => item.link.id));
  const order = groups.flatMap(group => group.items.flatMap(item => item.window ? [item.window] : []));
  const orderKey = order.map(window => window.id).join(',');
  useEffect(() => { onWindowOrder?.(order); }, [orderKey, onWindowOrder]);
  const candidates = [...new Map(([
    ...sessionCandidates,
    ...windows.map(window => ({ key: `window:${window.id}`, label: window.label || window.tmuxTarget, target: { targetWindowId: window.id }, group: window.serverName })),
    ...allTasks.map(task => ({ key: `task:${task.id}`, label: task.title, target: { taskId: task.id }, group: allProjects.find(project => project.id === task.projectId)?.name ?? String(task.projectId) })),
  ] satisfies LinkCandidate[]).map(candidate => [candidate.key, candidate])).values()];
  const targets = links.flatMap<LinkTarget>(link => [...(link.taskId !== null ? [{ taskId: link.taskId }] : []), ...(link.resolvedTaskId !== null ? [{ taskId: link.resolvedTaskId }] : []), ...(link.targetWindowId !== null ? [{ targetWindowId: link.targetWindowId }] : []), ...(link.resolvedWindowId !== null ? [{ targetWindowId: link.resolvedWindowId }] : [])]);
  const countRunning = (node: OrchestratorNode): number => (orchestratorStatus(node.window, entries) === 'active' ? 1 : 0) + node.children.reduce((total, child) => total + countRunning(child), 0);
  const wakeWindow = async (window: Window): Promise<void> => {
    setWaking(window.id); setWakeError(false);
    try {
      const mux = await wake.choose(window.id, window.label || window.tmuxTarget);
      if (!mux) return;
      const result = await api<{ ok: boolean; tmuxTarget?: string }>(`/windows/${window.id}/respawn`, { method: 'POST', body: JSON.stringify({ force: false, mux }) });
      if (!result.tmuxTarget) throw new Error('wake_failed');
      await refreshCatalog();
    } catch { setWakeError(true); } finally { setWaking(null); }
  };
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      <SegmentedToggle ariaLabel={t('linkedPanel.title')} wrap value={filter} onChange={setFilter} options={(['all', 'attention', 'running', 'completed'] as const).map(value => ({ value, label: `${t(`linkedPanel.${value}`)} ${value === 'all' ? items.length : items.filter(item => item.status === value).length}` }))} />
      <Button size="sm" onClick={openAdd}>{t('linkedPanel.add')}</Button>
    </div>
    <AddLinkPopover open={adding} onClose={() => { candidateRequest.current++; setAdding(false); }} candidates={candidates} searchLabel={t('linkedPanel.search')} emptyLabel={t('linkedPanel.empty')} error={error ? t(`linkedPanel.${error.message}`, { defaultValue: t('linkedPanel.snapshotError') }) : candidateError ? t('linkedPanel.candidateError') : null} excludedWindowIds={excludedWindowIds} linkedTargets={targets} onAdd={target => { void add(target).then(() => setAdding(false)).catch(() => {}); }} />
    <span aria-live="polite" className="sr-only">{announcement}</span>
    {wake.dialog}
    {wakeError && <div role="alert">{t('windows.respawnFailed')}</div>}
    {error && !adding && <div role="alert">{t('linkedPanel.snapshotError')} <Button size="sm" onClick={() => void refresh()}>{t('linkedPanel.retry')}</Button></div>}
    {removed && <Button size="sm" onClick={() => { void undo(removed).then(() => setRemoved(null)).catch(() => {}); }}>{t('linkedPanel.undo')}</Button>}
    <div ref={setRoot} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }} style={{ overflowY: 'auto', minHeight: 0 }}>
      {(loading && links.length === 0) || !projectsLoaded ? <p role="status">{t('linkedPanel.loading')}</p> : groups.length === 0 ? <p>{t(`linkedPanel.empty_${filter}`)}</p> : groups.map(group => <LinkedGroup key={group.key} title={group.label} count={group.items.length} onProject={group.key.startsWith('project:') ? () => onProject(Number(group.key.slice(8))) : undefined} projectLabel={t('orchestration.open')}>
        {group.items.map(item => {
          const child = item.link.resolvedWindowId === null ? undefined : childById.get(item.link.resolvedWindowId);
          if (child) return <li key={item.link.id}><ChildOrchestratorCard title={child.window.label || child.window.tmuxTarget} windowId={child.window.id} linkedCount={child.linkCount} runningCount={countRunning(child)} linkedLabel={t('linkedPanel.title')} runningLabel={t('linkedPanel.running')} summary={countAttention(child) === null ? undefined : t('orchestration.attention', { count: countAttention(child) })} enterLabel={t('linkedPanel.enter')} onEnter={() => onEnter(child.window.id)} unlinkLabel={t('linkedPanel.unlink')} onUnlink={() => { void unlink(item.link).then(setRemoved).catch(() => {}); }} /></li>;
          const snapshot = item.status === 'attention' ? attention : normal;
          const id = item.window?.id;
          return <ObservedItem key={item.link.id} id={item.link.id} register={register}><LinkedWindowCard title={item.task?.title ?? item.window?.label ?? item.window?.tmuxTarget ?? t('linkedPanel.waiting')} status={t(`linkedPanel.${item.status}`)} statusTone={item.status} windowId={id} timestamp={item.link.lastInteractionAt || item.lastActivityAt ? formatRelativeTime(item.link.lastInteractionAt ?? item.lastActivityAt!) : undefined} acknowledged={item.status === 'completed' && !!item.task && isLinkedCompletionAcknowledged(item.link.id, item.task.updatedAt)} acknowledgeLabel={t('linkedPanel.acknowledge')} onAcknowledge={item.status === 'completed' && item.task ? () => { acknowledgeLinkedCompletion(item.link.id, item.task!.updatedAt); setAcknowledgementVersion(value => value + 1); } : undefined} sleepingLabel={item.window?.sleeping ? t('linkedPanel.sleeping') : undefined} onWake={item.window?.sleeping ? () => void wakeWindow(item.window!) : undefined} waking={waking === id} wakeLabel={t('linkedPanel.wake')} attention={item.status === 'attention'} openLabel={t('orchestration.open')} unlinkLabel={t('linkedPanel.unlink')} onOpen={item.window ? () => { if (item.status === 'completed' && item.task) { acknowledgeLinkedCompletion(item.link.id, item.task.updatedAt); setAcknowledgementVersion(value => value + 1); } onOpen(item.window!); } : undefined} onExpand={item.window ? () => onExpand(item.window!) : undefined} expandLabel={t('orchestration.expand')} onUnlink={() => { void unlink(item.link).then(setRemoved).catch(() => {}); }} waitingLabel={!item.window && item.link.resolvedWindowId === null && item.link.taskId !== null ? t('linkedPanel.waiting') : undefined} closedLabel={!item.window && (item.link.targetWindowId !== null || item.link.resolvedWindowId !== null) ? t('linkedPanel.windowUnavailable') : undefined} snapshot={id !== undefined && visibleIds.has(item.link.id) ? <LinkedSnapshot snapshot={snapshot.snapshots.get(id)} loadingLabel={t('linkedPanel.loading')} errorLabel={t('linkedPanel.snapshotError')} closedLabel={t('linkedPanel.closed')} retryLabel={t('linkedPanel.retry')} onRetry={snapshot.refresh} /> : undefined} /></ObservedItem>;
        })}
      </LinkedGroup>)}
    </div>
  </div>;
}

function ObservedItem({ id, register, children }: { id: number; register: (id: number, node: Element | null) => void; children: ReactNode }) {
  const ref = useCallback((node: HTMLLIElement | null) => register(id, node), [id, register]);
  return <li ref={ref}>{children}</li>;
}
