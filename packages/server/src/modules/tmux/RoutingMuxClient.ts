import { muxKindOfPaneHandle, type MuxCapabilities, type MuxDriverKind, type MuxPaneInfo, type MuxRef, type MuxUnavailableKind, type MuxWorkspace, type PaneHandle, type PaneOrdinal } from '@azito/shared';
import type { ExecResult, ITerminalStream, OpenTerminalOpts } from '../servers/transport/ServerTransport';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient, PaneLocation, PaneWindowLabels } from './IMuxClient';
import { MuxDriverUnavailableError, type MuxDriverUnavailableReason } from './MuxCapabilityError';

/** What the routing driver needs from the registry. */
export interface RoutingMuxDeps {
  /** The registered driver of a kind, without a server probe (static properties such as caps). */
  driver(kind: MuxDriverKind): IMuxClient;
  /** The driver of a kind for a server; throws `MuxDriverUnavailableError` when it cannot serve that server right now. */
  resolveKind(kind: MuxDriverKind, server: ServerConfig): IMuxClient;
  /** The kinds a server can serve now, the server's default kind first. */
  usableKinds(server: ServerConfig): MuxDriverKind[];
  /** The kinds the server hosts that cannot be called now (non-default ones; the default is always called). */
  downKinds(server: ServerConfig): Array<{ kind: MuxDriverKind; reason: MuxDriverUnavailableReason }>;
}

function describeUnavailable(kind: MuxDriverKind, err: unknown): MuxUnavailableKind {
  if (err instanceof MuxDriverUnavailableError) return { kind, reason: err.reason, detail: err.message };
  return { kind, reason: 'driver_error', detail: err instanceof Error ? err.message : String(err) };
}

/**
 * An `IMuxClient` that sends each call to the tmux or misao driver that owns its argument: a `MuxRef` by `ref.kind`,
 * a pane handle by its shape, and a server-wide call to every kind the server can serve.
 *
 * `kind`/`caps` are those of the server's default mux (`kind`): they describe where a call with no `kind` goes.
 * A per-window or per-pane decision must not read them: it resolves the driver of the window's / pane's own kind
 * (`registry.resolveKind`). Pane labels are decided per window here (`labelWindowPanes`).
 *
 * A server with a single usable kind is passed straight through: same driver, same errors, no merging. A kind the
 * server hosts but that cannot be called now is still reported as unavailable by the merged listings.
 */
export class RoutingMuxClient implements IMuxClient {
  constructor(
    private readonly deps: RoutingMuxDeps,
    readonly kind: MuxDriverKind,
  ) {}

  get caps(): MuxCapabilities { return this.deps.driver(this.kind).caps; }
  /** Always true: `labelWindowPanes` labels a window whose mux keeps pane labels and leaves any other window alone. */
  readonly supportsPaneLabels = true;

  private forRef(server: ServerConfig, ref: MuxRef): IMuxClient { return this.deps.resolveKind(ref.kind, server); }
  private forHandle(server: ServerConfig, handle: PaneHandle): IMuxClient { return this.deps.resolveKind(muxKindOfPaneHandle(handle), server); }
  private forKind(server: ServerConfig, kind: MuxDriverKind | undefined): IMuxClient { return this.deps.resolveKind(kind ?? this.kind, server); }

  /**
   * Runs `op` on every usable kind in parallel. A kind that fails, or that the server hosts but cannot be called now,
   * is returned in `unavailable` with the rest of the items; when every usable kind fails the first error (the
   * default kind's) is thrown.
   */
  private async gather<T>(server: ServerConfig, op: (driver: IMuxClient, kind: MuxDriverKind) => Promise<T[]>): Promise<{ items: T[]; unavailable: MuxUnavailableKind[] }> {
    const kinds = this.deps.usableKinds(server);
    const down: MuxUnavailableKind[] = this.deps.downKinds(server).map(({ kind, reason }) => ({ kind, reason }));
    if (kinds.length === 1) {
      const items = await op(this.deps.resolveKind(kinds[0], server), kinds[0]);
      return { items, unavailable: down };
    }
    const settled = await Promise.allSettled(kinds.map((kind) => Promise.resolve().then(() => op(this.deps.resolveKind(kind, server), kind))));
    const items: T[] = [];
    const unavailable: MuxUnavailableKind[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') items.push(...outcome.value);
      else unavailable.push(describeUnavailable(kinds[i], outcome.reason));
    });
    if (unavailable.length === kinds.length) {
      const first = settled.find((o): o is PromiseRejectedResult => o.status === 'rejected')!;
      throw first.reason;
    }
    return { items, unavailable: [...unavailable, ...down] };
  }

  /** Runs `op` on every usable kind; any failure is thrown after all kinds have finished (nothing is hidden). */
  private async eachKind<T>(server: ServerConfig, op: (driver: IMuxClient, kind: MuxDriverKind) => Promise<T>): Promise<T[]> {
    const kinds = this.deps.usableKinds(server);
    const settled = await Promise.allSettled(kinds.map((kind) => Promise.resolve().then(() => op(this.deps.resolveKind(kind, server), kind))));
    const failed = settled.find((o): o is PromiseRejectedResult => o.status === 'rejected');
    if (failed) throw failed.reason;
    return (settled as PromiseFulfilledResult<T>[]).map((o) => o.value);
  }

  // ─── Workspace / Window ───

  /** Like `listWorkspaces`, with the kinds that could not be listed returned alongside (one call, no shared-state race). */
  async listWorkspacesDetailed(server: ServerConfig): Promise<{ workspaces: Array<MuxWorkspace & { kind: MuxDriverKind }>; unavailable: MuxUnavailableKind[] }> {
    const { items, unavailable } = await this.gather(server, async (driver, kind) => (await driver.listWorkspaces(server)).map((ws) => ({ ...ws, kind })));
    return { workspaces: items, unavailable };
  }

  async listWorkspaces(server: ServerConfig): Promise<MuxWorkspace[]> {
    return (await this.listWorkspacesDetailed(server)).workspaces;
  }

  /**
   * Strict contract: every usable kind must answer, or the call fails. A non-default kind that is down is not called and
   * does not fail it: it may be a mux the server merely could host (misao not installed on a local server).
   */
  async listWorkspacesStrict(server: ServerConfig): Promise<MuxWorkspace[]> {
    const perKind = await this.eachKind(server, async (driver, kind) => (await driver.listWorkspacesStrict(server)).map((ws) => ({ ...ws, kind })));
    return perKind.flat();
  }

  async openWorkspace(server: ServerConfig, name: string, opts?: Parameters<IMuxClient['openWorkspace']>[2]) {
    return this.forKind(server, opts?.kind).openWorkspace(server, name, opts);
  }

  async openWindow(server: ServerConfig, workspace: string, baseName?: string, opts?: Parameters<IMuxClient['openWindow']>[3]) {
    return this.forKind(server, opts?.kind).openWindow(server, workspace, baseName, opts);
  }

  async closeWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> { return this.forRef(server, ref).closeWindow(server, ref); }
  async closeWorkspace(server: ServerConfig, workspace: string, opts?: { kind?: MuxDriverKind }): Promise<ExecResult> { return this.forKind(server, opts?.kind).closeWorkspace(server, workspace); }
  async renameWindowByRef(server: ServerConfig, ref: MuxRef, name: string): Promise<ExecResult> { return this.forRef(server, ref).renameWindowByRef(server, ref, name); }
  async renameWorkspace(server: ServerConfig, from: string, to: string, opts?: { kind?: MuxDriverKind }): Promise<ExecResult> { return this.forKind(server, opts?.kind).renameWorkspace(server, from, to); }
  async windowExists(server: ServerConfig, ref: MuxRef): Promise<boolean> { return this.forRef(server, ref).windowExists(server, ref); }
  async focusWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult> { return this.forRef(server, ref).focusWindow(server, ref); }
  async resolveRef(server: ServerConfig, target: string, opts?: { kind?: MuxDriverKind }): Promise<MuxRef | null> { return this.forKind(server, opts?.kind).resolveRef(server, target); }
  async labelWindowPanes(server: ServerConfig, ref: MuxRef, labels: PaneWindowLabels): Promise<void> {
    const driver = this.forRef(server, ref);
    if (!driver.supportsPaneLabels) return;
    await driver.labelWindowPanes(server, ref, labels);
  }

  // ─── Pane ───

  async resolvePane(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal): Promise<PaneHandle> { return this.forRef(server, ref).resolvePane(server, ref, ordinal); }
  async listPanesByRef(server: ServerConfig, ref: MuxRef) { return this.forRef(server, ref).listPanesByRef(server, ref); }

  async listAllPanes(server: ServerConfig): Promise<MuxPaneInfo[]> {
    return (await this.gather(server, (driver) => driver.listAllPanes(server))).items;
  }

  async refFromPaneHandle(server: ServerConfig, handle: PaneHandle) { return this.forHandle(server, handle).refFromPaneHandle(server, handle); }
  async locatePane(server: ServerConfig, handle: PaneHandle): Promise<PaneLocation> { return this.forHandle(server, handle).locatePane(server, handle); }
  async probePane(server: ServerConfig, handle: PaneHandle) { return this.forHandle(server, handle).probePane(server, handle); }
  async splitPaneByHandle(server: ServerConfig, handle: PaneHandle, dir: 'h' | 'v', env?: Record<string, string>) { return this.forHandle(server, handle).splitPaneByHandle(server, handle, dir, env); }
  async openPaneInWindow(server: ServerConfig, ref: MuxRef, opts?: { command?: string; extraEnv?: Record<string, string>; labels?: PaneWindowLabels }): Promise<PaneHandle> { return this.forRef(server, ref).openPaneInWindow(server, ref, opts); }
  async closePane(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> { return this.forHandle(server, handle).closePane(server, handle); }
  async captureScreen(server: ServerConfig, handle: PaneHandle, start?: number, end?: number): Promise<ExecResult> { return this.forHandle(server, handle).captureScreen(server, handle, start, end); }
  async sendKeysToHandle(server: ServerConfig, handle: PaneHandle, keys: string[]): Promise<void> { return this.forHandle(server, handle).sendKeysToHandle(server, handle, keys); }
  async sendTextToHandle(server: ServerConfig, handle: PaneHandle, text: string): Promise<void> { return this.forHandle(server, handle).sendTextToHandle(server, handle, text); }
  async panePidByHandle(server: ServerConfig, handle: PaneHandle): Promise<number | null> { return this.forHandle(server, handle).panePidByHandle(server, handle); }
  async paneCommandByHandle(server: ServerConfig, handle: PaneHandle): Promise<string | null> { return this.forHandle(server, handle).paneCommandByHandle(server, handle); }

  // ─── Capability-gated ───

  async startOutputStream(server: ServerConfig, handle: PaneHandle, outputPath: string): Promise<void> { return this.forHandle(server, handle).startOutputStream(server, handle, outputPath); }
  async stopOutputStream(server: ServerConfig, handle: PaneHandle): Promise<void> { return this.forHandle(server, handle).stopOutputStream(server, handle); }
  async zoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> { return this.forHandle(server, handle).zoomPaneByHandle(server, handle); }
  async unzoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult> { return this.forHandle(server, handle).unzoomPaneByHandle(server, handle); }
  async isPaneInModeByHandle(server: ServerConfig, handle: PaneHandle): Promise<boolean> { return this.forHandle(server, handle).isPaneInModeByHandle(server, handle); }
  async cancelPaneModeByHandle(server: ServerConfig, handle: PaneHandle): Promise<void> { return this.forHandle(server, handle).cancelPaneModeByHandle(server, handle); }
  async setPaneTitle(server: ServerConfig, handle: PaneHandle, title: string): Promise<ExecResult> { return this.forHandle(server, handle).setPaneTitle(server, handle, title); }
  async windowActivity(server: ServerConfig, ref: MuxRef): Promise<number | null> { return this.forRef(server, ref).windowActivity(server, ref); }

  // ─── Layout / Resource ───

  async captureLayout(server: ServerConfig, ref: MuxRef) { return this.forRef(server, ref).captureLayout(server, ref); }
  async applyLayout(server: ServerConfig, ref: MuxRef, layout: string): Promise<ExecResult> { return this.forRef(server, ref).applyLayout(server, ref, layout); }

  async measurePanePids(server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>> {
    return (await this.gather(server, (driver) => driver.measurePanePids(server))).items;
  }

  // ─── Terminal / Change Hooks ───

  async openTerminal(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: OpenTerminalOpts): Promise<ITerminalStream> {
    return this.forRef(server, ref).openTerminal(server, ref, ordinal, cols, rows, opts);
  }

  async installChangeHooks(server: ServerConfig): Promise<void> {
    await this.eachKind(server, (driver) => driver.installChangeHooks(server));
  }

  async uninstallChangeHooks(server: ServerConfig): Promise<void> {
    await this.eachKind(server, (driver) => driver.uninstallChangeHooks(server));
  }
}
