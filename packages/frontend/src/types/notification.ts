export interface AgentActivityPayload {
  serverName: string;
  target: string;
  running: boolean;
  source: 'operation' | 'manual' | 'supervised';
  /**
   * True only while an execution run of a Unit owns this pane. A `windows` row
   * keeps its `task_id` after the run ends, so `taskId` alone cannot tell a
   * hand-launched agent apart from a task AZITO is driving — use this flag.
   */
  operation: boolean;
  taskId?: number;
  label?: string;
  projectId?: number;
  /** エージェントが承認待ち等でブロックされているか。省略時は 'working' 扱い（後方互換） */
  status?: 'working' | 'blocked';
  paneName?: string;
}

export type AppNotificationKind =
  | 'qa'
  | 'plan_approval'
  | 'task_done'
  | 'task_failed'
  | 'agent_finished';

export interface AppNotification {
  id: string;
  kind: AppNotificationKind;
  title?: string;
  body?: string;
  messageKey?: string;
  messageParams?: Record<string, string>;
  taskId?: number;
  projectId?: number;
  serverName?: string;
  target?: string;
  read: boolean;
  createdAt: number;
}

export type NotificationEvent =
  | { type: 'sessions:updated'; payload: { serverName: string } }
  | { type: 'task:status'; payload: { taskId: number; status: string; title?: string; projectId?: number } }
  | { type: 'phase:completed'; payload: { taskId: number; unitId: number; phase: string; summary: Record<string, unknown> | null } }
  | { type: 'window:created'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'window:destroyed'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'window:renamed'; payload: { serverName: string; sessionName: string; oldName: string; newName: string } }
  | { type: 'pane:exited'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'agent:activity'; payload: AgentActivityPayload }
  | { type: 'browser:opened'; payload: BrowserOpenedPayload }
  | { type: 'supervisor:ready'; payload: { serverName: string; target: string; taskId?: number } }
  | { type: 'workspace:refresh'; payload: Record<string, never> };

export interface BrowserOpenedPayload {
  serverName: string;
  groupId: string;
  tabId: string;
  url: string | null;
  taskId?: number;
  label?: string;
}
