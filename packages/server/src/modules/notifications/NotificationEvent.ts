/**
 * Why an `agent:activity` `running: false` transition happened. Only 'completed'
 * is an actual completion — see AgentActivityMonitor's AgentActivityStopReason
 * doc for the full rung-by-rung mapping. Consumers that render "finished" or
 * push "agent finished" MUST gate on 'completed'; the other reasons mean the
 * agent stopped being observed as running for a different cause (user interrupt,
 * window deleted, process/connection gone, or simply not attributable).
 */
export type AgentActivityStopReason = 'completed' | 'interrupted' | 'deleted' | 'offline' | 'unknown';

export type NotificationEvent =
  | { type: 'sessions:updated'; payload: { serverName: string } }
  | { type: 'task:status'; payload: { taskId: number; status: string; title?: string; projectId?: number } }
  | { type: 'phase:completed'; payload: { taskId: number; unitId: number; phase: string; summary: Record<string, unknown> | null } }
  | { type: 'window:created'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'window:destroyed'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'window:renamed'; payload: { serverName: string; sessionName: string; oldName: string; newName: string } }
  | { type: 'pane:exited'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'agent:activity'; payload: { serverName: string; target: string; running: boolean; source: 'operation' | 'manual' | 'supervised'; operation: boolean; taskId?: number; label?: string; projectId?: number; status?: 'working' | 'blocked'; paneName?: string; reason?: AgentActivityStopReason } }
  | { type: 'supervisor:ready'; payload: { serverName: string; target: string; taskId?: number } }
  | { type: 'browser:opened'; payload: { serverName: string; groupId: string; tabId: string; url: string | null; taskId?: number; label?: string } }
  | { type: 'workspace:refresh'; payload: Record<string, never> };
