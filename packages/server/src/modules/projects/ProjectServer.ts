export interface ProjectServer {
  projectId: number;
  serverName: string;
  workingDirectory: string | null;
  branch: string | null;
  /** tmux session used to run tasks for this project on this server. NOT NULL, defaults to 'azito'. */
  tmuxSession: string;
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
