import fs from 'fs';

export type UpdateStep = 'download' | 'verify' | 'extract' | 'smoke-test' | 'switch' | 'restart' | 'health-check';
export type UpdateRunStatus = 'running' | 'success' | 'failed';

export interface UpdateStepEntry {
  step: UpdateStep;
  status: 'running' | 'ok' | 'error';
  message: string;
}

export interface UpdateState {
  status: UpdateRunStatus;
  step: UpdateStep;
  fromVersion: string;
  toVersion: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  steps: UpdateStepEntry[];
}

const LOG_TAIL_DEFAULT = 200;

/**
 * Persists the in-progress/last-run update state and log across hub restarts
 * (the update itself restarts the hub process, so this state must live on
 * disk rather than in memory). One state file per hub install — a new
 * `startUpdate()` call is refused while a previous run's state is still
 * present with status "running" (see SystemUpdateService).
 */
export class UpdateStateManager {
  constructor(private statePath: string, private logPath: string) {}

  read(): UpdateState | null {
    try {
      const content = fs.readFileSync(this.statePath, 'utf-8');
      return JSON.parse(content) as UpdateState;
    } catch {
      return null;
    }
  }

  write(state: UpdateState): void {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  clear(): void {
    try {
      fs.unlinkSync(this.statePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  appendLog(line: string): void {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(this.logPath, `[${timestamp}] ${line}\n`, { mode: 0o600 });
  }

  readLog(tailLines: number = LOG_TAIL_DEFAULT): string[] {
    let content: string;
    try {
      content = fs.readFileSync(this.logPath, 'utf-8');
    } catch {
      return [];
    }
    const lines = content.split('\n').filter((l) => l.length > 0);
    return lines.slice(-tailLines);
  }
}
