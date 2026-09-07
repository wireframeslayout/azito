import * as pty from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

function resolveZellijBin(): string {
  const userBin = path.join(os.homedir(), '.local', 'bin', 'zellij');
  try { fs.accessSync(userBin, fs.constants.X_OK); return userBin; } catch { return 'zellij'; }
}

interface ResidentEntry {
  process: pty.IPty;
}

export class ZellijResidentClient {
  private entries = new Map<string, ResidentEntry>();
  private zellijBin: string;
  private cols: number;
  private rows: number;

  constructor(opts?: { zellijBin?: string; cols?: number; rows?: number }) {
    this.zellijBin = opts?.zellijBin ?? resolveZellijBin();
    this.cols = opts?.cols ?? 200;
    this.rows = opts?.rows ?? 50;
  }

  async ensureAttached(session: string): Promise<void> {
    const existing = this.entries.get(session);
    if (existing) return;

    const proc = pty.spawn(this.zellijBin, ['attach', session], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });

    proc.onData(() => {});

    const entry: ResidentEntry = { process: proc };
    this.entries.set(session, entry);

    proc.onExit(() => {
      if (this.entries.get(session) === entry) {
        this.entries.delete(session);
      }
    });

    await this.waitForAttach(session);
  }

  private waitForAttach(session: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const check = (): void => {
        execFile(this.zellijBin, ['list-sessions', '--no-formatting'], { timeout: 3000 }, (err, stdout) => {
          if (!err && stdout.includes(session)) {
            resolve();
            return;
          }
          if (Date.now() - start > 3000) {
            resolve();
            return;
          }
          setTimeout(check, 200);
        });
      };
      setTimeout(check, 300);
    });
  }

  isAttached(session: string): boolean {
    return this.entries.has(session);
  }

  detach(session: string): void {
    const entry = this.entries.get(session);
    if (!entry) return;
    this.entries.delete(session);
    try { entry.process.kill(); } catch { /* already exited */ }
  }

  detachAll(): void {
    for (const [session] of this.entries) {
      this.detach(session);
    }
  }
}
