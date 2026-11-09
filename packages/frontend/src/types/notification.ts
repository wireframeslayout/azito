export interface WindowRenamedPayload {
  serverName: string;
  target: string;
  newName: string;
  windowId?: number;
}

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
  windowId?: number;
  label?: string;
  labelSource?: 'auto' | 'user';
  taskTitle?: string;
  workerType?: string;
  windowType?: string;
  paneTitle?: string;
  paneCommand?: string;
  projectId?: number;
  /** エージェントが承認待ち等でブロックされているか。省略時は 'working' 扱い（後方互換） */
  status?: 'working' | 'blocked';
  paneName?: string;
  /**
   * running:false の理由（P3）。'completed' だけが「エージェントが仕事を終えた」を意味する。
   * - 'completed'    supervisor の active→idle / hook の Stop / ペイン分類の working→idle /
   *                  transcript の最終応答（terminal_final）観測
   * - 'interrupted'  ユーザー中断（停止ボタン・Esc）
   * - 'deleted'      ウィンドウ（または windows 行）が消えた
   * - 'offline'      エージェントプロセス消滅・サーバー到達不能
   * - 'api_error'    Tier 2 がペイン画面に Claude API エラーメッセージを検出。
   *                  停止しているが正常完了ではない。
   * - 'unknown'      どのソースも理由を特定できない（Tier 3 のヒューリスティックの時間切れ等）
   * 完了表示・完了通知は必ず 'completed' でゲートすること。
   */
  reason?: 'completed' | 'interrupted' | 'deleted' | 'offline' | 'api_error' | 'unknown';
}

export interface FirewallDiagnosis {
  state: 'blocked' | 'missing_allow' | 'unknown';
  blockedBy: string[];
  commands: string[];
  checkedAt: number;
  networkCategory: string | null;
}

export type NotificationEvent =
  | { type: 'window:mux_switch_suggested'; payload: { windowId: number; serverName: string; title?: string; taskId?: number; reason: 'ask' | 'misao_unavailable' } }
  | { type: 'server:firewall'; payload: { serverName: string; diagnosis: FirewallDiagnosis } }
  | { type: 'sessions:updated'; payload: { serverName: string } }
  | { type: 'task:status'; payload: { taskId: number; status: string; title?: string; projectId?: number } }
  | { type: 'phase:completed'; payload: { taskId: number; unitId: number; phase: string; summary: Record<string, unknown> | null } }
  | { type: 'window:created'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'window:destroyed'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'window:renamed'; payload: WindowRenamedPayload }
  | { type: 'pane:exited'; payload: { serverName: string; sessionName: string; windowName: string } }
  | { type: 'agent:activity'; payload: AgentActivityPayload }
  | { type: 'browser:opened'; payload: BrowserOpenedPayload }
  | { type: 'supervisor:ready'; payload: { serverName: string; target: string; taskId?: number } }
  | { type: 'subagents:updated'; payload: { windowId: number; sessionId: string } }
  | { type: 'orchestration:updated'; payload: { windowId: number } }
  | { type: 'workspace:refresh'; payload: Record<string, never> };

export interface BrowserOpenedPayload {
  serverName: string;
  groupId: string;
  tabId: string;
  url: string | null;
  taskId?: number;
  label?: string;
}
