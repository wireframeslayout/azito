import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LookoutToast } from '../components/lookout/LookoutToast';
import { addEvent, type PendingEvent } from '../lib/lookoutBatch';
import { LOOKOUT_NOTIFY_INTERVAL_CHANGED, LOOKOUT_NOTIFY_INTERVAL_KEY, readLookoutNotifyInterval, type LookoutNotifyInterval } from '../lib/lookoutNotifyInterval';
import { paths } from '../paths';
import { useAgentActivity } from './useAgentActivity';
import { useCrossProjectNavigation } from './useCrossProjectNavigation';
import { useLookout } from './useLookout';
import { useNotificationChannel } from './useNotificationChannel';
import { useWorkspaceCatalog } from './useWorkspaceCatalog';

interface NotifierEvent extends PendingEvent {
  taskId?: number;
  serverName?: string;
  target?: string;
  windowId?: number;
  action?: 'mux' | 'firewall';
}

const FAILED = new Set(['error', 'send_error', 'worker_not_ready', 'codex_error', 'stopped_by_user']);
let oldHistoryRemoved = false;
const ATTENTION = new Set(['waiting_for_human', 'phase_review', 'pending_approval']);
const intervalMs = (interval: LookoutNotifyInterval) => interval === '5min' ? 300_000 : 900_000;

export function LookoutNotifier({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('lookout');
  const lookout = useLookout();
  const { isWatched } = useAgentActivity();
  const { openTerminal } = useCrossProjectNavigation();
  const navigate = useNavigate();
  const { allProjects, allTasks } = useWorkspaceCatalog();
  const [interval, setIntervalValue] = useState(readLookoutNotifyInterval);
  const [toast, setToast] = useState<NotifierEvent[]>([]);
  const pending = useRef<NotifierEvent[]>([]);
  const currentToast = useRef<NotifierEvent[]>([]);
  const recent = useRef(new Map<string, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ lookout, isWatched, interval });
  latest.current = { lookout, isWatched, interval };
  const updateToast = (batch: NotifierEvent[]) => { currentToast.current = batch; setToast(batch); };
  const watched = (event: NotifierEvent) => {
    const { lookout: current, isWatched: check } = latest.current;
    if (event.action === 'firewall') return false;
    if (event.serverName && event.target) return check(event.serverName, event.target, event.windowId);
    return current.rows.some(row => (event.action === 'mux' ? row.windowId === event.windowId && row.serverName === event.serverName : event.taskId != null && row.taskId === event.taskId) && check(row.serverName, row.target, row.windowId));
  };
  const flush = () => {
    timer.current = null;
    const visible = pending.current.filter(event => !watched(event));
    pending.current = [];
    if (visible.length) updateToast(visible.reduce(addEvent, currentToast.current));
  };
  const accept = (input: Omit<NotifierEvent, 'at'>) => {
    const event: NotifierEvent = { ...input, at: Date.now() };
    const setting = latest.current.interval;
    if (setting === 'off' || latest.current.lookout.open || watched(event)) return;
    if (setting === 'immediate') {
      const now = Date.now();
      for (const [key, time] of recent.current) if (now - time >= 8000) recent.current.delete(key);
      if (recent.current.has(event.key)) return;
      recent.current.set(event.key, now);
      updateToast(addEvent(currentToast.current, event));
      return;
    }
    pending.current = addEvent(pending.current, event);
    if (!timer.current) timer.current = setTimeout(flush, intervalMs(setting));
  };
  useNotificationChannel({
    onTaskStatus: payload => {
      const kind = ATTENTION.has(payload.status) ? 'attention' : payload.status === 'done' ? 'finished' : FAILED.has(payload.status) ? 'failed' : null;
      if (kind) accept({ key: `task:${payload.taskId}:${payload.status}`, kind, title: payload.title ?? t('toast.task', { id: payload.taskId }), taskId: payload.taskId });
    },
    onAgentActivity: payload => {
      if (payload.running || (payload.reason !== 'api_error' && (payload.reason !== 'completed' || payload.operation))) return;
      accept({ key: `agent:${payload.serverName}:${payload.windowId ?? payload.target}:${payload.reason}`, kind: payload.reason === 'api_error' ? 'failed' : 'finished', title: payload.label ?? payload.target, serverName: payload.serverName, target: payload.target, windowId: payload.windowId });
    },
    onMuxWake: payload => accept({ key: `mux:${payload.serverName}:${payload.windowId}`, kind: 'attention', title: t('toast.mux', { name: payload.title ?? `#${payload.windowId}` }), serverName: payload.serverName, windowId: payload.windowId, taskId: payload.taskId, action: 'mux' }),
    onServerFirewall: payload => accept({ key: `firewall:${payload.serverName}`, kind: 'attention', title: t('toast.firewall', { name: payload.serverName }), serverName: payload.serverName, action: 'firewall' }),
  });
  useEffect(() => {
    // Temporary cleanup of the retired notification history; remove in the next release.
    if (!oldHistoryRemoved) {
      oldHistoryRemoved = true;
      try { localStorage.removeItem('azito-notifications'); } catch { /* Storage unavailable. */ }
    }
    const changed = (event: Event) => setIntervalValue((event as CustomEvent<LookoutNotifyInterval>).detail);
    const storage = (event: StorageEvent) => { if (event.key === LOOKOUT_NOTIFY_INTERVAL_KEY || event.key === null) setIntervalValue(readLookoutNotifyInterval()); };
    window.addEventListener(LOOKOUT_NOTIFY_INTERVAL_CHANGED, changed);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(LOOKOUT_NOTIFY_INTERVAL_CHANGED, changed); window.removeEventListener('storage', storage); if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (interval === 'off') pending.current = [];
    else if (pending.current.length && interval === 'immediate') flush();
    else if (pending.current.length) timer.current = setTimeout(flush, intervalMs(interval));
  }, [interval]);
  useEffect(() => {
    if (!lookout.open) return;
    pending.current = [];
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, [lookout.open]);
  useEffect(() => {
    if (!toast.length || toast.some(event => event.kind === 'attention')) return;
    const timeout = setTimeout(() => updateToast([]), 8000);
    return () => clearTimeout(timeout);
  }, [toast]);
  const dismiss = () => updateToast([]);
  const action = (event: NotifierEvent) => {
    if (event.action === 'firewall' && event.serverName) navigate(paths.server(event.serverName, 'setup'));
    if (event.action === 'mux' && event.serverName && event.windowId != null) {
      const row = lookout.rows.find(item => item.windowId === event.windowId && item.serverName === event.serverName);
      const project = allProjects.find(item => item.windows?.some(window => window.id === event.windowId));
      const task = allTasks.find(item => item.windows?.some(window => window.id === event.windowId) || item.id === event.taskId);
      openTerminal({ serverName: event.serverName, target: row?.target ?? '', windowId: event.windowId }, row?.projectId ?? project?.id ?? task?.projectId);
    }
    updateToast(currentToast.current.filter(item => item.key !== event.key));
  };
  return <>{children}{toast.length > 0 && <LookoutToast batch={toast} onDismiss={dismiss} onOpen={() => { updateToast(currentToast.current.filter(event => event.action)); lookout.openDrawer(); }} onAction={action} />}</>;
}
