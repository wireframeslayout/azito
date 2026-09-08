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
import { asPaneHandle, herdrMuxRef } from '@azito/shared';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { ExecResult, ITerminalStream } from '../../servers/transport/ServerTransport';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { MuxCapabilityMissingError } from '../../tmux/MuxCapabilityError';
import { tmuxKeyToHerdr, isTmuxSpecialKey } from './herdrKeyMap';

const DEFAULT_TAB_NAME = 'main';

interface SnapshotWorkspace {
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: string;
}

interface SnapshotTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: string;
}

interface SnapshotPane {
  pane_id: string;
  terminal_id: number;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd: string;
  agent_status: string;
  revision: number;
}

interface SnapshotLayout {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  focused_pane_id: string;
  panes: Array<{ pane_id: string; focused: boolean; rect: { x: number; y: number; width: number; height: number } }>;
  splits: unknown[];
}

interface SessionSnapshot {
  focused_workspace_id: string;
  focused_tab_id: string;
  focused_pane_id: string;
  workspaces: SnapshotWorkspace[];
  tabs: SnapshotTab[];
  panes: SnapshotPane[];
  layouts: SnapshotLayout[];
  agents: unknown[];
}

const warnedMultiTab = new Set<string>();

export class HerdrClient implements IMuxClient {
  readonly kind: MuxDriverKind = 'herdr';

  readonly caps: MuxCapabilities = {
    outputStream: true,
    changeEvents: true,
    agentState: true,
    independentClients: true,
    envInjection: true,
    zoom: true,
    copyMode: false,
    paneTitle: true,
    activityCounter: false,
    layoutSnapshot: true,
    stablePaneHandle: true,
  };

  constructor(
    private transportFactory: TransportFactory,
    private sessionName: string = 'azito',
  ) {}

  // ─── helpers ───

  private async rpc(server: ServerConfig, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const result = await this.transportFactory.getTransport(server).execMux({
      kind: 'herdr',
      method,
      params,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'result' in parsed && !('type' in parsed)) {
      return (parsed.result ?? {}) as Record<string, unknown>;
    }
    return parsed;
  }

  private async snapshot(server: ServerConfig): Promise<SessionSnapshot> {
    const resp = await this.rpc(server, 'session.snapshot');
    return resp.snapshot as SessionSnapshot;
  }

  private okResult(): ExecResult {
    return { stdout: '', stderr: '', code: 0 };
  }

  // ─── Workspace / Window ───
  // AZITO window = herdr workspace (each workspace has exactly one tab exposed).

  async listWorkspaces(server: ServerConfig): Promise<MuxWorkspace[]> {
    const snap = await this.snapshot(server);
    return snap.workspaces.map((ws) => {
      const tabs = snap.tabs.filter((t) => t.workspace_id === ws.workspace_id);
      if (tabs.length > 1) {
        const key = `${server.name}:${ws.label}`;
        if (!warnedMultiTab.has(key)) {
          warnedMultiTab.add(key);
          console.warn(`[herdr] workspace "${ws.label}" has ${tabs.length} tabs; only the first is exposed to AZITO`);
        }
      }
      const firstTab = tabs[0];
      if (!firstTab) return { name: ws.label, windowCount: 1, attached: ws.focused, created: 0, windows: [] };
      return {
        name: ws.label,
        windowCount: 1,
        attached: ws.focused,
        created: 0,
        windows: [this.toMuxWindowInfo(snap, firstTab, 0)],
      };
    });
  }

  async listWorkspacesStrict(server: ServerConfig): Promise<MuxWorkspace[]> {
    return this.listWorkspaces(server);
  }

  async openWorkspace(
    server: ServerConfig,
    name: string,
    opts?: { command?: string; windowName?: string; exactName?: boolean; extraEnv?: Record<string, string> },
  ): Promise<{ ref: MuxRef; result: ExecResult }> {
    const resp = await this.rpc(server, 'workspace.create', {
      name,
      ...(opts?.extraEnv ? { env: opts.extraEnv } : {}),
    });
    const ws = resp.workspace as { workspace_id: string; label: string };
    await this.rpc(server, 'workspace.rename', { workspace_id: ws.workspace_id, label: name });

    const ref = herdrMuxRef(name);
    return { ref, result: this.okResult() };
  }

  async openWindow(
    server: ServerConfig,
    _workspace: string,
    baseName?: string,
    opts?: { exactName?: boolean; extraEnv?: Record<string, string> },
  ): Promise<{ ref: MuxRef; result: ExecResult }> {
    const windowName = baseName ?? 'default';
    const resp = await this.rpc(server, 'workspace.create', {
      name: windowName,
      ...(opts?.extraEnv ? { env: opts.extraEnv } : {}),
    });
    const ws = resp.workspace as { workspace_id: string; label: string };
    if (ws.label !== windowName) {
      await this.rpc(server, 'workspace.rename', { workspace_id: ws.workspace_id, label: windowName });
    }

    const ref = herdrMuxRef(windowName);
    return { ref, result: this.okResult() };
  }

  async closeWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> {
    const wsId = await this.resolveWorkspaceId(server, ref.workspace);
    await this.rpc(server, 'workspace.close', { workspace_id: wsId });
    return this.okResult();
  }

  async closeWorkspace(server: ServerConfig, workspace: string): Promise<ExecResult> {
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.label === workspace);
    if (!ws) throw new Error(`Workspace "${workspace}" not found`);
    await this.rpc(server, 'workspace.close', { workspace_id: ws.workspace_id });
    return this.okResult();
  }

  async renameWindowByRef(server: ServerConfig, ref: MuxRef, name: string): Promise<ExecResult> {
    const wsId = await this.resolveWorkspaceId(server, ref.workspace);
    await this.rpc(server, 'workspace.rename', { workspace_id: wsId, label: name });
    return this.okResult();
  }

  async renameWorkspace(server: ServerConfig, from: string, to: string): Promise<ExecResult> {
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.label === from);
    if (!ws) throw new Error(`Workspace "${from}" not found`);
    await this.rpc(server, 'workspace.rename', { workspace_id: ws.workspace_id, label: to });
    return this.okResult();
  }

  async focusWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> {
    const wsId = await this.resolveWorkspaceId(server, ref.workspace);
    await this.rpc(server, 'workspace.focus', { workspace_id: wsId });
    return this.okResult();
  }

  async windowExists(server: ServerConfig, ref: MuxRef): Promise<boolean> {
    try {
      const snap = await this.snapshot(server);
      return snap.workspaces.some((w) => w.label === ref.workspace);
    } catch {
      return false;
    }
  }

  async resolveRef(server: ServerConfig, target: string): Promise<MuxRef | null> {
    const sep = target.indexOf(':');
    const wsName = sep === -1 ? target : target.slice(0, sep);
    if (await this.windowExists(server, herdrMuxRef(wsName))) {
      return herdrMuxRef(wsName);
    }
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
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.label === ref.workspace);
    if (!ws) {
      // Legacy fallback: try matching ref.window as a tab label across all workspaces.
      const tab = snap.tabs.find((t) => t.label === ref.window);
      if (tab) {
        console.warn(`[herdr] Legacy ref fallback: resolved tab "${ref.window}" by tab label (workspace not found for "${ref.workspace}")`);
        const panes = snap.panes.filter((p) => p.tab_id === tab.tab_id);
        return panes.map((p, i) => ({
          ordinal: (i + 1) as PaneOrdinal,
          handle: asPaneHandle(p.pane_id),
          title: '',
          command: '',
          active: p.focused,
        }));
      }
      return [];
    }
    const firstTab = snap.tabs.find((t) => t.workspace_id === ws.workspace_id);
    if (!firstTab) return [];
    const panes = snap.panes.filter((p) => p.tab_id === firstTab.tab_id);
    return panes.map((p, i) => ({
      ordinal: (i + 1) as PaneOrdinal,
      handle: asPaneHandle(p.pane_id),
      title: '',
      command: '',
      active: p.focused,
    }));
  }

  async listAllPanes(server: ServerConfig): Promise<MuxPaneInfo[]> {
    const snap = await this.snapshot(server);
    const result: MuxPaneInfo[] = [];
    for (const ws of snap.workspaces) {
      const firstTab = snap.tabs.find((t) => t.workspace_id === ws.workspace_id);
      if (!firstTab) continue;
      const panesInTab = snap.panes.filter((p) => p.tab_id === firstTab.tab_id);
      for (let i = 0; i < panesInTab.length; i++) {
        result.push({
          paneId: panesInTab[i].pane_id,
          sessionName: ws.label,
          windowIndex: 0,
          windowName: DEFAULT_TAB_NAME,
          paneIndex: i,
          currentPath: panesInTab[i].cwd,
          currentCommand: '',
        });
      }
    }
    return result;
  }

  async refFromPaneHandle(server: ServerConfig, handle: PaneHandle): Promise<{ ref: MuxRef; ordinal: PaneOrdinal } | null> {
    const paneId = handle as string;
    const snap = await this.snapshot(server);
    const pane = snap.panes.find((p) => p.pane_id === paneId);
    if (!pane) return null;
    const ws = snap.workspaces.find((w) => w.workspace_id === pane.workspace_id);
    if (!ws) return null;
    const firstTab = snap.tabs.find((t) => t.workspace_id === ws.workspace_id);
    if (!firstTab) return null;
    const panesInTab = snap.panes.filter((p) => p.tab_id === firstTab.tab_id);
    const idx = panesInTab.findIndex((p) => p.pane_id === paneId);
    if (idx === -1) return null;
    return { ref: herdrMuxRef(ws.label), ordinal: (idx + 1) as PaneOrdinal };
  }

  async probePane(server: ServerConfig, handle: PaneHandle): Promise<{ alive: boolean; verified: boolean }> {
    try {
      await this.rpc(server, 'pane.read', { pane_id: handle as string, source: 'recent' });
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
    const resp = await this.rpc(server, 'pane.split', {
      pane_id: handle as string,
      direction: dir === 'h' ? 'horizontal' : 'vertical',
      ...(env ? { env } : {}),
    });
    const newPane = resp.pane as { pane_id: string };
    return {
      handle: asPaneHandle(newPane.pane_id),
      result: this.okResult(),
    };
  }

  async closePane(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> {
    await this.rpc(server, 'pane.close', { pane_id: handle as string });
    return this.okResult();
  }

  async captureScreen(server: ServerConfig, handle: PaneHandle, start?: number, end?: number): Promise<ExecResult> {
    const resp = await this.rpc(server, 'pane.read', {
      pane_id: handle as string,
      source: 'recent',
      ...(end !== undefined ? { lines: end - (start ?? 0) } : {}),
    });
    const read = resp.read as { text: string } | undefined;
    return { stdout: read?.text ?? '', stderr: '', code: 0 };
  }

  async sendKeysToHandle(server: ServerConfig, handle: PaneHandle, keys: string[]): Promise<void> {
    for (const key of keys) {
      if (isTmuxSpecialKey(key)) {
        await this.rpc(server, 'pane.send_keys', { pane_id: handle as string, keys: [tmuxKeyToHerdr(key)] });
      } else {
        await this.rpc(server, 'pane.send_text', { pane_id: handle as string, text: key });
      }
    }
  }

  async sendTextToHandle(server: ServerConfig, handle: PaneHandle, text: string): Promise<void> {
    await this.rpc(server, 'pane.send_text', { pane_id: handle as string, text });
  }

  async panePidByHandle(server: ServerConfig, handle: PaneHandle): Promise<number | null> {
    try {
      const resp = await this.rpc(server, 'pane.process_info', { pane_id: handle as string });
      const info = resp as { pid?: number; foreground_pid?: number };
      return info.foreground_pid ?? info.pid ?? null;
    } catch {
      return null;
    }
  }

  async paneCommandByHandle(server: ServerConfig, handle: PaneHandle): Promise<string | null> {
    try {
      const resp = await this.rpc(server, 'pane.process_info', { pane_id: handle as string });
      const info = resp as { foreground_command?: string; command?: string };
      return info.foreground_command ?? info.command ?? null;
    } catch {
      return null;
    }
  }

  // ─── Capability-gated ───

  async startOutputStream(_server: ServerConfig, _handle: PaneHandle, _outputPath: string): Promise<void> {
    // No-op: HerdrPaneStream captures output via pane.read polling, not pipe-pane.
  }

  async stopOutputStream(_server: ServerConfig, _handle: PaneHandle): Promise<void> {
    // No-op: HerdrPaneStream manages its own lifecycle.
  }

  async zoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> {
    await this.rpc(server, 'pane.zoom', { pane_id: handle as string });
    return this.okResult();
  }

  async unzoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> {
    await this.rpc(server, 'pane.zoom', { pane_id: handle as string });
    return this.okResult();
  }

  async isPaneInModeByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<boolean> {
    throw new MuxCapabilityMissingError('copyMode');
  }

  async cancelPaneModeByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<void> {
    throw new MuxCapabilityMissingError('copyMode');
  }

  async setPaneTitle(server: ServerConfig, handle: PaneHandle, title: string): Promise<ExecResult> {
    await this.rpc(server, 'pane.rename', { pane_id: handle as string, label: title });
    return this.okResult();
  }

  async windowActivity(_server: ServerConfig, _ref: MuxRef): Promise<number | null> {
    throw new MuxCapabilityMissingError('activityCounter');
  }

  // ─── Layout / Resource ───

  async captureLayout(server: ServerConfig, ref: MuxRef): Promise<{ layout: string; panes: Array<{ index: number; ordinal: PaneOrdinal; command: string | null; path: string | null; title: string | null }> }> {
    const tabId = await this.resolveFirstTabId(server, ref.workspace);
    const resp = await this.rpc(server, 'layout.export', { tab_id: tabId });
    const layout = resp.layout ?? resp;
    const snap = await this.snapshot(server);
    const panes = snap.panes.filter((p) => p.tab_id === tabId);
    return {
      layout: JSON.stringify(layout),
      panes: panes.map((p, i) => ({
        index: i,
        ordinal: (i + 1) as PaneOrdinal,
        command: null,
        path: p.cwd,
        title: null,
      })),
    };
  }

  async applyLayout(server: ServerConfig, ref: MuxRef, layout: string): Promise<ExecResult> {
    const tabId = await this.resolveFirstTabId(server, ref.workspace);
    await this.rpc(server, 'layout.apply', { tab_id: tabId, layout: JSON.parse(layout) });
    return this.okResult();
  }

  async measurePanePids(server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>> {
    const snap = await this.snapshot(server);
    const result: Array<{ ref: MuxRef; pid: number }> = [];
    for (const ws of snap.workspaces) {
      const firstTab = snap.tabs.find((t) => t.workspace_id === ws.workspace_id);
      if (!firstTab) continue;
      const panesInTab = snap.panes.filter((p) => p.tab_id === firstTab.tab_id);
      for (const pane of panesInTab) {
        try {
          const resp = await this.rpc(server, 'pane.process_info', { pane_id: pane.pane_id });
          const info = resp as { pid?: number };
          if (info.pid) {
            result.push({ ref: herdrMuxRef(ws.label), pid: info.pid });
          }
        } catch { /* skip panes where process info fails */ }
      }
    }
    return result;
  }

  // ─── Terminal / Change Hooks ───

  async openTerminal(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: import('../../servers/transport/ServerTransport').OpenTerminalOpts): Promise<ITerminalStream> {
    return this.transportFactory.getTransport(server).openTerminal(ref, ordinal, cols, rows, opts);
  }

  async installChangeHooks(_server: ServerConfig): Promise<void> {
    // herdr uses built-in events via events.subscribe — started externally.
  }

  async uninstallChangeHooks(_server: ServerConfig): Promise<void> {
    // No-op — herdr event subscriptions are managed externally.
  }

  // ─── Private helpers ───

  private async resolveWorkspaceId(server: ServerConfig, workspaceLabel: string): Promise<string> {
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.label === workspaceLabel);
    if (!ws) throw new Error(`Workspace "${workspaceLabel}" not found`);
    return ws.workspace_id;
  }

  private async resolveFirstTabId(server: ServerConfig, workspaceLabel: string): Promise<string> {
    const snap = await this.snapshot(server);
    const ws = snap.workspaces.find((w) => w.label === workspaceLabel);
    if (!ws) throw new Error(`Workspace "${workspaceLabel}" not found`);
    const tab = snap.tabs.find((t) => t.workspace_id === ws.workspace_id);
    if (!tab) throw new Error(`No tabs found in workspace "${workspaceLabel}"`);
    return tab.tab_id;
  }

  private toMuxWindowInfo(snap: SessionSnapshot, tab: SnapshotTab, index: number): MuxWindowInfo {
    const panes = snap.panes.filter((p) => p.tab_id === tab.tab_id);
    const layout = snap.layouts.find((l) => l.tab_id === tab.tab_id);
    return {
      index,
      name: DEFAULT_TAB_NAME,
      active: tab.focused,
      panes: panes.map((p, i) => {
        const layoutPane = layout?.panes.find((lp) => lp.pane_id === p.pane_id);
        return {
          index: i,
          command: '',
          title: '',
          width: layoutPane?.rect.width ?? 80,
          height: layoutPane?.rect.height ?? 24,
          active: p.focused,
          pid: 0,
        } satisfies MuxPane;
      }),
      activity: 0,
    };
  }
}
