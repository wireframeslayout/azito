import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import * as pty from 'node-pty';
import type {
  ExecResult,
  IServerTransport,
  IMuxTransport,
  ITerminalStream,
} from './ServerTransport';
import type { IPaneStream } from '../../tmux/PaneStream';
import { PaneOutputStream } from '../../tmux/PaneOutputStream';
import type { TmuxRuntime } from './TmuxRuntime';
import { type MuxRef, type PaneHandle, type PaneOrdinal, type MuxExecRequest, tmuxTargetFromMuxRef } from '@azito/shared';
import { buildTmuxAttachPlan } from '../../tmux/tmuxAttach';

function execLocal(command: string, args: string[], timeoutMs = 5000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

class LocalTerminalStream extends EventEmitter implements ITerminalStream {
  constructor(
    private ptyProcess: pty.IPty,
    private cleanupFn: (() => void) | null,
  ) {
    super();
    ptyProcess.onData((data: string) => this.emit('data', data));
    ptyProcess.onExit(() => {
      this.emit('close');
      this.runCleanup();
    });
  }

  write(data: string): void {
    this.ptyProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  close(): void {
    this.ptyProcess.kill();
    this.runCleanup();
  }

  private runCleanup(): void {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}

export class LocalTransport implements IServerTransport, IMuxTransport {
  private sessionCounter = 0;

  constructor(private rt: TmuxRuntime, private publicUrl: string) {}

  exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    return execLocal('/bin/sh', ['-c', command], timeoutMs);
  }

  execMux(req: MuxExecRequest): Promise<ExecResult> {
    if (req.kind !== 'tmux') throw new Error(`LocalTransport: unsupported mux kind "${req.kind}"`);
    return execLocal(this.rt.bin, [...this.rt.baseArgs, ...req.args]);
  }

  async openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream> {
    const tmuxTarget = tmuxTargetFromMuxRef(ref);
    const colonIdx = tmuxTarget.indexOf(':');
    const sessionName = tmuxTarget.slice(0, colonIdx);
    const windowTarget = tmuxTarget.slice(colonIdx + 1);

    const linkedName = `_azito_${sessionName}_${++this.sessionCounter}_${Date.now()}`;
    const plan = buildTmuxAttachPlan(sessionName, windowTarget, linkedName, this.publicUrl);

    const execTmux = (args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile(this.rt.bin, [...this.rt.baseArgs, ...args], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

    await execTmux(plan.prepare[0]).catch(() => { throw new Error('WINDOW_NOT_FOUND'); });
    await execTmux(plan.prepare[1]).catch(() => {});

    let attachArgs: string[];
    let cleanupFn: (() => void) | null = null;

    try {
      await execTmux(plan.prepare[2]);
      await execTmux(plan.prepare[3]).catch(() => {});
      await execTmux(plan.prepare[4]).catch(() => {});
      attachArgs = plan.attach;
      cleanupFn = () => {
        execFile(this.rt.bin, [...this.rt.baseArgs, ...plan.cleanup], () => {});
      };
    } catch {
      attachArgs = plan.fallbackAttach;
    }

    return this.spawnTerminal(
      [...this.rt.baseArgs, ...attachArgs],
      cols,
      rows,
      undefined,
      cleanupFn ?? undefined,
    );
  }

  spawnTerminal(
    argv: string[],
    cols: number,
    rows: number,
    env?: Record<string, string>,
    cleanup?: () => void,
  ): ITerminalStream {
    try {
      const ptyProcess = pty.spawn(this.rt.bin, argv, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME,
        env: env ?? (process.env as Record<string, string>),
      });
      return new LocalTerminalStream(ptyProcess, cleanup ?? null);
    } catch (err) {
      throw new Error(`Failed to start terminal: ${(err as Error).message}`);
    }
  }

  createPaneStream(handle: PaneHandle): IPaneStream {
    return new PaneOutputStream(handle as string);
  }
}
