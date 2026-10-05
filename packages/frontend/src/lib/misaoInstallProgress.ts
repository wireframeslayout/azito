/** What the hub reports for the last install-misao run of a server (`GET /servers/:name/install-misao`). */
export interface MisaoInstallProgress {
  state: 'idle' | 'running' | 'done' | 'failed';
  /** Step codes (`inspect` / `transfer` / `prepare` / `start`), in order. */
  steps: string[];
  error?: string;
  code?: string;
}

/** What a progress report means for a row that is following an install it did not start itself. */
export type InstallProgressOutcome =
  | { kind: 'running'; step: string | null }
  | { kind: 'done' }
  | { kind: 'failed'; error: string }
  | { kind: 'idle' };

export function interpretInstallProgress(progress: MisaoInstallProgress): InstallProgressOutcome {
  switch (progress.state) {
    case 'running': return { kind: 'running', step: progress.steps.at(-1) ?? null };
    case 'done': return { kind: 'done' };
    case 'failed': return { kind: 'failed', error: progress.error ?? 'install failed' };
    default: return { kind: 'idle' };
  }
}
