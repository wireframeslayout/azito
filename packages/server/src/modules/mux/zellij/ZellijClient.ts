import type {
  MuxCapabilities,
  MuxRef,
  PaneHandle,
  PaneOrdinal,
  MuxWorkspace,
  MuxWindowInfo,
  MuxPane,
  MuxPaneInfo,
  MuxDriverKind,
} from '@azito/shared';
import { asPaneHandle, zellijMuxRef } from '@azito/shared';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { ExecResult, ITerminalStream } from '../../servers/transport/ServerTransport';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { MuxCapabilityMissingError } from '../../tmux/MuxCapabilityError';
import { parseListSessions, parseQueryTabNames, parseListPanes, formatZellijPaneId, parseZellijPaneId, type ZellijPaneInfo } from './zellijParse';
import { tmuxKeysToZellij } from './zellijKeyMap';

export class ZellijClient implements IMuxClient {
  readonly kind: MuxDriverKind = 'zellij';

  readonly caps: MuxCapabilities = {
    outputStream: false,
    changeEvents: false,
    agentState: false,
    independentClients: true,
    envInjection: true,
    zoom: false,
    copyMode: false,
    paneTitle: false,
    activityCounter: false,
    layoutSnapshot: true,
    stablePaneHandle: true,
  };

  constructor(
    private transportFactory: TransportFactory,
    private sessionName: string = 'azito',
  ) {}

  // ─── helpers ───

  private async execAction(server: ServerConfig, args: string[]): Promise<ExecResult> {
    return this.transportFactory.getTransport(server).execMux({
      kind: 'zellij',
      args: ['--session', this.sessionName, 'action', ...args],
    });
  }

  private async execZellij(server: ServerConfig, args: string[]): Promise<ExecResult> {
    return this.transportFactory.getTransport(server).execMux({
      kind: 'zellij',
      args,
    });
  }

  private okResult(): ExecResult {
    return { stdout: '', stderr: '', code: 0 };
  }

  private async allPanes(server: ServerConfig): Promise<ZellijPaneInfo[]> {
    const result = await this.execAction(server, ['list-panes', '--all', '--json']);
    return parseListPanes(result.stdout);
  }

  private terminalPanesForTab(panes: ZellijPaneInfo[], tabName: string): ZellijPaneInfo[] {
    return panes.filter((p) => p.tabName === tabName && !p.isPlugin && !p.isFloating && !p.isSuppressed);
  }

  private async resolveTabId(server: ServerConfig, tabName: string): Promise<number> {
    const panes = await this.allPanes(server);
    const pane = panes.find((p) => p.tabName === tabName);
    if (!pane) throw new Error(`Tab "${tabName}" not found in session "${this.sessionName}"`);
    return pane.tabId;
  }

  private locks = new Map<string, Promise<void>>();

  private async withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.sessionName;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.locks.set(key, next);
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  // ─── Workspace / Window ───

  async listWorkspaces(server: ServerConfig): Promise<MuxWorkspace[]> {
    const sessionsResult = await this.execZellij(server, ['list-sessions', '--no-formatting']);
    const sessions = parseListSessions(sessionsResult.stdout);
    if (!sessions.includes(this.sessionName)) return [];

    const tabsResult = await this.execAction(server, ['query-tab-names']);
    const tabNames = parseQueryTabNames(tabsResult.stdout);
    const panes = await this.allPanes(server);

    const windows: MuxWindowInfo[] = tabNames.map((name, i) => {
      const tabPanes = this.terminalPanesForTab(panes, name);
      return {
        index: i,
        name,
        active: tabPanes.some((p) => p.isFocused),
        panes: tabPanes.map((p, j) => ({
          index: j,
          command: p.paneCommand ?? '',
          title: p.title,
          width: p.paneColumns,
          height: p.paneRows,
          active: p.isFocused,
          pid: 0,
        } satisfies MuxPane)),
        activity: 0,
      };
    });

    return [{
      name: this.sessionName,
      windowCount: tabNames.length,
      attached: true,
      created: 0,
      windows,
    }];
  }

  async listWorkspacesStrict(server: ServerConfig): Promise<MuxWorkspace[]> {
    return this.listWorkspaces(server);
  }

  async openWorkspace(
    server: ServerConfig,
    name: string,
    opts?: { command?: string; windowName?: string; exactName?: boolean; extraEnv?: Record<string, string> },
  ): Promise<{ ref: MuxRef; result: ExecResult }> {
    const sessionsResult = await this.execZellij(server, ['list-sessions', '--no-formatting']);
    const sessions = parseListSessions(sessionsResult.stdout);

    const windowName = opts?.windowName ?? 'default';

    if (sessions.includes(name)) {
      await this.transportFactory.getTransport(server).execMux({
        kind: 'zellij',
        args: ['--session', name, 'action', 'new-tab', '--name', windowName],
      });
      return { ref: zellijMuxRef(name, windowName), result: this.okResult() };
    }

    throw new Error(`Zellij session "${name}" does not exist. Start it with: zellij attach --session ${name}`);
  }

  async openWindow(
    server: ServerConfig,
    workspace: string,
    baseName?: string,
    opts?: { exactName?: boolean; extraEnv?: Record<string, string> },
  ): Promise<{ ref: MuxRef; result: ExecResult }> {
    const args = ['new-tab'];
    if (baseName) args.push('--name', baseName);
    const result = await this.execAction(server, args);
    const tabId = result.stdout.trim();
    const windowName = baseName ?? `tab-${tabId}`;
    return { ref: zellijMuxRef(workspace, windowName), result: this.okResult() };
  }

  async closeWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> {
    const tabId = await this.resolveTabId(server, ref.window);
    await this.execAction(server, ['close-tab', '--tab-id', String(tabId)]);
    return this.okResult();
  }

  async closeWorkspace(server: ServerConfig, workspace: string): Promise<ExecResult> {
    await this.execZellij(server, ['kill-session', workspace]);
    return this.okResult();
  }

  async renameWindowByRef(server: ServerConfig, ref: MuxRef, name: string): Promise<ExecResult> {
    const tabId = await this.resolveTabId(server, ref.window);
    await this.execAction(server, ['rename-tab', '--tab-id', String(tabId), name]);
    return this.okResult();
  }

  async renameWorkspace(_server: ServerConfig, _from: string, _to: string): Promise<ExecResult> {
    throw new Error('Zellij does not support session rename via CLI');
  }

  async windowExists(server: ServerConfig, ref: MuxRef): Promise<boolean> {
    try {
      const result = await this.execAction(server, ['query-tab-names']);
      const tabs = parseQueryTabNames(result.stdout);
      return tabs.includes(ref.window);
    } catch {
      return false;
    }
  }

  async resolveRef(server: ServerConfig, target: string): Promise<MuxRef | null> {
    const sep = target.indexOf(':');
    if (sep === -1) return null;
    const [session, tabName] = [target.slice(0, sep), target.slice(sep + 1)];
    const ref = zellijMuxRef(session, tabName);
    if (await this.windowExists(server, ref)) return ref;
    return null;
  }

  // ─── Pane ───

  async resolvePane(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal): Promise<PaneHandle> {
    const panes = await this.listPanesByRef(server, ref);
    if (ordinal < 1 || ordinal > panes.length) {
      throw new Error(`Pane ordinal ${ordinal} out of range (1..${panes.length})`);
    }
    return panes[ordinal - 1].handle;
  }

  async listPanesByRef(
    server: ServerConfig,
    ref: MuxRef,
  ): Promise<Array<{ ordinal: PaneOrdinal; handle: PaneHandle; title: string; command: string; active: boolean }>> {
    const panes = await this.allPanes(server);
    const tabPanes = this.terminalPanesForTab(panes, ref.window);
    return tabPanes.map((p, i) => ({
      ordinal: (i + 1) as PaneOrdinal,
      handle: asPaneHandle(formatZellijPaneId(p.id, p.isPlugin)),
      title: p.title,
      command: p.paneCommand ?? '',
      active: p.isFocused,
    }));
  }

  async listAllPanes(server: ServerConfig): Promise<MuxPaneInfo[]> {
    const panes = await this.allPanes(server);
    return panes
      .filter((p) => !p.isPlugin && !p.isFloating && !p.isSuppressed)
      .map((p) => {
        const tabTerminals = panes.filter(
          (tp) => tp.tabName === p.tabName && !tp.isPlugin && !tp.isFloating && !tp.isSuppressed,
        );
        return {
          paneId: formatZellijPaneId(p.id, p.isPlugin),
          sessionName: this.sessionName,
          windowIndex: p.tabPosition,
          windowName: p.tabName,
          paneIndex: tabTerminals.indexOf(p),
          currentPath: p.paneCwd ?? '',
          currentCommand: p.paneCommand ?? '',
        };
      });
  }

  async refFromPaneHandle(server: ServerConfig, handle: PaneHandle): Promise<{ ref: MuxRef; ordinal: PaneOrdinal } | null> {
    const { id, isPlugin } = parseZellijPaneId(handle as string);
    const panes = await this.allPanes(server);
    const pane = panes.find((p) => p.id === id && p.isPlugin === isPlugin);
    if (!pane) return null;
    const tabTerminals = this.terminalPanesForTab(panes, pane.tabName);
    const idx = tabTerminals.findIndex((p) => p.id === id && p.isPlugin === isPlugin);
    if (idx === -1) return null;
    return { ref: zellijMuxRef(this.sessionName, pane.tabName), ordinal: (idx + 1) as PaneOrdinal };
  }

  async probePane(server: ServerConfig, handle: PaneHandle): Promise<{ alive: boolean; verified: boolean }> {
    try {
      const { id, isPlugin } = parseZellijPaneId(handle as string);
      const panes = await this.allPanes(server);
      const pane = panes.find((p) => p.id === id && p.isPlugin === isPlugin);
      if (!pane) return { alive: false, verified: true };
      return { alive: !pane.exited, verified: true };
    } catch {
      return { alive: false, verified: false };
    }
  }

  async splitPaneByHandle(
    server: ServerConfig,
    handle: PaneHandle,
    dir: 'h' | 'v',
    _env?: Record<string, string>,
  ): Promise<{ handle: PaneHandle; result: ExecResult }> {
    // focus-pane-id + new-pane must be atomic
    return this.withSessionLock(async () => {
      await this.execAction(server, ['focus-pane-id', handle as string]);
      const direction = dir === 'h' ? 'right' : 'down';
      const result = await this.execAction(server, ['new-pane', '--direction', direction]);
      const newPaneId = result.stdout.trim();
      return {
        handle: asPaneHandle(newPaneId),
        result: this.okResult(),
      };
    });
  }

  async closePane(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> {
    await this.execAction(server, ['close-pane', '--pane-id', handle as string]);
    return this.okResult();
  }

  async captureScreen(server: ServerConfig, handle: PaneHandle, start?: number, end?: number): Promise<ExecResult> {
    const result = await this.execAction(server, ['dump-screen', '--pane-id', handle as string]);
    let text = result.stdout;
    if (start !== undefined || end !== undefined) {
      const lines = text.split('\n');
      text = lines.slice(start ?? 0, end).join('\n');
    }
    return { stdout: text, stderr: '', code: 0 };
  }

  async sendKeysToHandle(server: ServerConfig, handle: PaneHandle, keys: string[]): Promise<void> {
    const actions = tmuxKeysToZellij(keys);
    for (const action of actions) {
      if (action.type === 'bytes') {
        await this.execAction(server, ['write', '--pane-id', handle as string, ...action.values.map(String)]);
      } else {
        await this.execAction(server, ['write-chars', '--pane-id', handle as string, action.value]);
      }
    }
  }

  async sendTextToHandle(server: ServerConfig, handle: PaneHandle, text: string): Promise<void> {
    await this.execAction(server, ['write-chars', '--pane-id', handle as string, text]);
  }

  async panePidByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<number | null> {
    return null;
  }

  async paneCommandByHandle(server: ServerConfig, handle: PaneHandle): Promise<string | null> {
    try {
      const { id, isPlugin } = parseZellijPaneId(handle as string);
      const panes = await this.allPanes(server);
      const pane = panes.find((p) => p.id === id && p.isPlugin === isPlugin);
      return pane?.paneCommand ?? null;
    } catch {
      return null;
    }
  }

  // ─── Capability-gated ───

  async startOutputStream(_server: ServerConfig, _handle: PaneHandle, _outputPath: string): Promise<void> {
    throw new MuxCapabilityMissingError('outputStream');
  }

  async stopOutputStream(_server: ServerConfig, _handle: PaneHandle): Promise<void> {
    throw new MuxCapabilityMissingError('outputStream');
  }

  async zoomPaneByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<ExecResult> {
    throw new MuxCapabilityMissingError('zoom');
  }

  async unzoomPaneByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<ExecResult> {
    throw new MuxCapabilityMissingError('zoom');
  }

  async isPaneInModeByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<boolean> {
    throw new MuxCapabilityMissingError('copyMode');
  }

  async cancelPaneModeByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<void> {
    throw new MuxCapabilityMissingError('copyMode');
  }

  async setPaneTitle(_server: ServerConfig, _handle: PaneHandle, _title: string): Promise<ExecResult> {
    throw new MuxCapabilityMissingError('paneTitle');
  }

  async windowActivity(_server: ServerConfig, _ref: MuxRef): Promise<number | null> {
    throw new MuxCapabilityMissingError('activityCounter');
  }

  // ─── Layout / Resource ───

  async captureLayout(server: ServerConfig, ref: MuxRef): Promise<{ layout: string; panes: Array<{ index: number; ordinal: PaneOrdinal; command: string | null; path: string | null; title: string | null }> }> {
    const layoutResult = await this.execAction(server, ['dump-layout']);
    const panes = await this.allPanes(server);
    const tabPanes = this.terminalPanesForTab(panes, ref.window);
    return {
      layout: layoutResult.stdout,
      panes: tabPanes.map((p, i) => ({
        index: i,
        ordinal: (i + 1) as PaneOrdinal,
        command: p.paneCommand,
        path: p.paneCwd,
        title: p.title,
      })),
    };
  }

  async applyLayout(_server: ServerConfig, _ref: MuxRef, _layout: string): Promise<ExecResult> {
    throw new Error('Zellij does not support applying layouts via CLI');
  }

  async measurePanePids(_server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>> {
    return [];
  }

  // ─── Terminal / Change Hooks ───

  async openTerminal(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream> {
    return this.transportFactory.getTransport(server).openTerminal(ref, ordinal, cols, rows);
  }

  async installChangeHooks(_server: ServerConfig): Promise<void> {
    // No-op — zellij has no external hook mechanism; polling is used instead.
  }

  async uninstallChangeHooks(_server: ServerConfig): Promise<void> {
    // No-op.
  }
}
