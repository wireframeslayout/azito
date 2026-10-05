import type { MuxCapabilities, MuxDriverKind, MuxPaneInfo, MuxRef, MuxWorkspace, PaneHandle, PaneOrdinal } from '@azito/shared';
import type { ExecResult, ITerminalStream } from '../../servers/transport/ServerTransport';
import type { ServerConfig } from '../../servers/Server';
import type { IMuxClient, PaneLocation, PaneWindowLabels } from '../IMuxClient';
import type { MisaoMuxClient } from './MisaoMuxClient';
import { MISAO_CAPS } from './MisaoMuxClient';
import type { MisaoServers } from './MisaoServers';

/**
 * The misao driver of the registry: each call goes to the daemon of the server it is for (the local one, or the one an
 * agent server's relay reaches). It holds no state of its own; `MisaoServers` owns the nodes. A call for an agent
 * server that has no misao fails with `MuxDriverUnavailableError('misao', 'not_installed')`, except the ones that undo
 * something (change hooks), which have nothing to undo then. Every method is async so that failure is a rejection, as it
 * is for any driver.
 */
export class MisaoDriverRouter implements IMuxClient {
  readonly kind: MuxDriverKind = 'misao';
  readonly caps: MuxCapabilities = MISAO_CAPS;
  readonly supportsPaneLabels = true;

  constructor(private readonly servers: MisaoServers) {}

  private to(server: ServerConfig): MisaoMuxClient {
    return this.servers.nodeFor(server).driver;
  }

  async listWorkspaces(server: ServerConfig): Promise<MuxWorkspace[]> { return this.to(server).listWorkspaces(server); }
  async listWorkspacesStrict(server: ServerConfig): Promise<MuxWorkspace[]> { return this.to(server).listWorkspacesStrict(server); }
  async openWorkspace(server: ServerConfig, name: string, opts?: Parameters<IMuxClient['openWorkspace']>[2]): ReturnType<IMuxClient['openWorkspace']> { return this.to(server).openWorkspace(server, name, opts); }
  async openWindow(server: ServerConfig, workspace: string, baseName?: string, opts?: Parameters<IMuxClient['openWindow']>[3]): ReturnType<IMuxClient['openWindow']> { return this.to(server).openWindow(server, workspace, baseName, opts); }
  async closeWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> { return this.to(server).closeWindow(server, ref); }
  async closeWorkspace(server: ServerConfig, workspace: string): Promise<ExecResult> { return this.to(server).closeWorkspace(server, workspace); }
  async renameWindowByRef(server: ServerConfig, ref: MuxRef, name: string): Promise<ExecResult> { return this.to(server).renameWindowByRef(server, ref, name); }
  async renameWorkspace(server: ServerConfig, from: string, to: string): Promise<ExecResult> { return this.to(server).renameWorkspace(server, from, to); }
  async windowExists(server: ServerConfig, ref: MuxRef): Promise<boolean> { return this.to(server).windowExists(server, ref); }
  async focusWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> { return this.to(server).focusWindow(server, ref); }
  async resolveRef(server: ServerConfig, target: string): Promise<MuxRef | null> { return this.to(server).resolveRef(server, target); }
  async labelWindowPanes(server: ServerConfig, ref: MuxRef, labels: PaneWindowLabels): Promise<void> { return this.to(server).labelWindowPanes(server, ref, labels); }

  async resolvePane(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal): Promise<PaneHandle> { return this.to(server).resolvePane(server, ref, ordinal); }
  async listPanesByRef(server: ServerConfig, ref: MuxRef): ReturnType<IMuxClient['listPanesByRef']> { return this.to(server).listPanesByRef(server, ref); }
  async listAllPanes(server: ServerConfig): Promise<MuxPaneInfo[]> { return this.to(server).listAllPanes(server); }
  async refFromPaneHandle(server: ServerConfig, handle: PaneHandle): ReturnType<IMuxClient['refFromPaneHandle']> { return this.to(server).refFromPaneHandle(server, handle); }
  async locatePane(server: ServerConfig, handle: PaneHandle): Promise<PaneLocation> { return this.to(server).locatePane(server, handle); }
  async probePane(server: ServerConfig, handle: PaneHandle): ReturnType<IMuxClient['probePane']> { return this.to(server).probePane(server, handle); }
  async splitPaneByHandle(server: ServerConfig, handle: PaneHandle, dir: 'h' | 'v', env?: Record<string, string>): ReturnType<IMuxClient['splitPaneByHandle']> { return this.to(server).splitPaneByHandle(server, handle, dir, env); }
  async openPaneInWindow(server: ServerConfig, ref: MuxRef, opts?: Parameters<IMuxClient['openPaneInWindow']>[2]): Promise<PaneHandle> { return this.to(server).openPaneInWindow(server, ref, opts); }
  async closePane(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> { return this.to(server).closePane(server, handle); }
  async captureScreen(server: ServerConfig, handle: PaneHandle, start?: number, end?: number): Promise<ExecResult> { return this.to(server).captureScreen(server, handle, start, end); }
  async sendKeysToHandle(server: ServerConfig, handle: PaneHandle, keys: string[]): Promise<void> { return this.to(server).sendKeysToHandle(server, handle, keys); }
  async sendTextToHandle(server: ServerConfig, handle: PaneHandle, text: string): Promise<void> { return this.to(server).sendTextToHandle(server, handle, text); }
  async panePidByHandle(server: ServerConfig, handle: PaneHandle): Promise<number | null> { return this.to(server).panePidByHandle(server, handle); }
  async paneCommandByHandle(server: ServerConfig, handle: PaneHandle): Promise<string | null> { return this.to(server).paneCommandByHandle(server, handle); }

  async startOutputStream(server: ServerConfig, handle: PaneHandle, outputPath: string): Promise<void> { return this.to(server).startOutputStream(server, handle, outputPath); }
  async stopOutputStream(server: ServerConfig, handle: PaneHandle): Promise<void> { return this.to(server).stopOutputStream(server, handle); }
  async zoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> { return this.to(server).zoomPaneByHandle(server, handle); }
  async unzoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> { return this.to(server).unzoomPaneByHandle(server, handle); }
  async isPaneInModeByHandle(server: ServerConfig, handle: PaneHandle): Promise<boolean> { return this.to(server).isPaneInModeByHandle(server, handle); }
  async cancelPaneModeByHandle(server: ServerConfig, handle: PaneHandle): Promise<void> { return this.to(server).cancelPaneModeByHandle(server, handle); }
  async setPaneTitle(server: ServerConfig, handle: PaneHandle, title: string): Promise<ExecResult> { return this.to(server).setPaneTitle(server, handle, title); }
  async windowActivity(server: ServerConfig, ref: MuxRef): Promise<number | null> { return this.to(server).windowActivity(server, ref); }

  async captureLayout(server: ServerConfig, ref: MuxRef): ReturnType<IMuxClient['captureLayout']> { return this.to(server).captureLayout(server, ref); }
  async applyLayout(server: ServerConfig, ref: MuxRef, layout: string): Promise<ExecResult> { return this.to(server).applyLayout(server, ref, layout); }
  async measurePanePids(server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>> { return this.to(server).measurePanePids(server); }

  async openTerminal(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream> { return this.to(server).openTerminal(server, ref, ordinal, cols, rows); }
  async installChangeHooks(server: ServerConfig): Promise<void> { return this.to(server).installChangeHooks(server); }

  async uninstallChangeHooks(server: ServerConfig): Promise<void> {
    if (server.type === 'agent' && !this.servers.hosts(server)) return;
    await this.to(server).uninstallChangeHooks(server);
  }
}
