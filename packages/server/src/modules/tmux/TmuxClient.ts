import type { ExecResult, ITerminalStream } from '../servers/transport/ServerTransport';
import type { TransportFactory } from '../servers/transport/TransportFactory';
export { ServerConfig } from '../servers/Server';
import type { ServerConfig } from '../servers/Server';
import { generateWindowName, extractWindowId } from './windowNameUtils';
import { ISOLATION_MASKED_ENV } from '../../shared/auth/isolationMaskedEnv';
import type { IMuxClient } from './IMuxClient';
import { type MuxRef, type PaneHandle, type PaneOrdinal, type MuxCapabilities, type MuxDriverKind, asPaneHandle, muxRefFromTmuxTarget, tmuxTargetFromMuxRef } from '@azito/shared';
import type { TmuxPane, TmuxWindow, TmuxSession, TmuxPaneInfo } from './types';
import { HOOK_EVENTS, buildHookValue, buildHookSetArgs, buildHookUnsetArgs } from './tmuxHooks';

export type { TmuxPane, TmuxWindow, TmuxSession, TmuxPaneInfo };

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

// ─── Session listing (shared by listSessions / listSessionsForSecurityGate) ───

const TMUX_LIST_PANES_FORMAT = [
  '#{session_name}', '#{session_windows}', '#{session_attached}', '#{session_created}',
  '#{window_index}', '#{window_name}', '#{window_active}', '#{window_activity}',
  '#{pane_index}', '#{pane_current_command}', '#{pane_width}', '#{pane_height}', '#{pane_active}', '#{pane_pid}', '#{pane_title}',
].join('|||');

/** Parses `tmux list-panes -a -F <TMUX_LIST_PANES_FORMAT>` stdout into sessions (unfiltered). */
function parseSessionLines(stdout: string): TmuxSession[] {
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

  return Array.from(sessionMap.values()).map((s) => ({
    ...s,
    windows: Array.from(s.windows.values()),
  }));
}

/**
 * Matches the two `tmux list-panes -a` failure wordings that mean "there is
 * no tmux server to list sessions from" — verified against a live tmux 3.4
 * binary (this project's target version, see AGENTS.md):
 *   - `error connecting to <sock> (No such file or directory)` — socket file
 *     never existed (server never started).
 *   - `no server running on <sock>` — socket file exists but the server
 *     process behind it is gone.
 * See `TmuxClient.listSessionsForSecurityGate` for why this distinction
 * matters: anything NOT matching one of these two is an unverifiable failure
 * that must be treated as "cannot confirm no sessions," not as "no sessions."
 */
function isTmuxNoServerRunning(output: string): boolean {
  return /no server running on|error connecting to .*\(no such file or directory\)/i.test(output);
}

// ─── TmuxClient ───

const LINKED_SESSION_PREFIX = '_azito_';

export class TmuxClient implements IMuxClient {
  readonly kind: MuxDriverKind = 'tmux';
  readonly caps: MuxCapabilities = {
    outputStream: true, changeEvents: true, agentState: false,
    independentClients: true, envInjection: true, zoom: true,
    copyMode: true, paneTitle: true, activityCounter: true,
  };

  constructor(
    private transportFactory: TransportFactory,
    private publicUrl: string,
    private uiToken: string,
    /** Loopback URL of this hub (`http://127.0.0.1:<port>`). */
    private localUrl: string,
    /** Webhook token for hook auth. Falls back to uiToken when omitted. */
    private webhookToken?: string,
  ) {}

  /**
   * URL that panes on `server` should use to reach the hub.
   *
   * Panes on the hub's own machine get the loopback URL: a host does not
   * necessarily reach itself through its public address. With `tailscale serve`
   * on WSL2, for instance, the MagicDNS name resolves but the connection to the
   * host's own Tailscale IP never completes, so supervisors launched there could
   * never register and every supervised window timed out. Remote servers keep
   * the public URL, which is the only address that works for them.
   */
  private hubUrlFor(server: ServerConfig): string {
    return server.type === 'local' ? this.localUrl : this.publicUrl;
  }

  private async runTmuxCommand(server: ServerConfig, args: string[]): Promise<ExecResult> {
    return this.transportFactory.getTransport(server).execTmux(args);
  }

  async listSessions(server: ServerConfig): Promise<TmuxSession[]> {
    try {
      const stdout = await this.execListPanesAll(server);
      return parseSessionLines(stdout).filter((s) => !s.name.startsWith('_azito_'));
    } catch (err: unknown) {
      const e = err as { message?: string; stderr?: string };
      if (e.message?.includes('no server running') || e.stderr?.includes('no server running')) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Security-gate-only variant of {@link listSessions}, used exclusively by
   * the isolation-enablement check in `servers/routes.ts` (Issue #29 review,
   * Critical finding 1). Two deliberate differences from the display-oriented
   * `listSessions()`:
   *
   * 1. Exit code is authoritative. `LocalTransport.execTmux` rejects the
   *    promise on ANY non-zero tmux exit, but `AgentTransport.execTmux` never
   *    rejects on the remote command's own exit code — it resolves with
   *    whatever `ExecResult` (including non-zero `code`) the agent process's
   *    tmux run produced, only rejecting on an HTTP-level failure (see
   *    `AgentTransport.post` / `agent/routes.ts`'s `execTmuxCommand`, and the
   *    same normalization already used by `resolveKillOutcome`/
   *    `checkPaneLiveness`). `listSessions()` only inspects `stdout`, so on an
   *    `agent`-type server a connection/permission failure that still HTTP
   *    200s with an empty `stdout` reads as "no sessions" — fail open. Here,
   *    ANY non-zero code is treated as "cannot verify" (thrown) UNLESS the
   *    output matches one of the two tmux-no-server-running wordings verified
   *    against a live tmux 3.4 binary below.
   * 2. `_azito_` linked sessions (the temporary sessions `openTerminal`
   *    creates) are NOT excluded. `listSessions()` hides them because they're
   *    display noise, but if the original session they link to disappeared
   *    while the linked one is still alive, a pane carrying credentials can
   *    still be live under that name — the isolation gate must count it.
   *
   * No-server confirmation is limited to the two wordings actually produced
   * by `tmux list-panes -a` when there is nothing to list (verified by
   * running both scenarios against tmux 3.4, the version this project
   * targets — see AGENTS.md):
   *   - `error connecting to <sock> (No such file or directory)` — the tmux
   *     socket file itself has never been created (server never started).
   *   - `no server running on <sock>` — the socket file exists but the tmux
   *     server process behind it is gone (e.g. it exited after its last
   *     session was killed).
   * Any other failure (auth rejection, network unreachable, timeout, a
   * genuinely unexpected tmux error) does NOT match either wording and is
   * therefore re-thrown, so the caller fails closed (409) instead of
   * treating an unverifiable state as "no sessions."
   */
  async listSessionsForSecurityGate(server: ServerConfig): Promise<TmuxSession[]> {
    const format = TMUX_LIST_PANES_FORMAT;
    let result: ExecResult;
    try {
      result = await this.runTmuxCommand(server, ['list-panes', '-a', '-F', format]);
    } catch (err) {
      result = { stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1 };
    }
    if (result.code === 0) {
      return parseSessionLines(result.stdout);
    }
    const output = `${result.stderr || ''}${result.stdout || ''}`;
    if (isTmuxNoServerRunning(output)) {
      return [];
    }
    throw new Error(`tmux list-panes failed (code ${result.code}): ${output || '(no output)'}`);
  }

  private async execListPanesAll(server: ServerConfig): Promise<string> {
    const { stdout } = await this.runTmuxCommand(server, ['list-panes', '-a', '-F', TMUX_LIST_PANES_FORMAT]);
    return stdout;
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
    const args = ['new-session', '-d', '-s', sessionName, '-n', windowName, '-e', `AZITO_URL=${this.hubUrlFor(server)}`];
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
    const args = ['new-window', '-t', sessionName, '-n', windowName, '-e', `AZITO_URL=${this.hubUrlFor(server)}`];
    if (options?.extraEnv) {
      for (const [k, v] of Object.entries(options.extraEnv)) {
        args.push('-e', `${k}=${v}`);
      }
    }
    const result = await this.runTmuxCommand(server, args);
    await this.setWindowStatusFormat(server, sessionName, windowName);
    return { result, windowName };
  }

  /**
   * Legacy default env for a window that is NOT a task pane (Issue #28
   * Phase A後半): `createSession`/`createWindow` above used to inject
   * AZITO_UI_TOKEN unconditionally into every window they created,
   * regardless of caller — that meant a task pane always carried the
   * all-powerful UI token too, which is exactly what design v3 §2 (task
   * panes get a scoped AZITO_TASK_TOKEN instead) needs to stop. The
   * unconditional injection is gone; every caller now decides its own
   * `extraEnv` explicitly. Callers that open a plain terminal/manual/project
   * window (not a task's — those go through TaskPaneEnvironmentService
   * instead, which decides UI-token inclusion via the AZITO_SCOPED_AUTH
   * flag) call this to reproduce the old default.
   */
  uiTokenEnv(): Record<string, string> {
    return this.uiToken ? { AZITO_UI_TOKEN: this.uiToken } : {};
  }

  /**
   * Server-aware wrapper around {@link uiTokenEnv} (Issue #29 review, Critical
   * finding 1): `uiTokenEnv()` above has no way to know which server it is
   * injecting into, so every one of its call sites — manual session/window/
   * pane creation in `modules/tmux/routes/sessions.ts`, and the non-task
   * respawn fallback in `WindowRespawnService.run()` — happily injected the
   * hub's all-powerful `AZITO_UI_TOKEN` into an `isolation_intent=1` server's
   * pane too, exactly the credential that server is declared to hold none of.
   * (Task-owned windows already avoid this via
   * `TaskPaneEnvironmentService`/`applyTokenMaskingOrCompat`, which checks
   * `server.isolationIntent` first — this is the same decision, applied to
   * the handful of NON-task callers that still call the legacy default
   * directly instead.)
   *
   * When `server.isolationIntent` is set, returns the shared
   * {@link ISOLATION_MASKED_ENV} mask (both `AZITO_UI_TOKEN` AND
   * `AZITO_AGENT_TOKEN` — an agent-type isolated server's process env holds
   * the latter too, see `agent/main.ts`) rather than an empty object — see
   * `applyTokenMaskingOrCompat`'s doc comment for why an explicit empty value
   * is required to override a token the pane's tmux SESSION may already
   * carry (a pre-existing session's env persists across `new-window`, and
   * `-e KEY=` on the new window is the only thing that can mask it).
   */
  uiTokenEnvForServer(server: ServerConfig): Record<string, string> {
    if (server.isolationIntent) return { ...ISOLATION_MASKED_ENV };
    return this.uiTokenEnv();
  }

  /**
   * Post-creation decoration only (the tmux status-bar window label), called
   * by both `createSession` and `createWindow` right after the window itself
   * is already up. Deliberately best-effort (Issue #28 Phase A last-round
   * fix): a failure here is a cosmetic status-bar miss, not a reason to fail
   * the whole `createWindow`/`createSession` call — the caller's window was
   * already created, and `WindowRotation.createRotatedWindow` treats any
   * rejection out of its `create` callback as "nothing was actually
   * created," revoking the just-issued task-token generation. Letting this
   * decoration failure propagate would misreport a real, live, untracked
   * pane as never having been created, leaving it holding a revoked token.
   * Failures are still surfaced via a warn log rather than swallowed
   * silently, so they remain visible for diagnosis.
   */
  private async setWindowStatusFormat(server: ServerConfig, sessionName: string, windowName: string): Promise<void> {
    const id = extractWindowId(windowName);
    if (!id) return;
    await this.runTmuxCommand(server, [
      'set-window-option', '-t', `${sessionName}:${windowName}`,
      'window-status-format', `#I:${windowName}`,
    ]).catch((err: unknown) => {
      console.warn(`[tmux] Failed to set window-status-format for ${sessionName}:${windowName}: ${err instanceof Error ? err.message : err}`);
    });
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

  /**
   * Target pane の OS プロセスID（`#{pane_pid}`）。WindowSessionResolver のプロセス実体検査
   * （agentDetected 判定レイヤー2）で、pane の子孫プロセスを辿る起点として使う。pane が存在しない/
   * tmux エラー時は null。
   */
  async getPanePid(server: ServerConfig, target: string): Promise<number | null> {
    try {
      const { stdout, code } = await this.runTmuxCommand(server, [
        'display-message', '-p', '-t', target, '#{pane_pid}',
      ]);
      if (code !== 0) return null;
      const pid = parseInt(stdout.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
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

  /**
   * 全セッション・全ウィンドウのペインを列挙する（pane_current_path 込み）。
   * `_azito_` プレフィックスのリンクドセッション（ブラウザタブごとの一時セッション）は
   * 実ペインの重複表示になるため除外する。
   */
  async listAllPanes(server: ServerConfig): Promise<TmuxPaneInfo[]> {
    const format = [
      '#{pane_id}', '#{session_name}', '#{window_index}', '#{window_name}', '#{pane_index}', '#{pane_current_path}', '#{pane_current_command}',
    ].join('|||');

    try {
      const { stdout } = await this.runTmuxCommand(server, ['list-panes', '-a', '-F', format]);
      return stdout.trim().split('\n').filter(Boolean)
        .map((line) => {
          const [paneId, sessionName, windowIndex, windowName, paneIndex, currentPath, currentCommand] = line.split('|||');
          return {
            paneId,
            sessionName,
            windowIndex: parseInt(windowIndex, 10),
            windowName,
            paneIndex: parseInt(paneIndex, 10),
            currentPath,
            currentCommand,
          };
        })
        .filter((pane) => !pane.sessionName.startsWith('_azito_'));
    } catch (err: unknown) {
      const e = err as { message?: string; stderr?: string };
      if (e.message?.includes('no server running') || e.stderr?.includes('no server running')) {
        return [];
      }
      throw err;
    }
  }

  async checkPaneExists(server: ServerConfig, target: string): Promise<boolean> {
    try {
      await this.runTmuxCommand(server, ['list-panes', '-t', target]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Like {@link checkPaneExists}, but distinguishes "confirmed gone" from
   * "couldn't verify" instead of collapsing both into `false` (Issue #28
   * third-party review finding — `azito auth doctor`'s drain check: a caller
   * that treats every failure as "pane gone" reports a clean/green result
   * for a server it in fact could never reach, e.g. an `agent` server that's
   * down, or a token mismatch). Mirrors `resolveKillOutcome`'s local-throws
   * vs agent-resolves-with-nonzero-code normalization (see its doc comment):
   * `LocalTransport.execTmux` rejects on ANY non-zero tmux exit, so a local
   * "pane not found" and a local "tmux binary missing" are both caught here
   * and must be told apart by message content, while `AgentTransport.execTmux`
   * only rejects on an HTTP-level failure (network unreachable, auth
   * rejected) and otherwise resolves with whatever `ExecResult` (including a
   * non-zero `code`) the remote agent's own tmux run produced.
   */
  async checkPaneLiveness(server: ServerConfig, target: string): Promise<{ alive: boolean; verified: boolean }> {
    let result: ExecResult;
    try {
      result = await this.runTmuxCommand(server, ['list-panes', '-t', target]);
    } catch (err) {
      result = { stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1 };
    }
    if (result.code === 0) return { alive: true, verified: true };
    const output = `${result.stderr || ''}${result.stdout || ''}`;
    // Same "confirmed absent" phrasing `resolveKillOutcome` matches — see its
    // doc comment for why each of these three strings means "definitely not
    // there" rather than "we couldn't tell."
    const confirmedAbsent =
      output.includes("can't find") ||
      output.includes('no such session') ||
      output.includes('no server running');
    return { alive: false, verified: confirmedAbsent };
  }

  /**
   * `extraEnv` (Issue #28 review Critical finding): `tmux new-window -e` only
   * affects the FIRST pane of a newly-created window — every pane a
   * subsequent `split-window` adds to that window inherits the tmux
   * SESSION's environment instead (verified against tmux 3.4, same
   * inheritance behavior TaskPaneEnvironmentService.buildEnvForNewWindow's
   * denylist-override comment documents for `new-window` into an existing
   * session). A task-owned window with more than one pane therefore left
   * every pane after the first authenticating with whatever the session
   * happened to carry (the operator's own AZITO_UI_TOKEN in a pre-existing
   * session) instead of the task's scoped AZITO_TASK_TOKEN, and never
   * received the task token at all. `split-window -e` accepts the same
   * `-e KEY=VALUE` env override `new-window`/`new-session` do — supported
   * since tmux 3.0 (`new-window -e` and `split-window -e` were added
   * together in that release; this codebase targets tmux 3.4, see
   * AGENTS.md). Callers that (re)create panes for a task-owned window MUST
   * pass the same env `createRotatedWindow()` used for the window's first
   * pane so every pane in the window carries an identical, correctly-scoped
   * environment; a plain (non-task) manual pane split passes nothing, same
   * as before.
   */
  async splitPane(server: ServerConfig, target: string, direction: 'h' | 'v', extraEnv?: Record<string, string>): Promise<ExecResult> {
    const flag = direction === 'h' ? '-h' : '-v';
    const args = ['split-window', flag, '-t', target];
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) {
        args.push('-e', `${k}=${v}`);
      }
    }
    return this.runTmuxCommand(server, args);
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

  /**
   * `sendKeys` は "Enter"/"C-c"/"Escape" 等の完全一致文字列を特殊キーとして解釈するため、
   * ユーザーが自由入力した本文（例: "C-c" という一行）をそのまま渡すと割り込み等の制御シーケンスに
   * 誤解釈されうる。任意テキストを送る場合は必ずこちらを使い、特殊キー判定を一切通さない。
   */
  async sendLiteralText(server: ServerConfig, target: string, text: string): Promise<void> {
    if (Buffer.byteLength(text, 'utf8') > 500) {
      await this.sendLongText(server, target, text);
    } else {
      await this.runTmuxCommand(server, ['send-keys', '-t', target, '-l', text]);
    }
  }

  /**
   * ペインが copy-mode（スクロールバック閲覧中）かどうかを判定する（Issue #69 T12）。copy-mode 中は
   * `send-keys -l` のリテラル入力がバッファへの選択操作として吸収され、対象アプリケーションに届かない
   * ため、送信前にこの判定を挟んで {@link cancelPaneMode} で解除する必要がある。tmux 側のエラー・
   * 対象ペイン不在時は「モード不明」として false を返し、呼び出し元は通常の送信を続行する
   * （in-mode 判定ができないことを理由に送信自体をブロックしない）。
   */
  async isPaneInMode(server: ServerConfig, target: string): Promise<boolean> {
    try {
      const { stdout, code } = await this.runTmuxCommand(server, [
        'display-message', '-p', '-t', target, '#{pane_in_mode}',
      ]);
      if (code !== 0) return false;
      return stdout.trim() === '1';
    } catch {
      return false;
    }
  }

  /**
   * copy-mode を解除する（`send-keys -X cancel`）。`-X` は copy-mode 中のペインにのみ有効なコマンド
   * ディスパッチのため、呼び出し元は必ず {@link isPaneInMode} で in-mode を確認してから呼ぶこと
   * （in-mode でないペインに送っても tmux 側は無害だが、意図を明確にするため呼び出し側で条件分岐する）。
   */
  async cancelPaneMode(server: ServerConfig, target: string): Promise<void> {
    await this.runTmuxCommand(server, ['send-keys', '-X', '-t', target, 'cancel']);
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

  // ─── IMuxClient implementation ───

  async listWorkspaces(server: ServerConfig) { return this.listSessions(server); }
  async listWorkspacesStrict(server: ServerConfig) { return this.listSessionsForSecurityGate(server); }

  async openWorkspace(server: ServerConfig, name: string, opts?: { command?: string; windowName?: string; exactName?: boolean; extraEnv?: Record<string, string> }) {
    const { result, windowName } = await this.createSession(server, name, opts);
    return { ref: { kind: 'tmux' as const, workspace: name, window: windowName }, result };
  }

  async openWindow(server: ServerConfig, workspace: string, baseName?: string, opts?: { exactName?: boolean; extraEnv?: Record<string, string> }) {
    const { result, windowName } = await this.createWindow(server, workspace, baseName, opts);
    return { ref: { kind: 'tmux' as const, workspace, window: windowName }, result };
  }

  async closeWindow(server: ServerConfig, ref: MuxRef) { return this.killWindow(server, tmuxTargetFromMuxRef(ref)); }
  async closeWorkspace(server: ServerConfig, workspace: string) { return this.killSession(server, workspace); }
  async renameWindowByRef(server: ServerConfig, ref: MuxRef, name: string) { return this.renameWindow(server, tmuxTargetFromMuxRef(ref), name); }
  async renameWorkspace(server: ServerConfig, from: string, to: string) { return this.renameSession(server, from, to); }
  async windowExists(server: ServerConfig, ref: MuxRef) { return this.checkPaneExists(server, tmuxTargetFromMuxRef(ref)); }

  async resolveRef(server: ServerConfig, target: string): Promise<MuxRef | null> {
    const identity = await this.getWindowIdentity(server, target);
    if (!identity) return null;
    return { kind: 'tmux', workspace: identity.sessionName, window: identity.windowName };
  }

  async resolvePane(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal): Promise<PaneHandle> {
    const target = tmuxTargetFromMuxRef(ref);
    const { stdout, code } = await this.runTmuxCommand(server, ['list-panes', '-t', target, '-F', '#{pane_index}\t#{pane_id}']);
    if (code !== 0) throw new Error(`Failed to list panes for ${target}`);
    const entries = stdout.trim().split('\n').filter(Boolean)
      .map(line => { const [idx, id] = line.split('\t'); return { index: parseInt(idx, 10), paneId: id }; })
      .sort((a, b) => a.index - b.index);
    if (ordinal < 1 || ordinal > entries.length) throw new Error(`Pane ordinal ${ordinal} out of range (1..${entries.length}) for ${target}`);
    return asPaneHandle(entries[ordinal - 1].paneId);
  }

  async listPanesByRef(server: ServerConfig, ref: MuxRef) {
    const target = tmuxTargetFromMuxRef(ref);
    const { stdout, code } = await this.runTmuxCommand(server, ['list-panes', '-t', target, '-F', '#{pane_index}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}\t#{pane_active}']);
    if (code !== 0) throw new Error(`Failed to list panes for ${target}`);
    const entries = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [idx, id, title, command, active] = line.split('\t');
      return { index: parseInt(idx, 10), id, title: title || '', command: command || '', active: active === '1' };
    });
    entries.sort((a, b) => a.index - b.index);
    return entries.map((e, i) => ({
      ordinal: (i + 1) as PaneOrdinal, handle: asPaneHandle(e.id), title: e.title, command: e.command, active: e.active,
    }));
  }

  async refFromPaneHandle(server: ServerConfig, handle: PaneHandle): Promise<{ ref: MuxRef; ordinal: PaneOrdinal } | null> {
    const format = ['#{pane_id}', '#{session_name}', '#{window_name}', '#{pane_index}', '#{?session_grouped,#{session_group},#{session_name}}'].join('\t');
    let result: ExecResult;
    try { result = await this.runTmuxCommand(server, ['list-panes', '-a', '-F', format]); } catch { return null; }
    if (result.code !== 0) return null;

    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const parsed = lines.map(line => {
      const [paneId, _sessionName, windowName, paneIndex, resolvedSession] = line.split('\t');
      return { paneId, windowName, paneIndex: parseInt(paneIndex, 10), resolvedSession };
    });

    const target = parsed.find(p => p.paneId === (handle as string));
    if (!target) return null;

    const windowKey = `${target.resolvedSession}\t${target.windowName}`;
    const siblings = parsed
      .filter(p => `${p.resolvedSession}\t${p.windowName}` === windowKey)
      .sort((a, b) => a.paneIndex - b.paneIndex);
    const ordinal = siblings.findIndex(p => p.paneId === (handle as string)) + 1;

    return { ref: { kind: 'tmux', workspace: target.resolvedSession, window: target.windowName }, ordinal };
  }

  async probePane(server: ServerConfig, handle: PaneHandle) { return this.checkPaneLiveness(server, handle as string); }

  async splitPaneByHandle(server: ServerConfig, handle: PaneHandle, dir: 'h' | 'v', env?: Record<string, string>): Promise<{ handle: PaneHandle; result: ExecResult }> {
    const flag = dir === 'h' ? '-h' : '-v';
    const args = ['split-window', flag, '-t', handle as string, '-P', '-F', '#{pane_id}'];
    if (env) { for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`); }
    const result = await this.runTmuxCommand(server, args);
    return { handle: asPaneHandle(result.stdout.trim().split('\n')[0] || ''), result };
  }

  async closePane(server: ServerConfig, handle: PaneHandle) { return this.killPane(server, handle as string); }
  async captureScreen(server: ServerConfig, handle: PaneHandle, start?: number, end?: number) { return this.capturePane(server, handle as string, start, end); }
  async sendKeysToHandle(server: ServerConfig, handle: PaneHandle, keys: string[]) { return this.sendKeys(server, handle as string, keys); }
  async sendTextToHandle(server: ServerConfig, handle: PaneHandle, text: string) { return this.sendLiteralText(server, handle as string, text); }
  async panePidByHandle(server: ServerConfig, handle: PaneHandle) { return this.getPanePid(server, handle as string); }
  async paneCommandByHandle(server: ServerConfig, handle: PaneHandle) { return this.getPaneCurrentCommand(server, handle as string); }
  async startOutputStream(server: ServerConfig, handle: PaneHandle, outputPath: string) { return this.startPipePane(server, handle as string, outputPath); }
  async stopOutputStream(server: ServerConfig, handle: PaneHandle) { return this.stopPipePane(server, handle as string); }
  async zoomPaneByHandle(server: ServerConfig, handle: PaneHandle) { return this.zoomPane(server, handle as string); }
  async unzoomPaneByHandle(server: ServerConfig, handle: PaneHandle) { return this.unzoomPane(server, handle as string); }
  async isPaneInModeByHandle(server: ServerConfig, handle: PaneHandle) { return this.isPaneInMode(server, handle as string); }
  async cancelPaneModeByHandle(server: ServerConfig, handle: PaneHandle) { return this.cancelPaneMode(server, handle as string); }
  async setPaneTitle(server: ServerConfig, handle: PaneHandle, title: string) { return this.renamePane(server, handle as string, title); }
  async windowActivity(server: ServerConfig, ref: MuxRef) { return this.getWindowActivity(server, tmuxTargetFromMuxRef(ref)); }

  async captureLayout(server: ServerConfig, ref: MuxRef) {
    const target = tmuxTargetFromMuxRef(ref);
    const layoutResult = await this.runTmuxCommand(server, ['display-message', '-t', target, '-p', '#{window_layout}']);
    const paneResult = await this.runTmuxCommand(server, ['list-panes', '-t', target, '-F', '#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}']);
    const entries = paneResult.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [indexStr, command, path, title] = line.split('\t');
      return { index: parseInt(indexStr, 10), command: command || null, path: path || null, title: title || null };
    });
    entries.sort((a, b) => a.index - b.index);
    return {
      layout: layoutResult.stdout.trim(),
      panes: entries.map((e, i) => ({ index: e.index, ordinal: (i + 1) as PaneOrdinal, command: e.command, path: e.path, title: e.title })),
    };
  }

  async applyLayout(server: ServerConfig, ref: MuxRef, layout: string) {
    return this.runTmuxCommand(server, ['select-layout', '-t', tmuxTargetFromMuxRef(ref), layout]);
  }

  async measurePanePids(server: ServerConfig): Promise<Array<{ ref: MuxRef; pid: number }>> {
    let result: ExecResult;
    try { result = await this.runTmuxCommand(server, ['list-panes', '-a', '-F', '#{session_name}\t#{window_name}\t#{pane_pid}\t#{?session_grouped,#{session_group},#{session_name}}']); }
    catch { return []; }
    if (result.code !== 0) return [];
    const seen = new Map<string, { ref: MuxRef; pid: number }>();
    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue;
      const [_sessionName, windowName, pidStr, resolvedSession] = line.split('\t');
      const pid = parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || resolvedSession.startsWith(LINKED_SESSION_PREFIX)) continue;
      const key = `${pid}`;
      if (!seen.has(key)) seen.set(key, { ref: { kind: 'tmux', workspace: resolvedSession, window: windowName }, pid });
    }
    return Array.from(seen.values());
  }

  async openTerminal(server: ServerConfig, ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream> {
    return this.transportFactory.getTransport(server).openTerminal(ref, ordinal, cols, rows);
  }

  async installChangeHooks(server: ServerConfig): Promise<void> {
    const transport = this.transportFactory.getTransport(server);
    const port = new URL(this.localUrl).port;
    const base = `http://localhost:${port}/api/hooks/tmux`;
    const token = this.webhookToken ?? this.uiToken;
    for (const event of HOOK_EVENTS) {
      const hookValue = buildHookValue(base, event, { token, serverName: server.name });
      await transport.execMux(buildHookSetArgs(event, hookValue));
    }
  }

  async uninstallChangeHooks(server: ServerConfig): Promise<void> {
    const transport = this.transportFactory.getTransport(server);
    for (const event of HOOK_EVENTS) {
      await transport.execMux(buildHookUnsetArgs(event));
    }
  }
}
