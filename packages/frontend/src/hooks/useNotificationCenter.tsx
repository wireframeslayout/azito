import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AgentActivityPayload, AppNotification, AppNotificationKind } from '../types/notification';
import { useAgentActivity } from './useAgentActivity';
import { useNotificationChannel } from './useNotificationChannel';
import { useWorkspaceTargets } from './useWorkspaceTargets';
import { Icon } from '../components/ui/Icon';
import { paths, matchWorkspacePath } from '../paths';

const STORAGE_KEY = 'azito-notifications';
const MAX_NOTIFICATIONS = 100;
const MAX_TOASTS = 3;
const TOAST_DURATION_MS = 5000;
// エージェント稼働はアイドル判定のフラッピングやサーバー再起動時のバーストで
// 同一ペインの開始/終了イベントが短時間に繰り返されるため、時間窓でデデュープする
// 8s: idle 検知は「最後の出力から 10s 静穏」なので本物の連続完了は必ず 10s 以上あく。
// 窓を 10s 未満にすれば正当な再実行完了を抑制せず、同一完了の瞬間的な二重 emit だけを弾ける。
// フォーカス再描画による誤通知は onAgentActivity 側の isWatched チェックで抑える。
const AGENT_DEDUPE_WINDOW_MS = 8_000;
const AGENT_DEDUPE_SCAN_LIMIT = 50;
// プロジェクト跨ぎナビゲーション後、Workspace が onOpenTask を再登録しない場合に保留を破棄するTTL
const PENDING_OPEN_TASK_TTL_MS = 5000;

const FAILED_STATUSES = new Set(['error', 'send_error', 'codex_error', 'stopped_by_user']);

const NOTIFICATION_KINDS: readonly AppNotificationKind[] = [
  'qa', 'plan_approval', 'execution_approval', 'task_done', 'task_failed', 'agent_finished',
];

interface EphemeralToast {
  id: string;
  notification: AppNotification;
}

interface NotificationCenterContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
  toasts: EphemeralToast[];
  dismissToast: (id: string) => void;
  openNotification: (notification: AppNotification) => void;
  openTask: (taskId: number) => void;
  /**
   * ターミナルタブを開く。プロジェクトが現在のワークスペースと異なる場合（グローバルページ
   * 表示中を含む）は、そのプロジェクトのワークスペースへ遷移してからタブを開く。
   */
  openTerminal: (serverName: string, target: string, projectId?: number) => void;
}

const defaultValue: NotificationCenterContextValue = {
  notifications: [],
  unreadCount: 0,
  markRead: () => {},
  markAllRead: () => {},
  clear: () => {},
  toasts: [],
  dismissToast: () => {},
  openNotification: () => {},
  openTask: () => {},
  openTerminal: () => {},
};

const NotificationCenterContext = createContext<NotificationCenterContextValue>(defaultValue);

function isAppNotification(v: unknown): v is AppNotification {
  if (typeof v !== 'object' || v === null) return false;
  const n = v as Record<string, unknown>;
  return typeof n.id === 'string'
    && typeof n.kind === 'string'
    && (NOTIFICATION_KINDS as readonly string[]).includes(n.kind)
    && (typeof n.title === 'string' || (n.title === undefined && typeof n.messageKey === 'string'))
    && typeof n.read === 'boolean'
    && typeof n.createdAt === 'number'
    && Number.isFinite(n.createdAt)
    && (n.taskId === undefined || typeof n.taskId === 'number')
    && (n.projectId === undefined || typeof n.projectId === 'number')
    && (n.serverName === undefined || typeof n.serverName === 'string')
    && (n.target === undefined || typeof n.target === 'string')
    && (n.body === undefined || typeof n.body === 'string');
}

function loadNotifications(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAppNotification).slice(0, MAX_NOTIFICATIONS);
  } catch {
    return [];
  }
}

function saveNotifications(notifications: AppNotification[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)));
  } catch {
    /* localStorage 不可（容量超過・プライベートモード等）は通知の永続化のみ諦める */
  }
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function taskTitleOf(title: string | undefined, taskId: number, fallback: string): string {
  return title ?? fallback;
}

function agentLabelOf(payload: AgentActivityPayload): string {
  return payload.label ?? payload.target;
}

function buildTaskNotification(
  kind: AppNotificationKind,
  messageKey: string,
  payload: { taskId: number; status: string; title?: string; projectId?: number },
  taskTitle: string,
): AppNotification {
  return {
    id: makeId(),
    kind,
    messageKey,
    messageParams: { title: taskTitle },
    taskId: payload.taskId,
    projectId: payload.projectId,
    read: false,
    createdAt: Date.now(),
  };
}

function buildAgentNotification(kind: AppNotificationKind, messageKey: string, messageParams: Record<string, string>, payload: AgentActivityPayload): AppNotification {
  return {
    id: makeId(),
    kind,
    messageKey,
    messageParams,
    taskId: payload.taskId,
    projectId: payload.projectId,
    serverName: payload.serverName,
    target: payload.target,
    read: false,
    createdAt: Date.now(),
  };
}

/**
 * デデュープ判定。
 * - agent系: kind + serverName + target をキーに、直近5分以内の同一通知（既読/未読問わず）
 *   があれば重複。走査は直近 AGENT_DEDUPE_SCAN_LIMIT 件で十分。
 * - task系: 同一 taskId+kind の通知が直近（配列先頭）に未読で存在する場合のみ重複。
 */
function isDuplicate(notifications: AppNotification[], candidate: AppNotification): boolean {
  if (candidate.kind === 'agent_finished') {
    const cutoff = candidate.createdAt - AGENT_DEDUPE_WINDOW_MS;
    return notifications.slice(0, AGENT_DEDUPE_SCAN_LIMIT).some((n) =>
      n.kind === candidate.kind
      && n.serverName === candidate.serverName
      && n.target === candidate.target
      && n.createdAt >= cutoff);
  }
  if (candidate.taskId === undefined) return false;
  const latest = notifications[0];
  return !!latest && !latest.read && latest.kind === candidate.kind && latest.taskId === candidate.taskId;
}

export function NotificationCenterProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('notifications');
  const [notifications, setNotifications] = useState<AppNotification[]>(loadNotifications);
  const [toasts, setToasts] = useState<EphemeralToast[]>([]);
  const navigate = useNavigate();
  const location = useLocation();
  const { onOpenTask, onOpenInTerminal } = useWorkspaceTargets();
  const { isWatched } = useAgentActivity();
  const onOpenTaskRef = useRef(onOpenTask);
  const onOpenInTerminalRef = useRef(onOpenInTerminal);
  onOpenTaskRef.current = onOpenTask;
  onOpenInTerminalRef.current = onOpenInTerminal;
  const locationRef = useRef(location);
  locationRef.current = location;

  // WSイベントが再レンダー前に連続到達してもデデュープ・上限制御が効くよう、stateと同値のミラーを持つ
  const notificationsRef = useRef(notifications);
  const toastsRef = useRef<EphemeralToast[]>([]);
  const toastTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingOpenTaskRef = useRef<{ taskId: number; projectId: number } | null>(null);
  const pendingOpenTerminalRef = useRef<{ serverName: string; target: string; projectId: number } | null>(null);
  const pendingOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    saveNotifications(notifications);
  }, [notifications]);

  // unmount時に全タイマーを破棄
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (pendingOpenTimerRef.current) {
        clearTimeout(pendingOpenTimerRef.current);
        pendingOpenTimerRef.current = null;
      }
    };
  }, []);

  const updateNotifications = useCallback((next: AppNotification[]) => {
    notificationsRef.current = next;
    setNotifications(next);
  }, []);

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    if (!toastsRef.current.some((t) => t.id === id)) return;
    toastsRef.current = toastsRef.current.filter((t) => t.id !== id);
    setToasts(toastsRef.current);
  }, []);

  const pushNotification = useCallback((notification: AppNotification) => {
    // 一覧とトーストを同じ判定結果で制御する（state更新の外で判定）
    if (isDuplicate(notificationsRef.current, notification)) return;

    updateNotifications([notification, ...notificationsRef.current].slice(0, MAX_NOTIFICATIONS));

    // 上限超過で押し出される古いトーストはタイマーごと破棄
    const evicted = toastsRef.current.slice(0, Math.max(0, toastsRef.current.length - (MAX_TOASTS - 1)));
    for (const t of evicted) {
      const timer = toastTimersRef.current.get(t.id);
      if (timer) {
        clearTimeout(timer);
        toastTimersRef.current.delete(t.id);
      }
    }
    toastsRef.current = [...toastsRef.current.slice(-(MAX_TOASTS - 1)), { id: notification.id, notification }];
    setToasts(toastsRef.current);
    // タイマーは新規トーストにのみ張る（既存トーストのカウントはリセットしない）
    toastTimersRef.current.set(notification.id, setTimeout(() => dismissToast(notification.id), TOAST_DURATION_MS));
  }, [updateNotifications, dismissToast]);

  useNotificationChannel({
    onTaskStatus: useCallback((payload: { taskId: number; status: string; title?: string; projectId?: number }) => {
      const taskTitle = taskTitleOf(payload.title, payload.taskId, t('fallbackTaskTitle', { taskId: payload.taskId }));
      switch (payload.status) {
        case 'waiting_for_human':
          pushNotification(buildTaskNotification('qa', 'notifications:kinds.qa', payload, taskTitle));
          break;
        case 'phase_review':
          pushNotification(buildTaskNotification('plan_approval', 'notifications:kinds.planApproval', payload, taskTitle));
          break;
        case 'pending_approval':
          pushNotification(buildTaskNotification('execution_approval', 'notifications:kinds.executionApproval', payload, taskTitle));
          break;
        case 'done':
          pushNotification(buildTaskNotification('task_done', 'notifications:kinds.taskDone', payload, taskTitle));
          break;
        default:
          if (FAILED_STATUSES.has(payload.status)) {
            pushNotification(buildTaskNotification('task_failed', 'notifications:kinds.taskFailed', payload, taskTitle));
          }
          break;
      }
    }, [pushNotification, t]),
    onAgentActivity: useCallback((payload: AgentActivityPayload) => {
      // agent:activity の running:true 側は通知を生成しない（agent_started は廃止）。
      // operation（タスク実行）の完了は task:status の task_done/task_failed 側で
      // 通知するため、ここで通知するのは手動起動分のみ（二重通知を避ける）。
      // 判定は payload.operation で行う。taskId の有無では判定できない: windows 行は
      // 実行終了後も task_id を保持するので、その window で手動起動した agent にも
      // taskId が載り、通知が丸ごと落ちる。
      // 注視中（フォーカスあり＋アクティブタブ/PiPで見ている）のターゲットは通知しない。
      // 完了通知は reason='completed' のみ（P3）。中断・ウィンドウ削除・プロセス消滅・判定不能を
      // 「完了」として通知しない — 稼働していなかったキーにも running:false は流れてくる。
      const isManualLaunch = !payload.operation;
      if (!payload.running && payload.reason === 'completed' && isManualLaunch
        && !isWatched(payload.serverName, payload.target, payload.taskId)) {
        pushNotification(buildAgentNotification('agent_finished', 'notifications:kinds.agentFinished', { label: agentLabelOf(payload) }, payload));
      }
    }, [pushNotification, isWatched]),
  });

  const markRead = useCallback((id: string) => {
    updateNotifications(notificationsRef.current.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, [updateNotifications]);

  const markAllRead = useCallback(() => {
    updateNotifications(notificationsRef.current.map((n) => (n.read ? n : { ...n, read: true })));
  }, [updateNotifications]);

  const clear = useCallback(() => {
    updateNotifications([]);
  }, [updateNotifications]);

  // projectId が現在ルートと異なる場合は navigate＋pending 機構でプロジェクト遷移後に開く
  const openTaskInProject = useCallback((taskId: number, projectId: number | undefined) => {
    const wsMatch = matchWorkspacePath(locationRef.current.pathname);
    const currentProjectId = wsMatch ? parseInt(wsMatch.id, 10) : null;
    if (projectId !== undefined && projectId !== currentProjectId) {
      pendingOpenTaskRef.current = { taskId, projectId };
      pendingOpenTerminalRef.current = null;
      if (pendingOpenTimerRef.current) clearTimeout(pendingOpenTimerRef.current);
      pendingOpenTimerRef.current = setTimeout(() => {
        pendingOpenTaskRef.current = null;
        pendingOpenTimerRef.current = null;
      }, PENDING_OPEN_TASK_TTL_MS);
      navigate(paths.workspace(projectId));
    } else {
      onOpenTaskRef.current?.(taskId);
    }
  }, [navigate]);

  // projectId 不明のタスクを開く: タスクを取得して所属プロジェクトを解決してから開く。
  // 取得失敗時は現在のコンテキストで直接開く（TaskPanel の allTasks フォールバックが受け止める）
  const openTask = useCallback((taskId: number) => {
    api<{ projectId?: number }>(`/tasks/${taskId}`)
      .then((task) => {
        openTaskInProject(taskId, typeof task.projectId === 'number' ? task.projectId : undefined);
      })
      .catch(() => {
        onOpenTaskRef.current?.(taskId);
      });
  }, [openTaskInProject]);

  // projectId が現在ルートと異なる場合は navigate＋pending 機構でプロジェクト遷移後にターミナルを開く
  const openTerminalInProject = useCallback((serverName: string, target: string, projectId: number | undefined) => {
    const wsMatch = matchWorkspacePath(locationRef.current.pathname);
    const currentProjectId = wsMatch ? parseInt(wsMatch.id, 10) : null;
    if (projectId !== undefined && projectId !== currentProjectId) {
      pendingOpenTerminalRef.current = { serverName, target, projectId };
      pendingOpenTaskRef.current = null;
      if (pendingOpenTimerRef.current) clearTimeout(pendingOpenTimerRef.current);
      pendingOpenTimerRef.current = setTimeout(() => {
        pendingOpenTerminalRef.current = null;
        pendingOpenTimerRef.current = null;
      }, PENDING_OPEN_TASK_TTL_MS);
      navigate(paths.workspace(projectId));
    } else {
      onOpenInTerminalRef.current?.(serverName, target);
    }
  }, [navigate]);

  const openNotification = useCallback((notification: AppNotification) => {
    markRead(notification.id);
    dismissToast(notification.id);

    if (notification.taskId !== undefined && (notification.kind === 'qa' || notification.kind === 'plan_approval' || notification.kind === 'execution_approval' || notification.kind === 'task_done' || notification.kind === 'task_failed')) {
      if (notification.projectId !== undefined) {
        openTaskInProject(notification.taskId, notification.projectId);
      } else {
        openTask(notification.taskId);
      }
      return;
    }

    if (notification.serverName && notification.target) {
      if (notification.taskId !== undefined) {
        // taskId 付き agent 通知はタスク取得でプロジェクトを解決して開く
        openTask(notification.taskId);
      } else {
        openTerminalInProject(notification.serverName, notification.target, notification.projectId);
      }
    }
  }, [markRead, dismissToast, openTaskInProject, openTask, openTerminalInProject]);

  // プロジェクト跨ぎで保留したタスクオープンを、遷移完了＋onOpenTask再登録後に実行する
  useEffect(() => {
    const pending = pendingOpenTaskRef.current;
    if (!pending || !onOpenTask) return;
    const wsMatch = matchWorkspacePath(location.pathname);
    if (!wsMatch || parseInt(wsMatch.id, 10) !== pending.projectId) return;
    pendingOpenTaskRef.current = null;
    if (pendingOpenTimerRef.current) {
      clearTimeout(pendingOpenTimerRef.current);
      pendingOpenTimerRef.current = null;
    }
    onOpenTask(pending.taskId);
  }, [location.pathname, onOpenTask]);

  // プロジェクト跨ぎで保留したターミナルオープンを、遷移完了＋onOpenInTerminal再登録後に実行する
  useEffect(() => {
    const pending = pendingOpenTerminalRef.current;
    if (!pending || !onOpenInTerminal) return;
    const wsMatch = matchWorkspacePath(location.pathname);
    if (!wsMatch || parseInt(wsMatch.id, 10) !== pending.projectId) return;
    pendingOpenTerminalRef.current = null;
    if (pendingOpenTimerRef.current) {
      clearTimeout(pendingOpenTimerRef.current);
      pendingOpenTimerRef.current = null;
    }
    onOpenInTerminal(pending.serverName, pending.target);
  }, [location.pathname, onOpenInTerminal]);

  const unreadCount = notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);

  return (
    <NotificationCenterContext.Provider value={{ notifications, unreadCount, markRead, markAllRead, clear, toasts, dismissToast, openNotification, openTask, openTerminal: openTerminalInProject }}>
      {children}
      <NotificationToastStack />
    </NotificationCenterContext.Provider>
  );
}

export function useNotificationCenter(): NotificationCenterContextValue {
  return useContext(NotificationCenterContext);
}

const KIND_ICON: Record<AppNotificationKind, React.ReactNode> = {
  qa: <Icon name="question" size={16} />,
  plan_approval: <Icon name="tasks" size={16} />,
  execution_approval: <Icon name="warning" size={16} />,
  task_done: <Icon name="check" size={16} />,
  task_failed: <Icon name="warning" size={16} />,
  agent_finished: <Icon name="stop" size={16} />,
};

export function notificationIcon(kind: AppNotificationKind): React.ReactNode {
  return KIND_ICON[kind];
}

function NotificationToastStack() {
  const { t } = useTranslation('notifications');
  const { toasts, dismissToast, openNotification } = useNotificationCenter();

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 'calc(var(--space-5) + env(safe-area-inset-bottom))',
        right: 'var(--space-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        zIndex: 400,
        maxWidth: 340,
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="notification-toast"
          onClick={() => openNotification(toast.notification)}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 'var(--font-lg)', lineHeight: 1 }}>{notificationIcon(toast.notification.kind)}</span>
          <span style={{ flex: 1, fontSize: 'var(--font-md)', color: 'var(--text)', lineHeight: 1.4 }}>
            {toast.notification.messageKey ? t(toast.notification.messageKey, toast.notification.messageParams) : (toast.notification.title ?? '')}
          </span>
          <button
            aria-label={t('notifications:toast.dismissAriaLabel')}
            onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: 'var(--font-md)',
              padding: 0,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
