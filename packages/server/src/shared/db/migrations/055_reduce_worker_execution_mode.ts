export const version = 55;
export const description = "Reduce worker_execution_mode to 'tmux-pipe' | 'http-signal' by converting 'supervised' to 'http-signal'";
export const up = (db: import('better-sqlite3').Database): void => {
  db.prepare("UPDATE units SET worker_execution_mode = 'http-signal' WHERE worker_execution_mode = 'supervised'").run();
};
