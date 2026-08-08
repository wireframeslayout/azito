export type WindowType = 'terminal' | 'agent';
export type OwnerType = 'project' | 'task';

export interface Window {
  id: number;
  ownerType: OwnerType;
  projectId: number | null;
  taskId: number | null;
  serverName: string;
  tmuxTarget: string;
  label: string | null;
  isPrimary: boolean;
  windowType: WindowType;
  workerType: string | null;
  workerModel: string | null;
  agentSessionId: string | null;
  launchCommand: string | null;
  workingDirectory: string | null;
  paneLayout: PaneLayout | null;
  createdAt: string;
}

export interface PaneLayout {
  layout: string;
  panes: PaneConfig[];
}

export interface PaneConfig {
  index: number;
  command: string | null;
  workingDirectory: string | null;
  title: string | null;
  workerType?: string;
  agentSessionId?: string;
}

export interface TerminalWindow extends Window {
  windowType: 'terminal';
  workerType: null;
}

export interface AgentWindow extends Window {
  windowType: 'agent';
  workerType: string;
}

export function isAgentWindow(w: Window): w is AgentWindow {
  return w.windowType === 'agent' && w.workerType !== null;
}

/**
 * Single judgment point for "is `win` the task's primary worker window"
 * (Issue #28 third-party review finding — multi-window token rotation
 * collision). A task's AZITO_TASK_TOKEN is bound one-to-one to its primary
 * worker window's generation (design v3 §2: the generation IS the primary
 * window's generation — `task.tmuxWindow` names it, and `isPrimary` is set
 * `true` on exactly that row by ExecuteTaskUseCase.execute()/
 * TaskRestoreService.restore(), never on a secondary window added via
 * `POST /api/tasks/:id/windows`). A secondary window is not a caller of the
 * task's own API surface, so it must never rotate or revoke that token:
 * rotating on a secondary respawn would 401 a still-live primary pane, and
 * revoking on a secondary window's destruction would do the same.
 *
 * Every rotate/revoke decision point (WindowRespawnService.respawn(), the
 * generic tmux kill-window/kill-session routes' `onTaskWindowDestroyed`
 * callback) must call this instead of re-deriving the same check inline, so
 * the two can never independently drift (see this module's own history for
 * why: the original bug was exactly this check being ownerType/taskId-only,
 * missing the isPrimary half, in one of the call sites but not the others).
 */
export function isPrimaryTaskWindow(win: Pick<Window, 'ownerType' | 'isPrimary'>): boolean {
  return win.ownerType === 'task' && win.isPrimary;
}

export interface IWindowRepository {
  add(window: Omit<Window, 'id' | 'createdAt'>): number;
  findAll(): Window[];
  findById(id: number): Window | undefined;
  findByProject(projectId: number): Window[];
  findByTask(taskId: number): Window[];
  /** Batch form of findByTask — one query for many tasks, keyed by task id.
   *  Task ids with no windows are absent from the map. */
  findByTaskIds(taskIds: number[]): Map<number, Window[]>;
  findAgentSessionIdsByServer(serverName: string): Set<string>;
  /** Window-granularity lookup (pane suffix stripped on both sides — see paneTarget.ts). */
  findByServerAndTarget(serverName: string, tmuxTarget: string): Window | undefined;
  /**
   * Every window row (any ownerType) whose tmuxTarget belongs to
   * `sessionName` on `serverName` — used by the session-delete route
   * (Issue #28 third-party review finding 4) to resolve which windows a
   * whole-session kill is about to take down BEFORE the kill runs (once the
   * session is gone, tmux itself can no longer answer "which windows did it
   * hold").
   */
  findByServerAndSession(serverName: string, sessionName: string): Window[];
  update(id: number, data: Partial<Pick<Window,
    'tmuxTarget' | 'label' | 'agentSessionId' | 'launchCommand' | 'paneLayout' | 'workerModel' | 'workingDirectory' | 'windowType' | 'workerType'
  >>): void;
  updateAgentSessionIdByWindow(serverName: string, tmuxTarget: string, sessionId: string): void;
  remove(id: number): void;
  removeByServerAndTarget(serverName: string, tmuxTarget: string): number;
  updatePaneLayout(id: number, layout: PaneLayout): void;
}
