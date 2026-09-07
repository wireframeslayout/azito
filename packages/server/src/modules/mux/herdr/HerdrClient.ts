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
import { herdrMuxRef, herdrPaneHandle, parseHerdrPaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { ExecResult, ITerminalStream } from '../../servers/transport/ServerTransport';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { MuxCapabilityMissingError } from '../../tmux/MuxCapabilityError';
import { tmuxKeysToHerdr } from './herdrKeyMap';

interface SnapshotWorkspace {
  id: string;
  name: string;
  tabs: SnapshotTab[];
}

interface SnapshotTab {
  id: string;
  name: string;
  active: boolean;
  panes: SnapshotPane[];
}

interface SnapshotPane {
  id: string;
  index: number;
  command: string;
  title: string;
  width: number;
  height: number;
  active: boolean;
  pid: number;
  cwd: string;
  agent_status?: string;
}

interface SessionSnapshot {
  session: string;
  workspaces: SnapshotWorkspace[];
}

export class HerdrClient implements IMuxClient {
  readonly kind: MuxDriverKind = 'herdr';

  readonly caps: MuxCapabilities = {
    outputStream: false,
    changeEvents: true,
    agentState: true,
    independentClients: true,
    envInjection: true,
    zoom: false,
    copyMode: false,
    paneTitle: false,
    activityCounter: false,
    layoutSnapshot: false,
  };

  constructor(
    private transportFactory: TransportFactory,
    private sessionName: string = 'azito',
  ) {}

  // ─── helpers ───

  private async rpc(server: ServerConfig, method: string, params: unknown = {}): Promise<unknown> {
    const result = await this.transportFactory.getTransport(server).execMux({
      kind: 'herdr',
      method,
      params,
    });
    return JSON.parse(result.stdout);
  }

  private async snapshot(server: ServerConfig): Promise<SessionSnapshot> {
    return this.rpc(server, 'session.snapshot') as Promise<SessionSnapshot>;
  }

  private findWorkspace(snap: SessionSnapshot, name: string): SnapshotWorkspace | undefined {
    return snap.workspaces.find((w) => w.name === name);
  }

  private findTab(ws: SnapshotWorkspace, name: string): SnapshotTab | undefined {
    return ws.tabs.find((t) => t.name === name);
  }

  private okResult(): ExecResult {
    return { stdout: '', stderr: '', code: 0 };
  }

  // ─── Workspace / Window ───

  async listWorkspaces(server: ServerConfig): Promise<MuxWorkspace[]> {
    const snap = await this.snapshot(server);
    return snap.workspaces.map((ws) => this.toMuxWorkspace(ws));
  }

  async listWorkspacesStrict(server: ServerConfig): Promise<MuxWorkspace[]> {
    return this.listWorkspaces(server);
  }

  async openWorkspace(
    server: ServerConfig,
    name: string,
    opts?: { command?: string; windowName?: string; exactName?: boolean; extraEnv?: Record<string, string> },
  ): Promise<{ ref: MuxRef; result: ExecResult }> {
    const result = await this.rpc(server, 'workspace.create', {
      name,
      ...(opts?.extraEnv ? { env: opts.extraEnv } : {}),
    }) as { id: string; name: string; tab: { id: string; name: string } };

    const ref = herdrMuxRef(result.name, result.tab.name);
    return { ref, result: this.okResult() };
  }

  async openWindow(
    server: ServerConfig,
    workspace: string,
    baseName?: string,
    opts?: { exactName?: boolean; extraEnv?: Record<string, string> },
  ): Promise<{ ref: MuxRef; result: ExecResult }> {
    const snap = await this.snapshot(server);
    const ws = this.findWorkspace(snap, workspace);
    if (!ws) throw new Error(`Workspace "${workspace}" not found`);

    const result = await this.rpc(server, 'tab.create', {
      workspace_id: ws.id,
      ...(baseName ? { name: baseName } : {}),
      ...(opts?.extraEnv ? { env: opts.extraEnv } : {}),
    }) as { id: string; name: string };

    const ref = herdrMuxRef(workspace, result.name);
    return { ref, result: this.okResult() };
  }

  async closeWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> {
    const tabId = await this.resolveTabId(server, ref);
    await this.rpc(server, 'tab.close', { tab_id: tabId });
    return this.okResult();
  }

  async closeWorkspace(server: ServerConfig, workspace: string): Promise<ExecResult> {
    const snap = await this.snapshot(server);
    const ws = this.findWorkspace(snap, workspace);
    if (!ws) throw new Error(`Workspace "${workspace}" not found`);
    await this.rpc(server, 'workspace.close', { workspace_id: ws.id });
    return this.okResult();
  }

  async renameWindowByRef(server: ServerConfig, ref: MuxRef, name: string): Promise<ExecResult> {
    const tabId = await this.resolveTabId(server, ref);
    await this.rpc(server, 'tab.rename', { tab_id: tabId, name });
    return this.okResult();
  }

  async renameWorkspace(server: ServerConfig, from: string, to: string): Promise<ExecResult> {
    const snap = await this.snapshot(server);
    const ws = this.findWorkspace(snap, from);
    if (!ws) throw new Error(`Workspace "${from}" not found`);
    await this.rpc(server, 'workspace.rename', { workspace_id: ws.id, name: to });
    return this.okResult();
  }

  async windowExists(server: ServerConfig, ref: MuxRef): Promise<boolean> {
    try {
      const snap = await this.snapshot(server);
      const ws = this.findWorkspace(snap, ref.workspace);
      if (!ws) return false;
      return this.findTab(ws, ref.window) !== undefined;
    } catch {
      return false;
    }
  }

  async resolveRef(server: ServerConfig, target: string): Promise<MuxRef | null> {
    const parts = target.split(':');
    if (parts.length < 2) return null;
    const [wsName, tabName] = parts;
    const snap = await this.snapshot(server);
    const ws = this.findWorkspace(snap, wsName);
    if (!ws) return null;
    const tab = this.findTab(ws, tabName);
    if (!tab) return null;
    return herdrMuxRef(wsName, tabName);
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
    const snap = await this.snapshot(server);
    const ws = this.findWorkspace(snap, ref.workspace);
    if (!ws) return [];
    const tab = this.findTab(ws, ref.window);
    if (!tab) return [];
    return tab.panes.map((p, i) => ({
      ordinal: (i + 1) as PaneOrdinal,
      handle: herdrPaneHandle(ws.id, p.id),
      title: p.title,
      command: p.command,
      active: p.active,
    }));
  }

  async listAllPanes(server: ServerConfig): Promise<MuxPaneInfo[]> {
    const snap = await this.snapshot(server);
    const result: MuxPaneInfo[] = [];
    for (const ws of snap.workspaces) {
      for (let ti = 0; ti < ws.tabs.length; ti++) {
        const tab = ws.tabs[ti];
        for (let pi = 0; pi < tab.panes.length; pi++) {
          const pane = tab.panes[pi];
          result.push({
            paneId: herdrPaneHandle(ws.id, pane.id) as string,
            sessionName: ws.name,
            windowIndex: ti,
            windowName: tab.name,
            paneIndex: pi,
            currentPath: pane.cwd,
            currentCommand: pane.command,
          });
        }
      }
    }
    return result;
  }

  async refFromPaneHandle(server: ServerConfig, handle: PaneHandle): Promise<{ ref: MuxRef; ordinal: PaneOrdinal } | null> {
    const { workspaceId, paneId } = parseHerdrPaneHandle(handle);
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    for (const tab of ws.tabs) {
      const idx = tab.panes.findIndex((p) => p.id === paneId);
      if (idx !== -1) {
        return { ref: herdrMuxRef(ws.name, tab.name), ordinal: (idx + 1) as PaneOrdinal };
      }
    }
    return null;
  }

  async probePane(server: ServerConfig, handle: PaneHandle): Promise<{ alive: boolean; verified: boolean }> {
    try {
      const { paneId } = parseHerdrPaneHandle(handle);
      await this.rpc(server, 'pane.read', { pane_id: paneId, source: 'recent' });
      return { alive: true, verified: true };
    } catch {
      return { alive: false, verified: true };
    }
  }

  async splitPaneByHandle(
    server: ServerConfig,
    handle: PaneHandle,
    dir: 'h' | 'v',
    env?: Record<string, string>,
  ): Promise<{ handle: PaneHandle; result: ExecResult }> {
    const { workspaceId, paneId } = parseHerdrPaneHandle(handle);
    const result = await this.rpc(server, 'pane.split', {
      pane_id: paneId,
      direction: dir === 'h' ? 'horizontal' : 'vertical',
      ...(env ? { env } : {}),
    }) as { id: string };
    return {
      handle: herdrPaneHandle(workspaceId, result.id),
      result: this.okResult(),
    };
  }

  async closePane(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> {
    const { paneId } = parseHerdrPaneHandle(handle);
    await this.rpc(server, 'pane.close', { pane_id: paneId });
    return this.okResult();
  }

  async captureScreen(server: ServerConfig, handle: PaneHandle, start?: number, end?: number): Promise<ExecResult> {
    const { paneId } = parseHerdrPaneHandle(handle);
    const result = await this.rpc(server, 'pane.read', {
      pane_id: paneId,
      source: 'recent-unwrapped',
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
    }) as { content: string };
    return { stdout: result.content, stderr: '', code: 0 };
  }

  async sendKeysToHandle(server: ServerConfig, handle: PaneHandle, keys: string[]): Promise<void> {
    const { paneId } = parseHerdrPaneHandle(handle);
    const herdrKeys = tmuxKeysToHerdr(keys);
    await this.rpc(server, 'pane.send_keys', { pane_id: paneId, keys: herdrKeys });
  }

  async sendTextToHandle(server: ServerConfig, handle: PaneHandle, text: string): Promise<void> {
    const { paneId } = parseHerdrPaneHandle(handle);
    await this.rpc(server, 'pane.send_text', { pane_id: paneId, text });
  }

  async panePidByHandle(server: ServerConfig, handle: PaneHandle): Promise<number | null> {
    const { workspaceId, paneId } = parseHerdrPaneHandle(handle);
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    for (const tab of ws.tabs) {
      const pane = tab.panes.find((p) => p.id === paneId);
      if (pane) return pane.pid;
    }
    return null;
  }

  async paneCommandByHandle(server: ServerConfig, handle: PaneHandle): Promise<string | null> {
    const { workspaceId, paneId } = parseHerdrPaneHandle(handle);
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    for (const tab of ws.tabs) {
      const pane = tab.panes.find((p) => p.id === paneId);
      if (pane) return pane.command;
    }
    return null;
  }

  // ─── Capability-gated (caps=false → throw) ───

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

  async captureLayout(_server: ServerConfig, _ref: MuxRef): Promise<{ layout: string; panes: Array<{ index: number; ordinal: PaneOrdinal; command: string | null; path: string | null; title: string | null }> }> {
    throw new MuxCapabilityMissingError('layoutSnapshot');
  }

  async applyLayout(_server: ServerConfig, _ref: MuxRef, _layout: string): Promise<ExecResult> {
    throw new MuxCapabilityMissingError('layoutSnapshot');
  }

  async measurePanePids(server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>> {
    const snap = await this.snapshot(server);
    const result: Array<{ ref: MuxRef; pid: number }> = [];
    for (const ws of snap.workspaces) {
      for (const tab of ws.tabs) {
        for (const pane of tab.panes) {
          result.push({
            ref: herdrMuxRef(ws.name, tab.name),
            pid: pane.pid,
          });
        }
      }
    }
    return result;
  }

  // ─── Terminal / Change Hooks ───

  async openTerminal(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream> {
    return this.transportFactory.getTransport(server).openTerminal(ref, ordinal, cols, rows);
  }

  async installChangeHooks(_server: ServerConfig): Promise<void> {
    // herdr uses built-in events via events.subscribe — the HerdrEventSubscriber
    // is started separately by the wiring layer, not per-call.
  }

  async uninstallChangeHooks(_server: ServerConfig): Promise<void> {
    // No-op — herdr event subscriptions are managed externally.
  }

  // ─── Private helpers ───

  private async resolveTabId(server: ServerConfig, ref: MuxRef): Promise<string> {
    const snap = await this.snapshot(server);
    const ws = this.findWorkspace(snap, ref.workspace);
    if (!ws) throw new Error(`Workspace "${ref.workspace}" not found`);
    const tab = this.findTab(ws, ref.window);
    if (!tab) throw new Error(`Tab "${ref.window}" not found in workspace "${ref.workspace}"`);
    return tab.id;
  }

  private toMuxWorkspace(ws: SnapshotWorkspace): MuxWorkspace {
    return {
      name: ws.name,
      windowCount: ws.tabs.length,
      attached: false,
      created: 0,
      windows: ws.tabs.map((tab, i) => this.toMuxWindowInfo(tab, i)),
    };
  }

  private toMuxWindowInfo(tab: SnapshotTab, index: number): MuxWindowInfo {
    return {
      index,
      name: tab.name,
      active: tab.active,
      panes: tab.panes.map((p) => this.toMuxPane(p)),
      activity: 0,
    };
  }

  private toMuxPane(p: SnapshotPane): MuxPane {
    return {
      index: p.index,
      command: p.command,
      title: p.title,
      width: p.width,
      height: p.height,
      active: p.active,
      pid: p.pid,
    };
  }
}
