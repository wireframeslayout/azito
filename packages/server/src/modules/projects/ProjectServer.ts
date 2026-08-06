export interface ProjectServer {
  projectId: number;
  serverName: string;
  workingDirectory: string | null;
  branch: string | null;
  /** tmux session used to run tasks for this project on this server. NOT NULL, defaults to 'azito'. */
  tmuxSession: string;
  /**
   * Execution policy for untrusted-origin tasks (Issue #328) on this
   * project+server pairing. 'deny' rejects execution outright; 'manual-approval'
   * requires a human approval before the first worker/worktree/secret touch;
   * 'allow' would skip approval entirely but is not selectable via the API
   * yet — an isolated execution profile for it doesn't exist (see
   * routes.ts). Has no effect on trusted-origin tasks.
   */
  inputPolicy: 'deny' | 'manual-approval' | 'allow';
}

/** Full row for upsert — tmuxSession is required; callers resolve it at the boundary. */
export type UpsertProjectServerInput = ProjectServer;

export interface IProjectServerRepository {
  findByProject(projectId: number): ProjectServer[];
  findByServer(serverName: string): ProjectServer[];
  find(projectId: number, serverName: string): ProjectServer | null;
  upsert(data: UpsertProjectServerInput): void;
  remove(projectId: number, serverName: string): void;
}
