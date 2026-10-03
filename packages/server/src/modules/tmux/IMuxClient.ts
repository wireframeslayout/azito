import type { MuxDriverKind, MuxRef, PaneHandle, PaneOrdinal, MuxCapabilities, MuxWorkspace, MuxPaneInfo } from '@azito/shared';
import type { ExecResult, ITerminalStream, OpenTerminalOpts } from '../servers/transport/ServerTransport';
import type { ServerConfig } from '../servers/Server';

/** Hub-side identity stamped on a window's panes by drivers that keep pane labels. */
export interface PaneWindowLabels {
  windowId: number;
  taskId?: number;
}

export interface IMuxClient {
  readonly kind: MuxDriverKind;
  readonly caps: MuxCapabilities;
  /** Whether the driver stores hub labels on panes. Not part of `caps`: caps are exposed through the API. */
  readonly supportsPaneLabels: boolean;

  // ─── Workspace / Window ───

  listWorkspaces(server: ServerConfig): Promise<MuxWorkspace[]>;
  listWorkspacesStrict(server: ServerConfig): Promise<MuxWorkspace[]>;
  openWorkspace(server: ServerConfig, name: string, opts?: { command?: string; windowName?: string; exactName?: boolean; extraEnv?: Record<string, string> }): Promise<{ ref: MuxRef; result: ExecResult }>;
  openWindow(server: ServerConfig, workspace: string, baseName?: string, opts?: { exactName?: boolean; extraEnv?: Record<string, string> }): Promise<{ ref: MuxRef; result: ExecResult; windowName?: string }>;
  closeWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult>;
  closeWorkspace(server: ServerConfig, workspace: string): Promise<ExecResult>;
  renameWindowByRef(server: ServerConfig, ref: MuxRef, name: string): Promise<ExecResult>;
  renameWorkspace(server: ServerConfig, from: string, to: string): Promise<ExecResult>;
  windowExists(server: ServerConfig, ref: MuxRef): Promise<boolean>;
  focusWindow(server: ServerConfig, ref: MuxRef): Promise<ExecResult>;
  resolveRef(server: ServerConfig, target: string): Promise<MuxRef | null>;
  /** Stamps every pane of the window with the hub window/task identity. Only valid when `supportsPaneLabels`. */
  labelWindowPanes(server: ServerConfig, ref: MuxRef, labels: PaneWindowLabels): Promise<void>;

  // ─── Pane ───

  resolvePane(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal): Promise<PaneHandle>;
  listPanesByRef(server: ServerConfig, ref: MuxRef): Promise<Array<{ ordinal: PaneOrdinal; handle: PaneHandle; title: string; command: string; active: boolean }>>;
  listAllPanes(server: ServerConfig): Promise<MuxPaneInfo[]>;
  refFromPaneHandle(server: ServerConfig, handle: PaneHandle): Promise<{ ref: MuxRef; ordinal: PaneOrdinal } | null>;
  probePane(server: ServerConfig, handle: PaneHandle): Promise<{ alive: boolean; verified: boolean }>;
  splitPaneByHandle(server: ServerConfig, handle: PaneHandle, dir: 'h' | 'v', env?: Record<string, string>): Promise<{ handle: PaneHandle; result: ExecResult }>;
  /** Opens a new shell pane in an existing window and types `command` into it. Only the misao driver supports it. */
  openPaneInWindow(server: ServerConfig, ref: MuxRef, opts?: { command?: string; extraEnv?: Record<string, string> }): Promise<PaneHandle>;
  closePane(server: ServerConfig, handle: PaneHandle): Promise<ExecResult>;
  captureScreen(server: ServerConfig, handle: PaneHandle, start?: number, end?: number): Promise<ExecResult>;
  sendKeysToHandle(server: ServerConfig, handle: PaneHandle, keys: string[]): Promise<void>;
  sendTextToHandle(server: ServerConfig, handle: PaneHandle, text: string): Promise<void>;
  panePidByHandle(server: ServerConfig, handle: PaneHandle): Promise<number | null>;
  paneCommandByHandle(server: ServerConfig, handle: PaneHandle): Promise<string | null>;

  // ─── Capability-gated (caps must be true; tmux implements all) ───

  startOutputStream(server: ServerConfig, handle: PaneHandle, outputPath: string): Promise<void>;
  stopOutputStream(server: ServerConfig, handle: PaneHandle): Promise<void>;
  zoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult>;
  unzoomPaneByHandle(server: ServerConfig, handle: PaneHandle): Promise<ExecResult>;
  isPaneInModeByHandle(server: ServerConfig, handle: PaneHandle): Promise<boolean>;
  cancelPaneModeByHandle(server: ServerConfig, handle: PaneHandle): Promise<void>;
  setPaneTitle(server: ServerConfig, handle: PaneHandle, title: string): Promise<ExecResult>;
  windowActivity(server: ServerConfig, ref: MuxRef): Promise<number | null>;

  // ─── Layout / Resource ───

  /** Driver-opaque layout string. Only valid with the same driver's applyLayout. */
  captureLayout(server: ServerConfig, ref: MuxRef): Promise<{ layout: string; panes: Array<{ index: number; ordinal: PaneOrdinal; command: string | null; path: string | null; title: string | null }> }>;
  applyLayout(server: ServerConfig, ref: MuxRef, layout: string): Promise<ExecResult>;
  measurePanePids(server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>>;

  // ─── Terminal / Change Hooks (stage 3-B migration) ───

  openTerminal(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: OpenTerminalOpts): Promise<ITerminalStream>;
  installChangeHooks(server: ServerConfig): Promise<void>;
  uninstallChangeHooks(server: ServerConfig): Promise<void>;
}
