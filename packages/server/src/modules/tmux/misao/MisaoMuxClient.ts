import { randomUUID } from 'node:crypto';
import { type MuxCapabilities, type MuxDriverKind, type MuxPaneInfo, type MuxRef, type MuxWorkspace, type PaneHandle, type PaneOrdinal, asPaneHandle, isMisaoWindowId } from '@azito/shared';
import type { ExecResult, ITerminalStream } from '../../servers/transport/ServerTransport';
import type { ServerConfig } from '../../servers/Server';
import type { IMuxClient, PaneWindowLabels } from '../IMuxClient';
import { MuxDriverUnavailableError, MuxOperationUnsupportedError } from '../MuxCapabilityError';
import { generateWindowName } from '../windowNameUtils';
import type { MisaoAttachClient, MisaoEventSource, MisaoRpc } from './MisaoConnection';
import { MisaoChangeEvents } from './misaoChangeEvents';
import { MISAO_PANE_EXITED, MISAO_PANE_NOT_FOUND } from './misaoErrorCodes';
import { MisaoTerminalStream } from './MisaoTerminalStream';
import { encodeMisaoKey } from './misaoKeys';
import { type MisaoPane, type MisaoWorkspace, lastOutputEpochSeconds, misaoRef, paneCommand, panesOfWindow, toMuxPaneInfos, toMuxWorkspaces } from './misaoMapping';

const LONG_TEXT_BYTES = 500;
const LONG_TEXT_SUBMIT_DELAY_MS = 2000;
/** Same settle time tmux's sendLongText waits after a paste, so a following Enter is not folded into it. */
const LONG_TEXT_PASTE_SETTLE_MS = 3000;

export interface MisaoMuxClientOptions {
  /** Shell panes are started with, resolved at the boundary. */
  shell: string;
  /** Called (with the server name) when the daemon reports a workspace/window/pane change. */
  onChange: (serverName: string) => void;
  log: { warn(message: string): void };
  /** Opens a daemon connection owned by one terminal (attach is per connection). */
  connectAttachClient: () => Promise<MisaoAttachClient>;
}

const OK: ExecResult = { stdout: '', stderr: '', code: 0 };

const unsupported = (operation: string): MuxOperationUnsupportedError => new MuxOperationUnsupportedError('misao', operation);

/**
 * IMuxClient over the misao daemon. A window is addressed by its daemon window id (`MuxRef.window`) and a pane by
 * its pane id (`PaneHandle`); a pane's ordinal is its 1-based position among the window's panes in creation order.
 * Line streaming is not part of this driver yet.
 */
export class MisaoMuxClient implements IMuxClient {
  readonly kind: MuxDriverKind = 'misao';
  readonly caps: MuxCapabilities = { changeEvents: true, agentState: false, independentClients: true, copyMode: false };
  readonly supportsPaneLabels = true;

  private readonly changeEvents: MisaoChangeEvents;

  constructor(
    private readonly rpc: MisaoRpc & MisaoEventSource,
    private readonly options: MisaoMuxClientOptions,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.changeEvents = new MisaoChangeEvents(rpc, options.onChange, options.log);
  }

  // ─── Workspace / Window ───

  async listWorkspaces(_server: ServerConfig): Promise<MuxWorkspace[]> {
    const { workspaces, panes } = await this.snapshot();
    return toMuxWorkspaces(workspaces, panes);
  }

  async listWorkspacesStrict(server: ServerConfig): Promise<MuxWorkspace[]> {
    return this.listWorkspaces(server);
  }

  async openWorkspace(_server: ServerConfig, name: string, opts?: { command?: string; windowName?: string; exactName?: boolean; extraEnv?: Record<string, string> }): Promise<{ ref: MuxRef; result: ExecResult }> {
    await this.rpc.request('workspace.create', { name });
    const windowName = opts?.exactName && opts.windowName ? opts.windowName : generateWindowName(opts?.windowName || 'win');
    try {
      const windowId = await this.createWindowWithPane(name, windowName, opts?.command, opts?.extraEnv);
      return { ref: misaoRef(name, windowId), result: OK };
    } catch (err) {
      // Best-effort rollback of the workspace this call created; the original failure is what the caller sees.
      await this.rpc.request('workspace.close', { name }).catch(() => undefined);
      throw err;
    }
  }

  async openWindow(_server: ServerConfig, workspace: string, baseName?: string, opts?: { exactName?: boolean; extraEnv?: Record<string, string> }): Promise<{ ref: MuxRef; result: ExecResult; windowName?: string }> {
    const windowName = opts?.exactName && baseName ? baseName : generateWindowName(baseName || 'win');
    const windowId = await this.createWindowWithPane(workspace, windowName, undefined, opts?.extraEnv);
    return { ref: misaoRef(workspace, windowId), result: OK, windowName };
  }

  async closeWindow(_server: ServerConfig, ref: MuxRef): Promise<ExecResult> {
    return this.execResult(() => this.rpc.request('window.close', { windowId: ref.window }));
  }

  async closeWorkspace(_server: ServerConfig, workspace: string): Promise<ExecResult> {
    return this.execResult(() => this.rpc.request('workspace.close', { name: workspace }));
  }

  async renameWindowByRef(_server: ServerConfig, ref: MuxRef, name: string): Promise<ExecResult> {
    return this.execResult(() => this.rpc.request('window.rename', { windowId: ref.window, name }));
  }

  async renameWorkspace(_server: ServerConfig, from: string, to: string): Promise<ExecResult> {
    return this.execResult(() => this.rpc.request('workspace.rename', { name: from, newName: to }));
  }

  async windowExists(_server: ServerConfig, ref: MuxRef): Promise<boolean> {
    const workspaces = await this.rpc.request('workspace.list', {});
    return workspaces.some((ws) => ws.windows.some((w) => w.windowId === ref.window));
  }

  async focusWindow(_server: ServerConfig, _ref: MuxRef): Promise<ExecResult> {
    throw unsupported('focusWindow');
  }

  /** `w_<ULID>` (window id) or `<workspace>:<window name>` when exactly one window has that name. */
  async resolveRef(_server: ServerConfig, target: string): Promise<MuxRef | null> {
    const workspaces = await this.rpc.request('workspace.list', {});
    if (isMisaoWindowId(target)) {
      const ws = workspaces.find((w) => w.windows.some((win) => win.windowId === target));
      return ws ? misaoRef(ws.name, target) : null;
    }
    const sep = target.indexOf(':');
    if (sep === -1) return null;
    const ws = workspaces.find((w) => w.name === target.slice(0, sep));
    const matches = ws?.windows.filter((win) => win.name === target.slice(sep + 1)) ?? [];
    return ws && matches.length === 1 ? misaoRef(ws.name, matches[0].windowId) : null;
  }

  async labelWindowPanes(_server: ServerConfig, ref: MuxRef, labels: PaneWindowLabels): Promise<void> {
    const set: Record<string, string> = { windowId: String(labels.windowId) };
    if (labels.taskId !== undefined) set.task = String(labels.taskId);
    for (const pane of await this.windowPanes(ref)) {
      await this.rpc.request('pane.set_label', { paneId: pane.paneId, set });
    }
  }

  // ─── Pane ───

  async resolvePane(_server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal): Promise<PaneHandle> {
    const panes = await this.windowPanes(ref);
    return asPaneHandle(paneAtOrdinal(panes, ordinal, ref).paneId);
  }

  /** Attaches a browser terminal to one pane; every terminal is its own daemon client, so the daemon arbitrates the size. */
  async openTerminal(_server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream> {
    const { workspaces, panes } = await this.snapshot();
    if (!workspaces.some((ws) => ws.windows.some((w) => w.windowId === ref.window))) throw new Error('WINDOW_NOT_FOUND');
    const pane = paneAtOrdinal(panesOfWindow(panes, ref.window), ordinal, ref);
    const client = await this.options.connectAttachClient();
    try {
      return await MisaoTerminalStream.open({
        client,
        paneId: pane.paneId,
        clientId: `azito-term-${randomUUID()}`,
        cols,
        rows,
        log: this.options.log,
        rpcErrorCode: (err) => this.rpc.rpcErrorCode(err),
      });
    } catch (err) {
      client.close();
      if (this.rpc.isConnectionError(err)) throw new MuxDriverUnavailableError('misao', 'daemon_unreachable');
      // A stopped pane can never be attached, so it must not look retryable: the browser reconnects on any other close.
      const code = this.rpc.rpcErrorCode(err);
      throw code === MISAO_PANE_NOT_FOUND || code === MISAO_PANE_EXITED ? new Error('WINDOW_NOT_FOUND') : err;
    }
  }

  async listPanesByRef(_server: ServerConfig, ref: MuxRef): Promise<Array<{ ordinal: PaneOrdinal; handle: PaneHandle; title: string; command: string; active: boolean }>> {
    const panes = await this.windowPanes(ref);
    return panes.map((p, i) => ({ ordinal: i + 1, handle: asPaneHandle(p.paneId), title: p.title, command: paneCommand(p), active: false }));
  }

  async listAllPanes(_server: ServerConfig): Promise<MuxPaneInfo[]> {
    const { workspaces, panes } = await this.snapshot();
    return toMuxPaneInfos(workspaces, panes);
  }

  async refFromPaneHandle(_server: ServerConfig, handle: PaneHandle): Promise<{ ref: MuxRef; ordinal: PaneOrdinal } | null> {
    const panes = await this.rpc.request('pane.list', {});
    const pane = panes.find((p) => p.paneId === handle);
    if (!pane) return null;
    const ordinal = panesOfWindow(panes, pane.window.id).findIndex((p) => p.paneId === handle) + 1;
    return { ref: misaoRef(pane.workspace, pane.window.id), ordinal };
  }

  async probePane(_server: ServerConfig, handle: PaneHandle): Promise<{ alive: boolean; verified: boolean }> {
    let info: MisaoPane | null;
    try {
      info = await this.paneInfo(handle);
    } catch {
      // Like tmux's checkPaneLiveness: a probe never throws, a failure just means "could not verify".
      return { alive: false, verified: false };
    }
    if (!info) return { alive: false, verified: true };
    if (info.processState === 'running') return { alive: true, verified: true };
    return { alive: false, verified: info.processState !== 'unknown' };
  }

  async splitPaneByHandle(_server: ServerConfig, handle: PaneHandle, _dir: 'h' | 'v', env?: Record<string, string>): Promise<{ handle: PaneHandle; result: ExecResult }> {
    const source = await this.rpc.request('pane.info', { paneId: handle });
    const { paneId } = await this.rpc.request('pane.open', {
      cmd: [this.options.shell],
      cwd: source.cwd,
      windowId: source.window.id,
      labels: inheritedLabels(source),
      // ephemeralEnv: env would be persisted by the daemon and shown by pane.info/pane.list (secrets such as task tokens).
      ...(env ? { ephemeralEnv: env } : {}),
    });
    return { handle: asPaneHandle(paneId), result: { stdout: paneId, stderr: '', code: 0 } };
  }

  async closePane(_server: ServerConfig, handle: PaneHandle): Promise<ExecResult> {
    return this.execResult(() => this.rpc.request('pane.close', { paneId: handle }));
  }

  /** Visible screen only: `start`/`end` are visible-row numbers (0 = top) and scrollback (negative start) is clamped to the top. */
  async captureScreen(_server: ServerConfig, handle: PaneHandle, start?: number, end?: number): Promise<ExecResult> {
    const { text } = await this.rpc.request('pane.screen', { paneId: handle });
    const rows = text.split('\n');
    const selected = rows.slice(Math.max(0, start ?? 0), (end ?? rows.length - 1) + 1);
    return { stdout: selected.length === 0 ? '' : `${selected.join('\n')}\n`, stderr: '', code: 0 };
  }

  async sendKeysToHandle(_server: ServerConfig, handle: PaneHandle, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i++) {
      const bytes = encodeMisaoKey(keys[i]);
      await this.write(handle, bytes ?? keys[i]);
      if (bytes === undefined && Buffer.byteLength(keys[i], 'utf8') > LONG_TEXT_BYTES && keys[i + 1] === 'Enter') {
        await this.wait(LONG_TEXT_SUBMIT_DELAY_MS);
      }
    }
  }

  async sendTextToHandle(_server: ServerConfig, handle: PaneHandle, text: string): Promise<void> {
    await this.write(handle, text);
    if (Buffer.byteLength(text, 'utf8') > LONG_TEXT_BYTES) await this.wait(LONG_TEXT_PASTE_SETTLE_MS);
  }

  async panePidByHandle(_server: ServerConfig, handle: PaneHandle): Promise<number | null> {
    return (await this.paneInfo(handle))?.pid ?? null;
  }

  async paneCommandByHandle(_server: ServerConfig, handle: PaneHandle): Promise<string | null> {
    return (await this.paneInfo(handle))?.fgCommand ?? null;
  }

  async windowActivity(_server: ServerConfig, ref: MuxRef): Promise<number | null> {
    return lastOutputEpochSeconds(await this.windowPanes(ref));
  }

  // ─── Not supported by this driver (caps are false or the feature is not built yet) ───

  async startOutputStream(_server: ServerConfig, _handle: PaneHandle, _outputPath: string): Promise<void> { throw unsupported('startOutputStream'); }
  async stopOutputStream(_server: ServerConfig, _handle: PaneHandle): Promise<void> { throw unsupported('stopOutputStream'); }
  async zoomPaneByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<ExecResult> { throw unsupported('zoomPaneByHandle'); }
  async unzoomPaneByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<ExecResult> { throw unsupported('unzoomPaneByHandle'); }
  async isPaneInModeByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<boolean> { throw unsupported('isPaneInModeByHandle'); }
  async cancelPaneModeByHandle(_server: ServerConfig, _handle: PaneHandle): Promise<void> { throw unsupported('cancelPaneModeByHandle'); }
  async setPaneTitle(_server: ServerConfig, _handle: PaneHandle, _title: string): Promise<ExecResult> { throw unsupported('setPaneTitle'); }
  async captureLayout(_server: ServerConfig, _ref: MuxRef): Promise<never> { throw unsupported('captureLayout'); }
  async applyLayout(_server: ServerConfig, _ref: MuxRef, _layout: string): Promise<ExecResult> { throw unsupported('applyLayout'); }

  async measurePanePids(_server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>> {
    const panes = await this.rpc.request('pane.list', {});
    return panes.flatMap((p) => (p.processState === 'running' && p.pid !== null ? [{ ref: misaoRef(p.workspace, p.window.id), pid: p.pid }] : []));
  }

  async installChangeHooks(server: ServerConfig): Promise<void> {
    await this.changeEvents.install(server.name);
  }

  async uninstallChangeHooks(server: ServerConfig): Promise<void> {
    this.changeEvents.uninstall(server.name);
  }

  // ─── Internals ───

  /** Panes are read before workspaces so a window that exists when a pane is listed is also in the workspace list. */
  private async snapshot(): Promise<{ workspaces: MisaoWorkspace[]; panes: MisaoPane[] }> {
    const panes = await this.rpc.request('pane.list', {});
    const workspaces = await this.rpc.request('workspace.list', {});
    return { workspaces, panes };
  }

  /** Panes of the window in creation order. Throws when the window does not exist. */
  private async windowPanes(ref: MuxRef): Promise<MisaoPane[]> {
    const { workspaces, panes } = await this.snapshot();
    if (!workspaces.some((ws) => ws.windows.some((w) => w.windowId === ref.window))) throw new Error(`misao window ${ref.window} not found`);
    return panesOfWindow(panes, ref.window);
  }

  /** null when the daemon has no such pane. */
  private async paneInfo(handle: PaneHandle): Promise<MisaoPane | null> {
    try {
      return await this.rpc.request('pane.info', { paneId: handle });
    } catch (err) {
      if (this.rpc.rpcErrorCode(err) === MISAO_PANE_NOT_FOUND) return null;
      throw err;
    }
  }

  private async write(handle: PaneHandle, data: string): Promise<void> {
    await this.rpc.request('pane.write', { paneId: handle, data, source: 'hub' });
  }

  private async createWindowWithPane(workspace: string, windowName: string, command: string | undefined, extraEnv: Record<string, string> | undefined): Promise<string> {
    const { windowId } = await this.rpc.request('window.create', { workspace, name: windowName });
    try {
      await this.rpc.request('pane.open', {
        cmd: command ? [this.options.shell, '-lc', command] : [this.options.shell],
        windowId,
        labels: { origin: 'hub', name: windowName },
        // ephemeralEnv: env would be persisted by the daemon and shown by pane.info/pane.list (secrets such as task tokens).
        ...(extraEnv ? { ephemeralEnv: extraEnv } : {}),
      });
    } catch (err) {
      await this.rpc.request('window.close', { windowId }).catch(() => undefined);
      throw err;
    }
    return windowId;
  }

  /** RPC error responses become a non-zero ExecResult (like a failed tmux command); connection failures still throw. */
  private async execResult(op: () => Promise<unknown>): Promise<ExecResult> {
    try {
      await op();
      return OK;
    } catch (err) {
      if (this.rpc.rpcErrorCode(err) === undefined) throw err;
      return { stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1 };
    }
  }
}

/** `ordinal` is 1-based; non-integers (a malformed `pane=` query) are rejected like out-of-range values. */
function paneAtOrdinal(panes: MisaoPane[], ordinal: PaneOrdinal, ref: MuxRef): MisaoPane {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > panes.length) throw new Error(`Pane ordinal ${ordinal} out of range (1..${panes.length}) for ${ref.window}`);
  return panes[ordinal - 1];
}

function inheritedLabels(source: MisaoPane): Record<string, string> {
  const labels: Record<string, string> = { origin: 'hub', name: source.window.name };
  for (const key of ['windowId', 'task']) {
    if (key in source.labels) labels[key] = source.labels[key];
  }
  return labels;
}
