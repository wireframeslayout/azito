import fs from 'fs';
import type { SecretFileGuard } from '../../shared/os/secretFileGuard';

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
  /** Something worth knowing about a run that did not fail (a stop that arrived after the update had completed). */
  note?: string;
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
  constructor(private statePath: string, private logPath: string, private guard: SecretFileGuard) {}

  read(): UpdateState | null {
    try {
      const content = fs.readFileSync(this.statePath, 'utf-8');
      return JSON.parse(content) as UpdateState;
    } catch {
      return null;
    }
  }

  write(state: UpdateState): void {
    this.guard.writeSecretFile(this.statePath, JSON.stringify(state, null, 2));
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
    this.guard.appendSecretFile(this.logPath, `[${timestamp}] ${line}\n`);
  }

  readLog(tailLines: number = LOG_TAIL_DEFAULT): string[] {
    let content: string;
    try {
      content = fs.readFileSync(this.logPath, 'utf-8');
    } catch {
      return [];
    }
    const lines = content.split('\n').filter((l) => l.length > 0);
    return currentRunLines(lines).slice(-tailLines);
  }
}

const RUN_START_LINE = /^\[[^\]]*\] Update started:/;

/** update.log is cumulative across runs; the current run starts at the last "Update started" line. */
export function currentRunLines(lines: string[]): string[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RUN_START_LINE.test(lines[i])) return lines.slice(i);
  }
  return lines;
}
