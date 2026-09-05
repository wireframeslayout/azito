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
import { type MuxRef, type PaneHandle, type PaneOrdinal, tmuxTargetFromMuxRef } from '@azito/shared';

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
    private linkedSessionName: string | null,
    private rt: TmuxRuntime,
  ) {
    super();
    ptyProcess.onData((data: string) => this.emit('data', data));
    ptyProcess.onExit(() => {
      this.emit('close');
      this.killLinkedSession();
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
    this.killLinkedSession();
  }

  private killLinkedSession(): void {
    if (this.linkedSessionName) {
      execFile(this.rt.bin, [...this.rt.baseArgs, 'kill-session', '-t', this.linkedSessionName], () => {});
    }
  }
}

export class LocalTransport implements IServerTransport, IMuxTransport {
  private sessionCounter = 0;

  constructor(private rt: TmuxRuntime, private publicUrl: string) {}

  exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    return execLocal('/bin/sh', ['-c', command], timeoutMs);
  }

  execMux(args: string[]): Promise<ExecResult> {
    return execLocal(this.rt.bin, [...this.rt.baseArgs, ...args]);
  }

  /** @deprecated Use execMux */
  execTmux(args: string[]): Promise<ExecResult> {
    return this.execMux(args);
  }

  async openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream>;
  /** @deprecated Use MuxRef overload */
  async openTerminal(target: string, cols: number, rows: number): Promise<ITerminalStream>;
  async openTerminal(refOrTarget: MuxRef | string, colsOrOrdinal: PaneOrdinal | number, rowsOrCols: number, maybeRows?: number): Promise<ITerminalStream> {
    let sessionName: string;
    let windowTarget: string;
    let cols: number;
    let rows: number;
    if (typeof refOrTarget === 'string') {
      const match = refOrTarget.match(/^([^:]+):(.+?)(?:\.(\d+))?$/);
      if (!match) throw new Error(`Invalid target: ${refOrTarget}`);
      [, sessionName, windowTarget] = match;
      cols = colsOrOrdinal;
      rows = rowsOrCols;
    } else {
      const tmuxTarget = tmuxTargetFromMuxRef(refOrTarget);
      const colonIdx = tmuxTarget.indexOf(':');
      sessionName = tmuxTarget.slice(0, colonIdx);
      windowTarget = tmuxTarget.slice(colonIdx + 1);
      cols = rowsOrCols;
      rows = maybeRows!;
    }

    await new Promise<void>((resolve, reject) => {
      execFile(this.rt.bin, [...this.rt.baseArgs, 'list-panes', '-t', `${sessionName}:${windowTarget}`], (err) => {
        if (err) reject(new Error('WINDOW_NOT_FOUND'));
        else resolve();
      });
    });

    await new Promise<void>((resolve) => {
      execFile(this.rt.bin, [...this.rt.baseArgs, 'set-option', '-s', 'set-clipboard', 'on'], () => resolve());
    });

    const linkedSessionName = `_azito_${sessionName}_${++this.sessionCounter}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      // startPty runs inside execFile callbacks, so a synchronous throw from
      // pty.spawn (e.g. "posix_spawnp failed" when node-pty's spawn-helper is
      // not executable) escapes into the event loop and kills the whole hub —
      // every other session with it. Route it into the promise instead, so the
      // WS handler can report it on the one terminal that failed.
      const attach = (tmuxArgs: string[], linked: string | null): void => {
        try {
          resolve(this.startPty(tmuxArgs, cols, rows, linked));
        } catch (err) {
          reject(new Error(`Failed to start terminal: ${(err as Error).message}`));
        }
      };

      execFile(this.rt.bin, [...this.rt.baseArgs, 'new-session', '-d', '-t', sessionName, '-s', linkedSessionName, '-e', `AZITO_URL=${this.publicUrl}`], (err) => {
        if (err) {
          attach(['attach-session', '-t', `${sessionName}:${windowTarget}`], null);
          return;
        }

        execFile(this.rt.bin, [...this.rt.baseArgs, 'set-option', '-t', linkedSessionName, 'status', 'off'], () => {
          execFile(this.rt.bin, [...this.rt.baseArgs, 'select-window', '-t', `${linkedSessionName}:${windowTarget}`], () => {
            attach(['attach-session', '-t', linkedSessionName], linkedSessionName);
          });
        });
      });
    });
  }

  private startPty(
    tmuxArgs: string[],
    cols: number,
    rows: number,
    linkedSessionName: string | null,
  ): ITerminalStream {
    const ptyProcess = pty.spawn(this.rt.bin, [...this.rt.baseArgs, ...tmuxArgs], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    });
    return new LocalTerminalStream(ptyProcess, linkedSessionName, this.rt);
  }

  createPaneStream(handle: PaneHandle): IPaneStream;
  /** @deprecated Use PaneHandle overload */
  createPaneStream(paneId: string): IPaneStream;
  createPaneStream(handleOrId: PaneHandle | string): IPaneStream {
    return new PaneOutputStream(handleOrId as string);
  }
}
