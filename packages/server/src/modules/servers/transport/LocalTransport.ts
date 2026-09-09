import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
import { HerdrSocketClient } from '../../mux/herdr/HerdrSocketClient';
import { herdrClientConfigPath } from '../../mux/herdr/herdrClientConfig';
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

  constructor(private rt: TmuxRuntime, private publicUrl: string, private herdrSocket?: HerdrSocketClient) {}

  exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    return execLocal('/bin/sh', ['-c', command], timeoutMs);
  }

  async execMux(req: MuxExecRequest): Promise<ExecResult> {
    if (req.kind === 'herdr') {
      if (!this.herdrSocket) throw new Error('LocalTransport: herdr socket not configured');
      const result = await this.herdrSocket.call(req.method, req.params);
      return { stdout: JSON.stringify(result), stderr: '', code: 0 };
    }
    if (req.kind === 'zellij-ctl') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (req.kind === 'zellij') {
      return execLocal(resolveZellijBin(), req.args);
    }
    return execLocal(this.rt.bin, [...this.rt.baseArgs, ...req.args]);
  }

  async openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: import('./ServerTransport').OpenTerminalOpts): Promise<ITerminalStream> {
    if (ref.kind === 'herdr') {
      return this.openHerdrTerminal(ref, ordinal, cols, rows, opts);
    }
    if (ref.kind === 'zellij') {
      return this.openZellijTerminal(ref, ordinal, cols, rows);
    }
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

  private async openHerdrTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: import('./ServerTransport').OpenTerminalOpts): Promise<ITerminalStream> {
    if (!this.herdrSocket) throw new Error('LocalTransport: herdr socket not configured');
    const sock = this.herdrSocket;
    const resp = await sock.callRpc('session.snapshot');
    const snap = resp.snapshot as { workspaces: Array<{ workspace_id: string; label: string }>; tabs: Array<{ tab_id: string; workspace_id: string; label: string }>; panes: Array<{ pane_id: string; tab_id: string }> } | undefined;
    if (!snap) throw new Error('WINDOW_NOT_FOUND');
    const ws = snap.workspaces.find((w) => w.label === ref.workspace);
    if (!ws) throw new Error('WINDOW_NOT_FOUND');
    try {
      await sock.callRpc('workspace.focus', { workspace_id: ws.workspace_id });
      const tab = snap.tabs.find((t) => t.workspace_id === ws.workspace_id);
      if (tab) {
        await sock.callRpc('tab.focus', { tab_id: tab.tab_id }).catch(() => {});
        const panesInTab = snap.panes.filter((p) => p.tab_id === tab.tab_id);
        const target = panesInTab[ordinal - 1];
        if (target) {
          await sock.callRpc('pane.focus', { pane_id: target.pane_id }).catch(() => {});
        }
      }
    } catch { /* best-effort focus */ }
    const env: Record<string, string> = { HERDR_SESSION: sock.sessionName };
    if (opts?.herdrLock) {
      env.HERDR_CONFIG_PATH = herdrClientConfigPath(opts.herdrLock);
    }
    return this.spawnTerminal([], cols, rows, { ...process.env as Record<string, string>, ...env }, undefined, 'herdr');
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
        cwd: process.env.HOME,
        env: env ?? (process.env as Record<string, string>),
      });
      return new LocalTerminalStream(ptyProcess, cleanup ?? null);
    } catch (err) {
      throw new Error(`Failed to start terminal: ${(err as Error).message}`);
    }
  }

  private async openZellijTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream> {
    const zellijBin = resolveZellijBin();
    try {
      await execLocal(zellijBin, ['--session', ref.workspace, 'action', 'go-to-tab-name', ref.window]);
    } catch { /* best-effort tab focus */ }
    if (ordinal > 0) {
      try {
        const listResult = await execLocal(zellijBin, ['--session', ref.workspace, 'action', 'list-panes', '--all', '--json']);
        const panes = JSON.parse(listResult.stdout) as Array<{ id: number; is_plugin: boolean; is_floating: boolean; is_suppressed: boolean; tab_name: string }>;
        const tabTerminals = panes.filter((p) => p.tab_name === ref.window && !p.is_plugin && !p.is_floating && !p.is_suppressed);
        const target = tabTerminals[ordinal - 1];
        if (target) {
          const paneId = `terminal_${target.id}`;
          await execLocal(zellijBin, ['--session', ref.workspace, 'action', 'focus-pane-id', paneId]);
        }
      } catch { /* best-effort pane focus */ }
    }
    return this.spawnTerminal(
      ['attach', ref.workspace],
      cols,
      rows,
      undefined,
      undefined,
      zellijBin,
    );
  }

  createPaneStream(handle: PaneHandle): IPaneStream {
    return new PaneOutputStream(handle as string);
  }
}

function resolveZellijBin(): string {
  const userBin = path.join(os.homedir(), '.local', 'bin', 'zellij');
  try { fs.accessSync(userBin, fs.constants.X_OK); return userBin; } catch { return 'zellij'; }
}
