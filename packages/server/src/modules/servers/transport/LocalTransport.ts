import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import * as pty from 'node-pty';
import type {
  ExecResult,
  IServerTransport,
  IMuxTransport,
  IHostBoundTransport,
  ITerminalStream,
} from './ServerTransport';
import type { IPaneStream } from '../../tmux/PaneStream';
import { PaneOutputStream } from '../../tmux/PaneOutputStream';
import type { TmuxRuntime } from './TmuxRuntime';
import { type MuxRef, type PaneHandle, type PaneOrdinal, type MuxExecRequest, tmuxTargetFromMuxRef } from '@azito/shared';
import { buildTmuxAttachPlan } from '../../tmux/tmuxAttach';
import type { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { assertPosixHost, type HostProfile } from '../../../shared/os/hostProfile';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import { runCommandSpec } from '../../../shared/exec/runCommandSpec';
import type { IFileOps } from '../../../shared/fs/fileOps';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';

export function execLocal(command: string, args: string[], timeoutMs = 5000): Promise<ExecResult> {
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

export class LocalTransport implements IServerTransport, IMuxTransport, IHostBoundTransport {
  private sessionCounter = 0;
  private fileOps: IFileOps | null = null;

  /** `hostProfile`: the host this transport runs commands on (the hub's own, from its HostEnv). Null when the hub's OS / architecture is not one AZITO knows: unknown, treated as POSIX like an unrecorded agent. */
  constructor(private rt: TmuxRuntime, private publicUrl: string, private homeDir: string, private taskTempFiles: TaskTempFiles, readonly hostProfile: HostProfile | null) {}

  /** Node `fs` on the hub itself (the same code an agent runs for its own files). */
  files(): IFileOps {
    this.fileOps ??= new LocalFileOps(localFileOpsHost({ platform: this.taskTempFiles.hubPlatform, homeDir: this.homeDir }));
    return this.fileOps;
  }

  run(spec: CommandSpec): Promise<CommandResult> {
    return runCommandSpec(spec, { windows: this.taskTempFiles.hubPlatform === 'win32' });
  }

  /** @deprecated POSIX-only: runs `command` with `/bin/sh -c`. Rejects on a win32 host. */
  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    assertPosixHost(this.hostProfile, 'this host');
    return execLocal('/bin/sh', ['-c', command], timeoutMs);
  }

  async execMux(req: MuxExecRequest): Promise<ExecResult> {
    return execLocal(this.rt.bin, [...this.rt.baseArgs, ...req.args]);
  }

  async openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: import('./ServerTransport').OpenTerminalOpts): Promise<ITerminalStream> {
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
    bin?: string,
  ): ITerminalStream {
    try {
      const ptyProcess = pty.spawn(bin ?? this.rt.bin, argv, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.homeDir,
        env: env ?? (process.env as Record<string, string>),
      });
      return new LocalTerminalStream(ptyProcess, cleanup ?? null);
    } catch (err) {
      throw new Error(`Failed to start terminal: ${(err as Error).message}`);
    }
  }

  createPaneStream(handle: PaneHandle): IPaneStream {
    return new PaneOutputStream(this.taskTempFiles.pipeFile({ type: 'local' }, handle as string, Date.now()));
  }
}
