import type { ExecResult } from '../servers/transport/ServerTransport';
import type { TransportFactory } from '../servers/transport/TransportFactory';
export { ServerConfig } from '../servers/Server';
import type { ServerConfig } from '../servers/Server';
import { generateWindowName, extractWindowId } from './windowNameUtils';

// ─── Types ───

export interface TmuxPane {
  index: number;
  command: string;
  title: string;
  width: number;
  height: number;
  active: boolean;
  pid: number;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: TmuxPane[];
  activity: number;
}

export interface TmuxSession {
  name: string;
  windowCount: number;
  attached: boolean;
  created: number;
  windows: TmuxWindow[];
}

// ─── Special keys for send-keys ───

const SPECIAL_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Space', 'BSpace',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  'C-c', 'C-d', 'C-z', 'C-a', 'C-e', 'C-k', 'C-l', 'C-u', 'C-w', 'C-r',
  'M-b', 'M-f',
]);

// ─── Window spec matching ───

/**
 * Match the window part of a `session:windowSpec[.pane]` target against a
 * window's index and name. Two subtleties:
 * - tmux resolves a fully numeric spec as a window *index*, so a numeric spec
 *   must never match a coincidentally numeric window *name*.
 * - A trailing `.digits` may be a pane suffix or part of the window name
 *   itself (e.g. a window literally named `foo.1`), so both the raw and the
 *   pane-stripped forms of the spec are tried.
 * An empty spec matches nothing — session-only targets are the caller's call.
 */
export function windowSpecMatches(windowSpec: string, windowIndex: number, windowName: string): boolean {
  for (const spec of new Set([windowSpec, windowSpec.replace(/\.\d+$/, '')])) {
    if (!spec) continue;
    if (/^\d+$/.test(spec) ? spec === String(windowIndex) : spec === windowName) return true;
  }
  return false;
}

// ─── TmuxClient ───

export class TmuxClient {
  constructor(private transportFactory: TransportFactory, private publicUrl: string, private uiToken: string) {}

  private async runTmuxCommand(server: ServerConfig, args: string[]): Promise<ExecResult> {
    return this.transportFactory.getTransport(server).execTmux(args);
  }

  async listSessions(server: ServerConfig): Promise<TmuxSession[]> {
    const format = [
      '#{session_name}', '#{session_windows}', '#{session_attached}', '#{session_created}',
      '#{window_index}', '#{window_name}', '#{window_active}', '#{window_activity}',
      '#{pane_index}', '#{pane_current_command}', '#{pane_width}', '#{pane_height}', '#{pane_active}', '#{pane_pid}', '#{pane_title}',
    ].join('|||');

    try {
      const { stdout } = await this.runTmuxCommand(server, ['list-panes', '-a', '-F', format]);

      const sessionMap = new Map<string, {
        name: string;
        windowCount: number;
        attached: boolean;
        created: number;
        windows: Map<number, TmuxWindow>;
      }>();

      for (const line of stdout.trim().split('\n')) {
        if (!line) continue;
        const parts = line.split('|||');
        const [sName, sWindows, sAttached, sCreated, wIndex, wName, wActive, wActivity, pIndex, pCommand, pWidth, pHeight, pActive, pPid, pTitle] = parts;

        if (!sessionMap.has(sName)) {
          sessionMap.set(sName, {
            name: sName,
            windowCount: parseInt(sWindows, 10),
            attached: sAttached === '1',
            created: parseInt(sCreated, 10),
            windows: new Map(),
          });
        }

        const session = sessionMap.get(sName)!;
        const wIdx = parseInt(wIndex, 10);
        if (!session.windows.has(wIdx)) {
          session.windows.set(wIdx, {
            index: wIdx,
            name: wName,
            active: wActive === '1',
            activity: parseInt(wActivity, 10),
            panes: [],
          });
        }

        session.windows.get(wIdx)!.panes.push({
          index: parseInt(pIndex, 10),
          command: pCommand,
          title: pTitle || '',
          width: parseInt(pWidth, 10),
          height: parseInt(pHeight, 10),
          active: pActive === '1',
          pid: parseInt(pPid, 10),
        });
      }

      return Array.from(sessionMap.values())
        .filter((s) => !s.name.startsWith('_azito_'))
        .map((s) => ({
          ...s,
          windows: Array.from(s.windows.values()),
        }));
    } catch (err: unknown) {
      const e = err as { message?: string; stderr?: string };
      if (e.message?.includes('no server running') || e.stderr?.includes('no server running')) {
        return [];
      }
      throw err;
    }
  }

  /**
   * `tmux new-session` always creates one window — there is no such thing as a
   * session with zero windows. Callers that immediately want a specific window
   * should pass `windowName` + `exactName` so that first window *is* the one
   * they want; otherwise the generated `win--xxxx` shell is left behind as an
   * orphan nobody manages.
   */
  async createSession(server: ServerConfig, sessionName: string, options?: { command?: string; windowName?: string; exactName?: boolean; extraEnv?: Record<string, string> }): Promise<{ result: ExecResult; windowName: string }> {
    const windowName = options?.exactName && options?.windowName
      ? options.windowName
      : generateWindowName(options?.windowName || 'win');
    const args = ['new-session', '-d', '-s', sessionName, '-n', windowName, '-e', `AZITO_URL=${this.publicUrl}`];
    if (this.uiToken) args.push('-e', `AZITO_UI_TOKEN=${this.uiToken}`);
    if (options?.extraEnv) {
      for (const [k, v] of Object.entries(options.extraEnv)) {
        args.push('-e', `${k}=${v}`);
      }
    }
    if (options?.command) args.push(options.command);
    const result = await this.runTmuxCommand(server, args);
    await this.setWindowStatusFormat(server, sessionName, windowName);
    return { result, windowName };
  }

  async createWindow(server: ServerConfig, sessionName: string, baseName?: string, options?: { exactName?: boolean; extraEnv?: Record<string, string> }): Promise<{ result: ExecResult; windowName: string }> {
    const windowName = options?.exactName && baseName ? baseName : generateWindowName(baseName || 'win');
    const args = ['new-window', '-t', sessionName, '-n', windowName, '-e', `AZITO_URL=${this.publicUrl}`];
    if (this.uiToken) args.push('-e', `AZITO_UI_TOKEN=${this.uiToken}`);
    if (options?.extraEnv) {
      for (const [k, v] of Object.entries(options.extraEnv)) {
        args.push('-e', `${k}=${v}`);
      }
    }
    const result = await this.runTmuxCommand(server, args);
    await this.setWindowStatusFormat(server, sessionName, windowName);
    return { result, windowName };
  }

  private async setWindowStatusFormat(server: ServerConfig, sessionName: string, windowName: string): Promise<void> {
    const id = extractWindowId(windowName);
    if (!id) return;
    await this.runTmuxCommand(server, [
      'set-window-option', '-t', `${sessionName}:${windowName}`,
      'window-status-format', `#I:${windowName}`,
    ]).catch(() => {});
  }

  /**
   * display-message silently falls back to the session's active window when the
   * window part of the target doesn't match anything — reject such answers, or a
   * caller would mistake a nonexistent window for its session's active one.
   * A session-only target (no window part) is accepted: the active window is
   * then exactly what the caller addressed.
   */
  private matchesWindowSpec(target: string, windowIndex: number, windowName: string): boolean {
    const colonIdx = target.indexOf(':');
    const windowSpec = colonIdx === -1 ? '' : target.slice(colonIdx + 1);
    return !windowSpec || windowSpecMatches(windowSpec, windowIndex, windowName);
  }


  async getWindowActivity(server: ServerConfig, target: string): Promise<number | null> {
    try {
      const { stdout, code } = await this.runTmuxCommand(server, [
        'display-message', '-p', '-t', target, '#{window_activity}|#{window_index}|#{window_name}',
      ]);
      if (code !== 0) return null;
      const [activityStr, windowIndexStr, windowName] = stdout.trim().split('|');
      const activity = parseInt(activityStr, 10);
      const windowIndex = parseInt(windowIndexStr, 10);
      if (Number.isNaN(activity) || !windowName || Number.isNaN(windowIndex)) return null;
      if (!this.matchesWindowSpec(target, windowIndex, windowName)) return null;
      return activity;
    } catch {
      return null;
    }
  }

  /** Resolve a window target to its canonical identity. Returns null when the target doesn't exist. */
  async getWindowIdentity(server: ServerConfig, target: string): Promise<{ sessionName: string; windowIndex: number; windowName: string } | null> {
    try {
      const { stdout, code } = await this.runTmuxCommand(server, [
        'display-message', '-p', '-t', target, '#{session_name}|#{window_index}|#{window_name}',
      ]);
      if (code !== 0) return null;
      const [sessionName, windowIndexStr, windowName] = stdout.trim().split('|');
      const windowIndex = parseInt(windowIndexStr, 10);
      if (!sessionName || !windowName || Number.isNaN(windowIndex)) return null;
      if (!this.matchesWindowSpec(target, windowIndex, windowName)) return null;
      return { sessionName, windowIndex, windowName };
    } catch {
      return null;
    }
  }

  /**
   * Foreground command of the target pane (`#{pane_current_command}`, e.g.
   * "claude", "bash"). Returns null when the pane doesn't exist or tmux
   * errors — callers decide how to treat the unknown case.
   */
  async getPaneCurrentCommand(server: ServerConfig, target: string): Promise<string | null> {
    try {
      const { stdout, code } = await this.runTmuxCommand(server, [
        'display-message', '-p', '-t', target, '#{pane_current_command}',
      ]);
      if (code !== 0) return null;
      const command = stdout.trim();
      return command.length > 0 ? command : null;
    } catch {
      return null;
    }
  }

  async resolvePaneId(server: ServerConfig, windowTarget: string): Promise<string> {
    const { stdout, code } = await this.runTmuxCommand(server, [
      'list-panes', '-t', windowTarget, '-F', '#{pane_id}',
    ]);
    if (code !== 0) {
      throw new Error(`Failed to resolve pane ID for target "${windowTarget}"`);
    }
    const firstPaneId = stdout.trim().split('\n')[0];
    if (!firstPaneId || !firstPaneId.startsWith('%')) {
      throw new Error(`No valid pane ID found for target "${windowTarget}"`);
    }
    return firstPaneId;
  }

  async listPaneIds(server: ServerConfig, windowTarget: string): Promise<Array<{ index: number; paneId: string }>> {
    const { stdout, code } = await this.runTmuxCommand(server, [
      'list-panes', '-t', windowTarget, '-F', '#{pane_index}|||#{pane_id}',
    ]);
    if (code !== 0) {
      throw new Error(`Failed to list pane IDs for target "${windowTarget}"`);
    }
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [idx, id] = line.split('|||');
      return { index: parseInt(idx, 10), paneId: id };
    });
  }

  async checkPaneExists(server: ServerConfig, target: string): Promise<boolean> {
    try {
      await this.runTmuxCommand(server, ['list-panes', '-t', target]);
      return true;
    } catch {
      return false;
    }
  }

  async splitPane(server: ServerConfig, target: string, direction: 'h' | 'v'): Promise<ExecResult> {
    const flag = direction === 'h' ? '-h' : '-v';
    return this.runTmuxCommand(server, ['split-window', flag, '-t', target]);
  }

  async killSession(server: ServerConfig, sessionName: string): Promise<ExecResult> {
    return this.runTmuxCommand(server, ['kill-session', '-t', sessionName]);
  }

  async killWindow(server: ServerConfig, target: string): Promise<ExecResult> {
    return this.runTmuxCommand(server, ['kill-window', '-t', target]);
  }

  async killPane(server: ServerConfig, target: string): Promise<ExecResult> {
    return this.runTmuxCommand(server, ['kill-pane', '-t', target]);
  }

  async capturePane(
    server: ServerConfig,
    target: string,
    startLine?: number,
    endLine?: number,
  ): Promise<ExecResult> {
    const args = ['capture-pane', '-p', '-t', target, '-e'];
    if (startLine != null) args.push('-S', String(startLine));
    if (endLine != null) args.push('-E', String(endLine));
    return this.runTmuxCommand(server, args);
  }

  async sendKeys(server: ServerConfig, target: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (SPECIAL_KEYS.has(key)) {
        await this.runTmuxCommand(server, ['send-keys', '-t', target, key]);
      } else if (Buffer.byteLength(key, 'utf8') > 500) {
        await this.sendLongText(server, target, key);
        if (keys[i + 1] === 'Enter') {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } else {
        await this.runTmuxCommand(server, ['send-keys', '-t', target, '-l', key]);
      }
    }
  }

  private async sendLongText(server: ServerConfig, target: string, text: string): Promise<void> {
    if (server.type === 'local') {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-tmux-'));
      fs.chmodSync(tmpDir, 0o700);
      const tmpFile = path.join(tmpDir, 'buf');
      fs.writeFileSync(tmpFile, text, { mode: 0o600 });
      try {
        await this.runTmuxCommand(server, ['load-buffer', tmpFile]);
        await this.runTmuxCommand(server, ['paste-buffer', '-t', target, '-d']);
        await new Promise(resolve => setTimeout(resolve, 3000));
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
        try { fs.rmdirSync(tmpDir); } catch {}
      }
    } else {
      const chunks = [];
      for (let i = 0; i < text.length; i += 200) {
        chunks.push(text.slice(i, i + 200));
      }
      for (const chunk of chunks) {
        await this.runTmuxCommand(server, ['send-keys', '-t', target, '-l', chunk]);
      }
    }
  }

  async startPipePane(server: ServerConfig, target: string, outputPath: string): Promise<void> {
    const stripCmd = `stdbuf -o0 sed -u -e 's/\\x1b\\[[0-9;?]*[a-zA-Z]//g' -e 's/\\x1b][^\\x07]*\\x07//g' -e 's/\\x1b[()][0-9A-Z]//g' -e 's/\\x1b[<>=]//g' -e 's/\\x0f//g' -e 's/\\x0e//g' >> ${outputPath}`;
    await this.runTmuxCommand(server, ['pipe-pane', '-O', '-t', target, stripCmd]);
  }

  async stopPipePane(server: ServerConfig, target: string): Promise<void> {
    await this.runTmuxCommand(server, ['pipe-pane', '-t', target]);
  }

  async renameWindow(server: ServerConfig, target: string, newName: string): Promise<ExecResult> {
    return this.runTmuxCommand(server, ['rename-window', '-t', target, newName]);
  }

  async renamePane(server: ServerConfig, target: string, newTitle: string): Promise<ExecResult> {
    return this.runTmuxCommand(server, ['select-pane', '-t', target, '-T', newTitle]);
  }

  async renameSession(server: ServerConfig, oldName: string, newName: string): Promise<ExecResult> {
    return this.runTmuxCommand(server, ['rename-session', '-t', oldName, newName]);
  }

  async cleanupLinkedSessions(server: ServerConfig): Promise<number> {
    try {
      const { stdout } = await this.runTmuxCommand(server, [
        'list-sessions', '-F', '#{session_name} #{session_attached}',
      ]);
      const stale = stdout.trim().split('\n')
        .map((line) => { const [name, att] = line.split(' '); return { name, attached: att === '1' }; })
        .filter((s) => s.name.startsWith('_azito_') && !s.attached);

      for (const s of stale) {
        await this.runTmuxCommand(server, ['kill-session', '-t', s.name]).catch(() => {});
      }
      return stale.length;
    } catch {
      return 0;
    }
  }

  async zoomPane(server: ServerConfig, target: string): Promise<ExecResult> {
    const check = await this.runTmuxCommand(server, [
      'display-message', '-p', '-t', target, '#{window_zoomed_flag}',
    ]);
    if (check.stdout.trim() === '1') {
      // Already zoomed — unzoom first so we can zoom the requested pane
      await this.runTmuxCommand(server, ['resize-pane', '-Z', '-t', target]);
    }
    return this.runTmuxCommand(server, ['resize-pane', '-Z', '-t', target]);
  }

  async unzoomPane(server: ServerConfig, target: string): Promise<ExecResult> {
    const check = await this.runTmuxCommand(server, [
      'display-message', '-p', '-t', target, '#{window_zoomed_flag}',
    ]);
    if (check.stdout.trim() !== '1') return { stdout: '', stderr: '', code: 0 };
    return this.runTmuxCommand(server, ['resize-pane', '-Z', '-t', target]);
  }

  /** Execute an arbitrary shell command on the server (local or remote). */
  async execCommand(server: ServerConfig, command: string): Promise<ExecResult> {
    return this.transportFactory.getTransport(server).exec(command);
  }
}
