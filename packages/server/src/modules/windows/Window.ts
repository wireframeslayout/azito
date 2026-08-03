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

export interface IWindowRepository {
  add(window: Omit<Window, 'id' | 'createdAt'>): number;
  findAll(): Window[];
  findById(id: number): Window | undefined;
  findByProject(projectId: number): Window[];
  findByTask(taskId: number): Window[];
  findAgentSessionIdsByServer(serverName: string): Set<string>;
  /** Window-granularity lookup (pane suffix stripped on both sides — see paneTarget.ts). */
  findByServerAndTarget(serverName: string, tmuxTarget: string): Window | undefined;
  update(id: number, data: Partial<Pick<Window,
    'tmuxTarget' | 'label' | 'agentSessionId' | 'launchCommand' | 'paneLayout' | 'workerModel' | 'workingDirectory' | 'windowType' | 'workerType'
  >>): void;
  updateAgentSessionIdByWindow(serverName: string, tmuxTarget: string, sessionId: string): void;
  remove(id: number): void;
  removeByServerAndTarget(serverName: string, tmuxTarget: string): number;
  updatePaneLayout(id: number, layout: PaneLayout): void;
}
