import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import { ACTIVITY_THRESHOLD_SEC } from '../tasks/execution/WorkerWaiter';
import type { AgentWindow, IWindowRepository } from '../windows/Window';
import { isAgentWindow } from '../windows/Window';
import type { TmuxClient, TmuxSession, TmuxWindow } from '../tmux/TmuxClient';
import { windowSpecMatches } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { AgentActivityStopReason } from '../notifications/NotificationEvent';
import { classifyPaneState, CLASSIFIABLE_AGENT_TYPES, type PaneAgentState } from './paneStateClassifier';
import { stripPaneSuffix } from '../windows/paneTarget';
import { resolveInterval } from '../../shared/testIntervals';

/** Split a stored `session:windowSpec[.pane]` target into its session and window parts. */
export function parseWindowTarget(target: string): { sessionName: string; windowSpec: string } {
  if (target.startsWith('%')) {
    return { sessionName: '', windowSpec: '' };
  }
  const colonIdx = target.indexOf(':');
  const sessionName = colonIdx === -1 ? target : target.slice(0, colonIdx);
  const windowSpec = colonIdx === -1 ? '' : target.slice(colonIdx + 1);
  return { sessionName, windowSpec };
}

/** Match a single (non-composite) spec against a window's index or name — see windowSpecMatches. */
function specMatchesWindow(spec: string, windowIndex: number, windowName: string): boolean {
  if (!spec) return false;
  return /^\d+$/.test(spec) ? spec === String(windowIndex) : spec === windowName;
}

/**
 * Extract the pane index named by a `windowSpec[.pane]` target, if any. Mirrors
 * windowSpecMatches's own precedence: the raw spec is tried first (a window
 * literally named `foo.1` has no pane suffix), and only if that fails to match
 * do we treat a trailing `.digits` as a pane index.
 */
function extractPaneIndex(windowSpec: string, windowIndex: number, windowName: string): number | null {
  if (specMatchesWindow(windowSpec, windowIndex, windowName)) return null;
  const m = windowSpec.match(/\.(\d+)$/);
  if (!m) return null;
  const stripped = windowSpec.slice(0, -m[0].length);
  return specMatchesWindow(stripped, windowIndex, windowName) ? parseInt(m[1], 10) : null;
}

/**
 * Confirm the window still exists in a live `listSessions` snapshot (matched
 * via windowSpecMatches: numeric spec → index only, otherwise name; raw and
 * pane-stripped spec forms both tried). This replaces trusting
 * `display-message`'s per-target activity answer, which silently falls back to
 * the session's active window when the requested window is gone — the exact
 * bug that made stale `windows` rows look "running".
 *
 * Returns the window itself (not just its activity) so callers can also
 * inspect its panes' foreground commands.
 */
export function findLiveWindow(sessions: TmuxSession[], target: string): TmuxWindow | null {
  const { sessionName, windowSpec } = parseWindowTarget(target);
  const session = sessions.find((s) => s.name === sessionName);
  if (!session) return null;
  return session.windows.find((w) => windowSpecMatches(windowSpec, w.index, w.name)) ?? null;
}

/**
 * Shells whose foreground presence must NOT count as "agent running": merely
 * focusing a pane and typing (e.g. a stray keystroke, or the shell prompt
 * itself) still bumps tmux's `window_activity`, so activity freshness alone
 * over-detects. Requiring the foreground command to be a real (non-shell)
 * program filters out that false-positive case.
 */
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);

/**
 * Narrow a window's panes to the ones relevant to a target: the pane named by
 * the target's `.<index>` suffix when it still exists, otherwise every pane
 * (conservative: err toward considering the window rather than losing a
 * legitimate agent window whose pane suffix no longer resolves).
 */
function selectRelevantPanes(panes: TmuxWindow['panes'], paneIndex: number | null): TmuxWindow['panes'] {
  const targeted = paneIndex === null ? panes : panes.filter((p) => p.index === paneIndex);
  return targeted.length > 0 ? targeted : panes;
}

/**
 * True when at least one relevant pane's foreground command is not a bare
 * shell. `paneIndex` narrows to the specific pane named by the target's
 * `.<index>` suffix; when it names a pane that no longer exists, or the
 * target has no pane suffix, all panes are considered (conservative: err
 * toward "still running" rather than losing a legitimate agent window).
 */
function hasNonShellForegroundPane(panes: TmuxWindow['panes'], paneIndex: number | null): boolean {
  return selectRelevantPanes(panes, paneIndex).some((p) => !SHELL_COMMANDS.has(p.command));
}

/**
 * OSC title of the pane the pane-state classifier (Tier 2) should read: the
 * active pane among the ones `selectRelevantPanes` narrows to, falling back
 * to the first relevant pane if none is marked active. Returns null (never
 * an empty string) when there is no relevant pane at all, so the classifier
 * can tell "no data" apart from "title observed empty".
 */
function getRelevantPaneTitle(panes: TmuxWindow['panes'], paneIndex: number | null): string | null {
  const relevant = selectRelevantPanes(panes, paneIndex);
  const pane = relevant.find((p) => p.active) ?? relevant[0];
  return pane ? pane.title : null;
}

function getRelevantPaneName(panes: TmuxWindow['panes'], paneIndex: number | null): string | undefined {
  const relevant = selectRelevantPanes(panes, paneIndex);
  const pane = relevant.find((p) => p.active) ?? relevant[0];
  if (!pane) return undefined;
  return pane.title && pane.title !== pane.command ? pane.title : pane.command;
}

export interface AgentActivityEntry {
  serverName: string;
  target: string;
  running: true;
  source: 'operation' | 'manual' | 'supervised';
  /**
   * True only while this key is a registered execution run of a Unit (a task
   * AZITO is driving). `taskId` cannot answer this: a `windows` row keeps its
   * `task_id` long after the run ends, so a manually launched agent in such a
   * window carries a taskId while being nothing to do with a running task.
   * Consumers that want "was this agent launched by hand?" must read this flag,
   * not `taskId == null`.
   */
  operation: boolean;
  taskId?: number;
  label?: string;
  projectId?: number;
  /**
   * Set when a title-aware source resolved the pane's state: either the
   * pane-state classifier (Tier 2, see paneStateClassifier.ts) or a
   * supervisor whose own TitleStateTracker reported a status alongside its
   * activity signal (Tier 0). `'blocked'` means the entry is still a running
   * entry (`running: true`) but the agent is stalled on a permission/confirm
   * prompt rather than actively working — distinct from a plain "working"
   * entry, whose `status` may be undefined for sources that cannot
   * distinguish blocked from working (hooks, the Tier 3 heuristic, and
   * pre-title-tracker supervisors).
   */
  status?: 'working' | 'blocked';
  paneName?: string;
}

/**
 * Event-driven activity signal delivered by a Claude Code hook
 * (`harness/hooks/azito-activity.sh`) via `POST /api/webhooks/agent-activity`.
 * Identifies the tmux pane the hook fired from — resolved against the
 * `windows` table (not a live tmux query) since the hook already ran inside
 * that exact pane.
 */
export interface AgentHookSignal {
  serverName: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  event: 'start' | 'stop';
}

interface HookState {
  status: 'running' | 'idle';
  at: number;
}

interface SupervisorState {
  status: 'running' | 'idle';
  at: number;
  serverName: string;
  target: string;
  taskId: number | null;
  label: string | null;
  /**
   * Title-derived agent status reported by the supervisor's own
   * TitleStateTracker ('blocked' = stalled on a permission prompt).
   * Undefined for supervisors predating the title tracker, or while their
   * byte-heuristic fallback is in use — treated as plain working.
   */
  agentStatus?: 'working' | 'blocked';
}

const POLL_INTERVAL_MS = resolveInterval(5_000, 1_500);

/**
 * Number of activity advances (not necessarily consecutive) required, within
 * the trailing START_WINDOW_TICKS window, before a manual candidate is
 * confirmed as running. A single advance is indistinguishable from a tmux
 * focus-triggered TUI redraw (focusing a pane and leaving it bumps
 * `window_activity` exactly once) — that must NOT count as "running". Two
 * advances within the window (whether back-to-back or spaced out, e.g. a
 * burst-style agent that only writes output every ~15s) are enough to
 * distinguish a genuinely working agent from a one-off redraw.
 */
const START_CONFIRM_ADVANCES = 2;

/**
 * Width, in ticks, of the sliding window used to collect activity advances
 * (~20s at POLL_INTERVAL_MS=5s). Advances older than this window are pruned
 * before checking START_CONFIRM_ADVANCES, so a lone advance that is never
 * followed up (the focus-redraw case) ages out and is forgotten, while an
 * agent whose output is merely intermittent (e.g. writes at 0s and 15s) still
 * accumulates enough advances inside the window to be confirmed — the
 * previous "N consecutive ticks" rule required every tick to advance and
 * missed exactly this intermittent-output case.
 */
const START_WINDOW_TICKS = 4;

interface ActivityHistory {
  lastActivity: number;
  advanceTicks: number[];
}

/**
 * Tier 4 source: process/transcript-based liveness for windows that no
 * event-driven source covers (a hand-launched `claude`/`codex` pane with
 * neither a supervisor nor the Claude Code hooks wired). Structurally
 * satisfied by `WindowActivityStatusService.list()`; declared here as a
 * minimal port so this module does not depend on the windows/transcripts
 * implementation.
 */
export interface ProcessActivityProbe {
  list(): Promise<ProcessActivityProbeEntry[]>;
}

/**
 * One window's Tier 4 answer. Besides the coarse status it carries the *ending*
 * the probe observed in the session transcript — `completedAt` (the agent's
 * final response, a genuine completion) and `interruptedAt` (a stop/interrupt
 * marker). Those are what let the monitor label a `running: false` transition
 * with a reason instead of guessing, and let it synthesize a `completed`
 * transition for a turn so short that no tick ever saw it working (P3).
 */
export interface ProcessActivityProbeEntry {
  serverName: string;
  target: string;
  status: 'working' | 'idle' | 'offline';
  completedAt: number | null;
  interruptedAt: number | null;
  taskId?: number;
  projectId?: number;
  label?: string;
}

/**
 * Why a key stopped being reported as running (re-exported from the
 * notifications module, where the WS payload type lives, so consumers of the
 * monitor do not have to reach across modules for it):
 * - 'completed'    supervisor active→idle, hook Stop, Tier 2 working→idle, or
 *                  Tier 4 observing a fresh `terminal_final`.
 * - 'interrupted'  Tier 4 observed a fresh interrupt marker (stop button/Esc).
 * - 'deleted'      the tmux window (or its `windows` row) is gone.
 * - 'offline'      the agent process disappeared / the server is unreachable.
 * - 'unknown'      no source could tell (e.g. the Tier 3 activity heuristic
 *                  simply going stale).
 */
export type { AgentActivityStopReason };

/**
 * How stale the Tier 4 snapshot may get before a refresh is kicked off. The
 * probe walks `ps`/tmux per window, so it must not run on every 5s tick; it is
 * refreshed in the background (never awaited inside collect()) and read from
 * cache, which bounds a Tier 4 state change's visible latency to roughly this
 * interval plus one poll interval — well under the 60s poll × 60s cache phase
 * problem of the removed client-side polling path.
 */
const PROCESS_PROBE_REFRESH_MS = resolveInterval(15_000, 3_000);

/**
 * Maximum age of the last *successful* probe snapshot that Tier 4 will still
 * act on. A failing probe keeps its previous snapshot (a failure is "no fresh
 * answer", not "nothing is running"), but that snapshot must not keep a
 * stopped agent lit forever: past this age Tier 4 goes silent and the key
 * falls through to the Tier 3 heuristic, which reads live tmux state.
 *
 * NOT shortened by AZITO_E2E_FAST_INTERVALS: this is a judgment threshold
 * ("how old an answer may be before it stops counting as evidence"), not an
 * observation period, so shortening it would make E2E exercise different
 * semantics from production.
 */
const PROCESS_PROBE_MAX_AGE_MS = 60_000;

/**
 * How recent a probe-observed completion must be for the monitor to synthesize
 * a `completed` transition for a key that was never seen running (the "turn too
 * short for any tick to catch it" case). Bounded to a couple of production probe
 * cycles so that a completion which happened long before the hub started — or
 * before this window was ever polled — does not manufacture a stale "finished" row.
 *
 * Deliberately a standalone constant rather than `2 * PROCESS_PROBE_REFRESH_MS`:
 * it is a judgment threshold, so it must keep its production value even when
 * AZITO_E2E_FAST_INTERVALS shortens the refresh interval (see above).
 */
const COMPLETION_SYNTHESIS_MAX_AGE_MS = 30_000;

/**
 * How long after an execution run leaves `getRunning()` a synthesized
 * completion for its key is still attributed to that run. Only needs to cover
 * the gap between the run ending and the probe cycle that observes its final
 * transcript entry, so it is kept just above one probe max-age.
 */
const OPERATION_ATTRIBUTION_TTL_MS = 90_000;

function windowKey(serverName: string, target: string): string {
  return `${serverName}::${stripPaneSuffix(target)}`;
}

interface CollectResult {
  next: Map<string, AgentActivityEntry>;
  /** Why each key that could have been running is not — see collect(). */
  reasons: Map<string, AgentActivityStopReason>;
  /** `windows` rows that vanished on this tick (one-shot; see emitTransitions). */
  deletedKeys: Set<string>;
}

/** Inverse of windowKey() — server names never contain `::`, targets may not either. */
function splitWindowKey(key: string): [serverName: string, target: string] {
  const idx = key.indexOf('::');
  return [key.slice(0, idx), key.slice(idx + 2)];
}

/**
 * Polls agent liveness every 5 seconds and publishes `agent:activity`
 * NotificationBus events on state transitions only. Two candidate sources:
 * - Operation runs (ExecuteTaskUseCase.getRunning()) — registered = running,
 *   no heuristic needed; these take priority over manual detection.
 * - Manually launched agent windows (windows table, windowType 'agent') —
 *   confirmed to still exist in a live `listSessions` snapshot (one call per
 *   server per tick), then considered running when that window's activity is
 *   fresher than ACTIVITY_THRESHOLD_SEC (shared with WorkerWaiter) AND its
 *   foreground pane command is not a bare shell (see hasNonShellForegroundPane
 *   — a focused shell echoing keystrokes also bumps window_activity). Stale
 *   `windows` rows pointing at long-gone windows are simply not found and
 *   treated as idle — see findLiveWindow.
 *
 * A third, highest-priority source (Tier 0) sits above both — and is also a
 * candidate source in its own right, not just a refinement of the other two:
 * `tui-supervisor` processes report `active`/`idle`/exit directly via
 * `SupervisorRegistry` ('activity'/'child_exit'/'disconnected' events,
 * bridged in by recordSupervisorSignal()). A live Tier 0 signal for a key is
 * authoritative: on a manual (windows-table) key it skips the hook/heuristic
 * logic entirely, on an operation-covered key it refines the coarse
 * "registered = running" into the supervisor's actual active/idle state
 * (source 'supervised'), and — critically — a key with NEITHER a `windows`
 * row NOR an operation run (e.g. a manually launched `azs claude` pane with
 * no prior `windows` entry) still becomes a full snapshot entry purely from
 * the supervisor connection itself; see collect() step 3 /
 * collectPureSupervisedEntries(). Because "a supervisor is connected" is
 * itself the ground truth, a supervisorStates entry is never pruned by
 * candidate/operation membership — only an explicit 'exited' signal removes
 * it (see recordSupervisorSignal()).
 *
 * Below all of them sits Tier 4 (`ProcessActivityProbe`, backed by
 * WindowActivityStatusService): process-existence + session-transcript
 * evidence for windows no event-driven source covers — a hand-launched agent
 * pane with neither a supervisor nor the Claude Code hooks wired. It is
 * consulted from inside collect()'s per-key ladder, after Tier 0/1/2 have all
 * declined to decide, which is what structurally guarantees that a Tier 4
 * 'working' can never re-light a key a higher tier just called idle. Its
 * snapshot is refreshed in the background (PROCESS_PROBE_REFRESH_MS) rather
 * than awaited on the tick path.
 */
export class AgentActivityMonitor {
  private state = new Map<string, AgentActivityEntry>();
  // Debounce history for manual candidates not yet confirmed running — see
  // START_CONFIRM_ADVANCES / START_WINDOW_TICKS. Cleared per-key once
  // idle/gone; while confirmed as manual the continuation shortcut skips it
  // (it goes stale but harmless, and any restart resets it to a fresh window
  // via the idle path).
  private activityHistory = new Map<string, ActivityHistory>();
  // Tier 1 event-driven state, keyed the same as activityHistory/state. Set by
  // recordHookSignal() from Claude Code UserPromptSubmit/Stop hooks; consumed
  // by collect() to bypass the Tier 2 sliding-window heuristic entirely for
  // keys with a live hook signal — see the class doc comment.
  private hookStates = new Map<string, HookState>();
  // Tier 0 event-driven state, set by recordSupervisorSignal() from
  // SupervisorRegistry 'activity'/'child_exit'/'disconnected' events (a
  // `tui-supervisor` process wrapping the child directly). Deliberately kept
  // in its own Map rather than sharing hookStates: a supervisor connection
  // has an explicit, unambiguous lifecycle (child_exit / WS disconnect both
  // fire deterministically), unlike the hook path's crash-failsafe dance of
  // inferring exit from a foreground-command fallback to a bare shell — so
  // Tier 0 needs no such fallback and bypasses Tier 1/2 entirely for its keys.
  private supervisorStates = new Map<string, SupervisorState>();
  // Tier 4 cache: last snapshot of the process/transcript probe, keyed the same
  // as every other tier. Refreshed in the background (see refreshProcessProbe)
  // so collect() never awaits the probe's ps/tmux walk.
  private processStates = new Map<string, ProcessActivityProbeEntry>();
  // Completions already announced, keyed the same way: key → the `completedAt`
  // whose `completed` transition was emitted. Purely a dedupe memo (the probe
  // keeps reporting the same `completedAt` until the session moves on), not a
  // state machine.
  private emittedCompletions = new Map<string, number>();
  // Windows-table candidate keys seen on the previous tick, used to tell
  // "this key stopped running" apart from "this window no longer exists"
  // (reason 'deleted') — including for keys that were already idle, whose
  // disappearance emits no transition of its own.
  private previousCandidateKeys = new Set<string>();
  // Candidate keys whose tmux window was found alive on the previous tick. A
  // key leaving this set while its `windows` row survives is a window
  // disappearance, announced once (see collect()'s `window === null` branch).
  private previousLiveKeys = new Set<string>();
  // Recently-registered execution runs: key → the run's taskId, kept briefly
  // after the run ends so a completion synthesized from the probe (a turn that
  // started and finished between ticks) is still attributed to the operation
  // instead of being announced as a hand-launched agent — which would make the
  // frontend raise an "agent finished" notification on top of the task's own.
  private recentOperationMeta = new Map<string, { taskId: number; at: number }>();
  // Last refresh *attempt* (rate-limits retries) and last *success* (the only
  // one Tier 4 freshness is judged on — see PROCESS_PROBE_MAX_AGE_MS).
  private processProbeAt = 0;
  private processProbeOkAt = 0;
  private processProbeInflight = false;
  // Keys whose Tier 4 answer is disarmed until the probe observes them
  // non-working at least once. Armed when a key stops being an operation run:
  // the cached snapshot still shows that run's own `working`, and letting it
  // through would silently convert the operation entry into a manual one —
  // a source-only change emitTransitions() does not emit, swallowing the
  // run's `running: false` transition entirely.
  private processDisarmedKeys = new Set<string>();
  private tickCounter = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private executeTaskUseCase: ExecuteTaskUseCase,
    private windowRepo: IWindowRepository,
    private tmux: TmuxClient,
    private serverRepo: IServerRepository,
    private notificationBus: NotificationBus,
    private processProbe?: ProcessActivityProbe,
    private onActivityDetected?: (serverName: string, target: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    // Prime state immediately so GET /api/agent-activity is not empty for the first interval.
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): AgentActivityEntry[] {
    return [...this.state.values()];
  }

  /**
   * Record a Tier 1 hook signal against every manual agent window it
   * identifies (normally exactly one), then tick immediately so the UI
   * reflects the transition without waiting for the next poll interval.
   * Matching is against the `windows` table only — a signal naming no known
   * window (e.g. a stale/removed window, or a non-agent pane) is silently
   * dropped.
   */
  recordHookSignal(signal: AgentHookSignal): void {
    const status: HookState['status'] = signal.event === 'start' ? 'running' : 'idle';
    const at = Date.now();

    for (const w of this.windowRepo.findAll()) {
      if (!isAgentWindow(w)) continue;
      if (w.serverName !== signal.serverName) continue;

      const { sessionName, windowSpec } = parseWindowTarget(w.tmuxTarget);
      if (sessionName !== signal.sessionName) continue;
      if (!windowSpecMatches(windowSpec, signal.windowIndex, signal.windowName)) continue;

      // If the target pins a specific pane (`.N` suffix beyond the window
      // spec itself), the signal's pane must match it too — otherwise a
      // hook firing from an unrelated pane in the same window would
      // falsely flip this window's tracked pane.
      const paneIndex = extractPaneIndex(windowSpec, signal.windowIndex, signal.windowName);
      if (paneIndex !== null && paneIndex !== signal.paneIndex) continue;

      this.hookStates.set(windowKey(w.serverName, w.tmuxTarget), { status, at });
    }

    void this.tick();
  }

  /**
   * Record a Tier 0 supervisor signal for a `${serverName}::${stripPaneSuffix(target)}` key,
   * then tick immediately so the UI reflects the transition without waiting
   * for the next poll interval. Unlike recordHookSignal, this is not matched
   * against the `windows` table here — the caller (SupervisorRegistry event)
   * already identifies the exact server/target pair, and collect() consults
   * this state both for candidates it enumerated from `windowRepo.findAll()`
   * (refining their coarse status) and, when no `windows` row or operation
   * run covers the key at all, as the sole source for a "pure supervised"
   * entry — see collect(). `taskId`/`label` (this connection's own metadata,
   * not looked up from `windows`) are what that pure-supervised entry uses;
   * AgentActivityMonitor deliberately does not import SupervisorRegistry, so
   * the caller (buildServer.ts) passes them through from the registry event.
   *
   * `'exited'` (from a `child_exit` or registry `disconnected` event) simply
   * removes the key, releasing it back to Tier 1/2 — a disconnect is not
   * itself proof the agent stopped (e.g. a supervisor process restart), so
   * falling back to the heuristic rather than asserting idle is the
   * conservative choice. This is also the *only* way a supervisorStates entry
   * is ever removed — see collect(), which no longer prunes it by candidate
   * membership: a supervisor connection with no `windows` row is exactly the
   * case this signal exists to surface, so candidate absence must not erase it.
   */
  recordSupervisorSignal(
    serverName: string,
    target: string,
    state: 'active' | 'idle' | 'exited',
    taskId: number | null = null,
    label: string | null = null,
    agentStatus?: 'working' | 'blocked',
  ): void {
    const key = windowKey(serverName, target);
    if (state === 'exited') {
      this.supervisorStates.delete(key);
    } else {
      this.supervisorStates.set(key, {
        status: state === 'active' ? 'running' : 'idle',
        at: Date.now(),
        serverName,
        target: stripPaneSuffix(target),
        taskId,
        label,
        agentStatus: state === 'active' ? agentStatus : undefined,
      });
    }
    void this.tick();
  }

  async tick(): Promise<void> {
    // Guard against overlapping ticks when tmux calls run longer than the interval.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { next, reasons, deletedKeys } = await this.collect();
      this.emitTransitions(next, reasons, deletedKeys);
      this.state = next;
    } catch (err) {
      // Callers fire-and-forget tick(); swallow here so a failing tick can
      // never surface as an unhandled rejection and crash the process.
      console.error('[agent-activity] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Refresh the Tier 4 cache when the last *attempt* is older than
   * PROCESS_PROBE_REFRESH_MS (the attempt clock advances on failure too, so a
   * persistently failing probe is retried at the same rate rather than on
   * every tick; its staleness is handled by PROCESS_PROBE_MAX_AGE_MS, which is
   * measured from the last success).
   * Deliberately not awaited by collect(): the probe's ps/tmux walk is far too
   * slow to sit on the 5s tick path, and Tier 4 is the lowest-priority source,
   * so serving a ≤15s-old answer while the next one is computed is exactly the
   * intended accuracy/cost tradeoff.
   */
  private kickProcessProbeRefresh(): void {
    if (!this.processProbe) return;
    if (this.processProbeInflight) return;
    if (Date.now() - this.processProbeAt < PROCESS_PROBE_REFRESH_MS) return;
    this.processProbeInflight = true;
    void this.processProbe.list()
      .then((entries) => {
        const map = new Map<string, ProcessActivityProbeEntry>();
        for (const e of entries) map.set(windowKey(e.serverName, e.target), e);
        this.processStates = map;
        this.processProbeOkAt = Date.now();
        // This snapshot was taken after the disarm, so a non-working answer in
        // it is proof the ex-operation key really stopped — re-arm Tier 4.
        for (const key of [...this.processDisarmedKeys]) {
          if (map.get(key)?.status !== 'working') this.processDisarmedKeys.delete(key);
        }
        // Forget completion memos for keys the probe no longer covers, so the
        // map cannot grow without bound.
        for (const key of [...this.emittedCompletions.keys()]) {
          if (!map.has(key)) this.emittedCompletions.delete(key);
        }
      })
      .catch((err) => {
        // Keep the previous snapshot rather than blanking it: a failed probe is
        // "no fresh answer", not "nothing is running".
        console.error('[agent-activity] process probe failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.processProbeAt = Date.now();
        this.processProbeInflight = false;
      });
  }

  /**
   * Whether Tier 4 may speak for this key: the last successful probe must be
   * recent enough (a stuck/failing probe must not keep a stopped agent lit),
   * and the key must not be disarmed by a just-ended operation run.
   */
  private isProcessProbeUsableFor(key: string): boolean {
    if (this.processProbeOkAt === 0) return false;
    if (Date.now() - this.processProbeOkAt > PROCESS_PROBE_MAX_AGE_MS) return false;
    return !this.processDisarmedKeys.has(key);
  }

  /**
   * Build this tick's running set, together with the reason each key that could
   * have been running is not. Reasons are recorded at the exact ladder rung that
   * decided "not running" — that is the only place the material for the decision
   * exists — and are consumed by emitTransitions(), which reads them only for
   * keys that actually stopped (a reason recorded for a key some lower rung then
   * lights is simply never read).
   */
  private async collect(): Promise<CollectResult> {
    this.tickCounter++;
    this.kickProcessProbeRefresh();
    const next = new Map<string, AgentActivityEntry>();
    const reasons = new Map<string, AgentActivityStopReason>();
    const deletedKeys = new Set<string>();
    // Candidate keys whose tmux window was actually found this tick; becomes
    // previousLiveKeys at the end, so a window disappearing is detectable as an
    // edge rather than as a level (see the `window === null` branch).
    const liveKeys = new Set<string>();

    // 1. Operation runs: being registered means running — unless a Tier 0
    // supervisor signal exists for the key, in which case the supervisor's
    // finer-grained state overrides the coarse "registered = running"
    // assumption (source becomes 'supervised'; taskId stays operation-derived).
    // A supervised worker that reported 'idle' (e.g. sitting in waiting_input
    // between turns) is correctly shown idle even while its operation run is
    // still registered. Operation keys are excluded from `candidates` below,
    // so this is the only place Tier 0 can apply to them.
    const running = this.executeTaskUseCase.getRunning();
    const operationKeys = new Set<string>();
    for (const executions of Object.values(running)) {
      for (const e of executions) {
        const key = windowKey(e.serverName, e.target);
        operationKeys.add(key);
        this.recentOperationMeta.set(key, { taskId: e.taskId, at: Date.now() });
        const supervisor = this.supervisorStates.get(key);
        if (supervisor?.status === 'idle') {
          // supervised-idle → not running. An explicit active→idle report from
          // the supervisor is the strongest completion evidence there is.
          reasons.set(key, 'completed');
          continue;
        }
        next.set(key, {
          serverName: e.serverName,
          target: stripPaneSuffix(e.target),
          running: true,
          source: supervisor ? 'supervised' : 'operation',
          operation: true,
          taskId: e.taskId,
          status: supervisor?.agentStatus,
        });
      }
    }

    // Keys that were operation runs on the previous tick and are not anymore:
    // disarm Tier 4 for them until the probe re-observes them (see
    // processDisarmedKeys). Without this, a cached `working` from the run that
    // just ended re-lights the key as a manual entry and the operation's
    // `running: false` transition is never emitted.
    for (const [key, entry] of this.state) {
      if (entry.operation && !operationKeys.has(key)) this.processDisarmedKeys.add(key);
    }

    // 2. Manual agent windows not already covered by an operation run.
    // Filtered on operationKeys (not `next`): a supervised-idle operation key
    // is absent from `next` but must still not fall through to the manual
    // hook/heuristic path — its state is owned by the operation+Tier 0 logic
    // above.
    const allAgentWindows = this.windowRepo.findAll().filter(isAgentWindow);

    // Dedup: same server + same window (pane suffix stripped) → keep taskId row.
    // Multiple DB rows can point at the same tmux window (project-owned vs task-owned).
    const windowMap = new Map<string, AgentWindow>();
    for (const w of allAgentWindows) {
      const wk = windowKey(w.serverName, w.tmuxTarget);
      const existing = windowMap.get(wk);
      if (!existing || (w.taskId != null && existing.taskId == null)) {
        windowMap.set(wk, w);
      }
    }
    const candidates = [...windowMap.values()]
      .filter((w) => !operationKeys.has(windowKey(w.serverName, w.tmuxTarget)));

    // Drop debounce history and hook state for keys no longer among this
    // tick's candidates (window removed/retyped) so the Maps cannot grow
    // without bound.
    const candidateKeys = new Set(candidates.map((w) => windowKey(w.serverName, w.tmuxTarget)));
    // Keys whose `windows` row vanished since the previous tick (window deleted
    // in the UI, or its tmux window destroyed and the row cleaned up). These
    // never reach the ladder below, so their reason has to be recorded here —
    // and it is recorded even for keys that were already idle, because
    // emitTransitions() announces those too (a finished row for a deleted
    // window must disappear immediately, and that is the only signal that can
    // carry it).
    for (const key of this.previousCandidateKeys) {
      if (candidateKeys.has(key) || operationKeys.has(key)) continue;
      reasons.set(key, 'deleted');
      deletedKeys.add(key);
    }
    this.previousCandidateKeys = candidateKeys;
    for (const key of this.activityHistory.keys()) {
      if (!candidateKeys.has(key)) this.activityHistory.delete(key);
    }
    for (const key of this.hookStates.keys()) {
      if (!candidateKeys.has(key)) this.hookStates.delete(key);
    }
    for (const key of this.processDisarmedKeys) {
      if (!candidateKeys.has(key) && !operationKeys.has(key)) this.processDisarmedKeys.delete(key);
    }
    for (const [key, meta] of this.recentOperationMeta) {
      if (Date.now() - meta.at > OPERATION_ATTRIBUTION_TTL_MS) this.recentOperationMeta.delete(key);
    }
    // Supervisor state is deliberately NOT pruned by candidate/operation
    // membership: a live supervisor connection with no `windows` row and no
    // operation run (e.g. a manually launched `azs claude` pane) is exactly
    // the case Tier 0 exists to surface, and losing candidate coverage must
    // not erase it. The only removal path is an explicit 'exited' signal via
    // recordSupervisorSignal — see its doc comment.

    // 3. Pure supervised keys: supervisorStates entries covered by neither an
    // operation run (step 1) nor a windows-table candidate (step 2, whose
    // per-key Tier 0 refine happens inside the loop below) — a supervisor
    // connection is itself sufficient proof an agent is present, so this is
    // the only place such a key becomes an entry.
    this.collectPureSupervisedEntries(operationKeys, candidateKeys, next);

    if (candidates.length === 0) {
      this.previousLiveKeys = liveKeys;
      return { next, reasons, deletedKeys };
    }

    // Resolve each server once per tick, not once per candidate window.
    // Also include servers for operation-run entries (needed for post-check above).
    const servers = new Map<string, ServerConfig | null>();
    for (const entry of next.values()) {
      if (!servers.has(entry.serverName)) {
        servers.set(entry.serverName, this.serverRepo.findByName(entry.serverName));
      }
    }
    for (const w of candidates) {
      if (!servers.has(w.serverName)) {
        servers.set(w.serverName, this.serverRepo.findByName(w.serverName));
      }
    }

    // One listSessions call per server (not one per candidate/operation window),
    // queried in parallel so one slow/offline server cannot stretch the tick past
    // the poll interval.
    const sessionsByServer = new Map<string, TmuxSession[]>();
    await Promise.all([...servers.entries()].map(async ([serverName, server]) => {
      if (!server) { sessionsByServer.set(serverName, []); return; }
      try {
        sessionsByServer.set(serverName, await this.tmux.listSessions(server));
      } catch {
        sessionsByServer.set(serverName, []);
      }
    }));

    // Post-check: operation-run entries whose supervisor didn't report blocked.
    // For claude workers, screen-check them now that sessions are available.
    for (const [key, entry] of next) {
      if (!entry.operation || entry.status === 'blocked') continue;
      const w = allAgentWindows.find((aw) => windowKey(aw.serverName, aw.tmuxTarget) === key);
      if (!w || w.workerType !== 'claude') continue;
      const server = servers.get(w.serverName) ?? this.serverRepo.findByName(w.serverName);
      if (!server) continue;
      const sessions = sessionsByServer.get(w.serverName) ?? [];
      const window = findLiveWindow(sessions, w.tmuxTarget);
      if (!window) continue;
      const { windowSpec } = parseWindowTarget(w.tmuxTarget);
      const pi = extractPaneIndex(windowSpec, window.index, window.name);
      const classified = await this.classifyCandidateState(server, w, window, pi, key);
      if (classified === 'blocked') next.set(key, { ...entry, status: 'blocked' });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    for (const w of candidates) {
      const key = windowKey(w.serverName, w.tmuxTarget);

      // Tier 0: an event-driven supervisor signal for this key is
      // authoritative and bypasses both the hook (Tier 1) and heuristic
      // (Tier 2) paths entirely — no live-window/foreground check needed,
      // since the supervisor connection's own lifecycle (child_exit / WS
      // disconnect) already tracks whether the child is still alive.
      const supervisor = this.supervisorStates.get(key);
      if (supervisor) {
        if (supervisor.status === 'running') {
          let effectiveStatus = supervisor.agentStatus;
          // Supervisor reported running but not blocked — for claude, check
          // screen content as the supervisor's TitleStateTracker lacks claude
          // blocked detection (codex-only 'Action Required').
          if (w.workerType === 'claude' && effectiveStatus !== 'blocked') {
            const server = servers.get(w.serverName);
            if (server) {
              const sessions = sessionsByServer.get(w.serverName) ?? [];
              const window = findLiveWindow(sessions, w.tmuxTarget);
              if (window) {
                const { windowSpec } = parseWindowTarget(w.tmuxTarget);
                const pi = extractPaneIndex(windowSpec, window.index, window.name);
                const classified = await this.classifyCandidateState(server, w, window, pi, key);
                if (classified === 'blocked') effectiveStatus = 'blocked';
              }
            }
          }
          next.set(key, {
            serverName: w.serverName,
            target: stripPaneSuffix(w.tmuxTarget),
            running: true,
            source: 'supervised',
            operation: false,
            taskId: w.taskId ?? undefined,
            label: w.label ?? undefined,
            projectId: w.projectId ?? undefined,
            status: effectiveStatus,
          });
        } else {
          // The supervisor explicitly reported its child idle — an authoritative
          // completion (Tier 0), not a guess.
          reasons.set(key, 'completed');
        }
        continue;
      }

      const sessions = sessionsByServer.get(w.serverName) ?? [];
      const window = findLiveWindow(sessions, w.tmuxTarget);
      // null (window gone, i.e. a stale DB row) → idle. Reset both the
      // debounce window and any hook state too: a later resumption must
      // re-earn confirmation from scratch, not resume a stale window.
      if (window === null) {
        this.activityHistory.delete(key);
        this.hookStates.delete(key);
        reasons.set(key, 'deleted');
        // The tmux window is gone while its `windows` row survives, so the
        // candidate-inventory diff above cannot see this. Announce it on the
        // live→gone edge only (previousLiveKeys), never on every later tick:
        // a stale row would otherwise re-announce its deletion every 5s.
        if (this.previousLiveKeys.has(key)) deletedKeys.add(key);
        continue;
      }
      liveKeys.add(key);

      // Foreground-command check is shared by both the hook path (crash
      // failsafe below) and the heuristic path: a focused shell pane that
      // merely echoes keystrokes also bumps window_activity, so activity
      // freshness/hook state alone is not enough.
      const { windowSpec } = parseWindowTarget(w.tmuxTarget);
      const paneIndex = extractPaneIndex(windowSpec, window.index, window.name);
      const nonShellForeground = hasNonShellForegroundPane(window.panes, paneIndex);

      const entry: AgentActivityEntry = {
        serverName: w.serverName,
        target: stripPaneSuffix(w.tmuxTarget),
        running: true,
        source: 'manual',
        operation: false,
        taskId: w.taskId ?? undefined,
        label: w.label ?? undefined,
        projectId: w.projectId ?? undefined,
      };

      // Tier 1: an event-driven hook signal for this key overrides the Tier 2
      // heuristic entirely.
      const hook = this.hookStates.get(key);
      if (hook) {
        if (!nonShellForeground) {
          // Foreground fell back to a bare shell — the hooked process
          // (claude) has exited, so drop the hook state regardless of its
          // status:
          // - 'running': crash failsafe — claude died without ever firing
          //   its Stop hook; the key must fall back to idle now rather than
          //   staying "running" forever.
          // - 'idle': dropped deliberately too. Keeping 'idle' pinned would
          //   suppress the heuristic for this key forever, so a different
          //   agent launched later in the same pane (e.g. codex, which fires
          //   no Claude Code hooks) could never be detected. Once the pane
          //   has been a bare shell, the hook's claim over this key is over
          //   and the Tier 2 heuristic path must become available again.
          this.hookStates.delete(key);
          this.activityHistory.delete(key);
          // The hooked process is gone (crash failsafe, or it exited after its
          // Stop hook) — that is a process disappearance, not a completion.
          reasons.set(key, 'offline');
          continue;
        }
        if (hook.status === 'running') {
          // Hook says running, but claude may be showing a permission prompt
          // — check screen content to detect blocked state.
          if (w.workerType === 'claude') {
            const server = servers.get(w.serverName);
            if (server) {
              const classified = await this.classifyCandidateState(server, w, window, paneIndex, key);
              if (classified === 'blocked') {
                next.set(key, { ...entry, status: 'blocked' });
                continue;
              }
            }
          }
          next.set(key, entry);
          continue;
        }
        // status === 'idle' while the hooked process is still in the
        // foreground: the Stop hook fired, so treat the key as idle and skip
        // the heuristic — focus/typing on the idle TUI must not re-light it
        // as "running". This suppression lasts only as long as the process
        // stays in the foreground: a new UserPromptSubmit hook flips it back
        // to running, and the bare-shell branch above releases the key back
        // to the heuristic once the process exits.
        // The Stop hook firing is an explicit completion signal (Tier 1).
        reasons.set(key, 'completed');
        continue;
      }

      // No hook signal for this key — try the pane-state classifier (new
      // Tier 2, see paneStateClassifier.ts) before falling back to the
      // original activity-advance heuristic (now Tier 3, used only when the
      // classifier returns 'unknown' — unsupported agentType, e.g. 'generic',
      // or a title/screen it has no rule for). A bare-shell foreground is
      // skipped here: there is no agent process left to own a title, and the
      // heuristic below already treats it as idle immediately.
      if (nonShellForeground) {
        // Guaranteed non-null here: a null server short-circuits sessionsByServer
        // to [] above, which makes findLiveWindow return null and `continue` before
        // this point is ever reached.
        const server = servers.get(w.serverName)!;
        const classified = await this.classifyCandidateState(server, w, window, paneIndex, key);
        if (classified !== 'unknown') {
          // The classifier resolved decisively; the activity-advance debounce
          // is Tier 3's own concept and must not carry over once Tier 2 is
          // able to speak for this key again (e.g. a later tick reverting to
          // 'unknown' must re-earn the debounce from scratch).
          this.activityHistory.delete(key);
          if (classified === 'idle') {
            // Tier 2 read the agent's own UI (title/screen) and saw it back at
            // rest — for a key it previously called working, that is a
            // completion.
            reasons.set(key, 'completed');
            continue;
          }
          next.set(key, { ...entry, status: classified });
          continue;
        }
      }

      // Tier 4: process/transcript evidence for keys no higher tier could
      // speak for. Reaching this point already means Tier 0 (no supervisor
      // state), Tier 1 (no hook state) and Tier 2 (classifier 'unknown', or
      // skipped on a bare-shell foreground) all declined to decide, so a
      // Tier 4 'working' can never overwrite a higher tier's idle — every
      // higher-tier verdict `continue`s or `set`s before this line.
      //
      // Only 'working' is a verdict. The probe's 'idle'/'offline' answers
      // conflate genuine inactivity with "could not tell" (no session linked
      // to the window, unknown agent type, non-local server — see
      // WindowSessionResolver.getActivityStatus), so treating them as a
      // verdict would silence the Tier 3 heuristic for every window whose
      // session was never linked. Tier 4 is therefore purely additive over
      // Tier 3: it can light a window Tier 3 would miss, never darken one
      // Tier 3 would light.
      if (this.isProcessProbeUsableFor(key)) {
        const probe = this.processStates.get(key);
        if (probe?.status === 'working') {
          this.activityHistory.delete(key);
          next.set(key, entry);
          continue;
        }
        // Not working, but the transcript says how this window's last turn
        // ended. That ending is the reason material Tier 3 (a bare freshness
        // heuristic) cannot produce — record it even though the tiers below may
        // still light the key; reasons are only read for keys that stop.
        if (probe && this.isFreshOutcome(probe.completedAt)) reasons.set(key, 'completed');
        else if (probe && this.isFreshOutcome(probe.interruptedAt)) reasons.set(key, 'interrupted');
      }

      // No tier could decide — fall back to Tier 3, the original
      // activity-advance heuristic.
      // Stale activity → idle. Reset the debounce window too: a later
      // resumption must re-earn START_CONFIRM_ADVANCES from scratch.
      if (nowSec - window.activity >= ACTIVITY_THRESHOLD_SEC) {
        this.activityHistory.delete(key);
        // Tier 3 only knows "no fresh output" — it cannot tell a finished turn
        // from an abandoned one, so it must not claim a completion. A reason
        // already recorded by Tier 4 (which read the transcript) is better
        // material and is kept.
        if (!reasons.has(key)) reasons.set(key, 'unknown');
        continue;
      }
      if (!nonShellForeground) {
        this.activityHistory.delete(key);
        if (!reasons.has(key)) reasons.set(key, 'offline');
        continue;
      }

      // Already confirmed running as manual in the previous tick: continuation
      // is governed purely by the freshness check above, no further debounce.
      // A key previously running as 'operation' must NOT ride this shortcut:
      // when the operation run ends, residual pane output (prompt redraw etc.)
      // would otherwise flip it straight to manual-running undebounced and
      // later produce a spurious "agent stopped" notification on top of the
      // task-done one. It must re-earn START_CONFIRM_ADVANCES like any new key.
      const previous = this.state.get(key);
      if (previous?.source === 'manual') {
        next.set(key, entry);
        continue;
      }

      // Not yet confirmed: require START_CONFIRM_ADVANCES activity advances
      // within the trailing START_WINDOW_TICKS-tick sliding window. Advances
      // need not be consecutive — an intermittent (burst-style) agent that
      // only writes output every ~15s still accumulates two advances inside
      // the window and gets confirmed, while a lone advance that is never
      // followed up (a focus redraw) ages out of the window and is forgotten.
      const prev = this.activityHistory.get(key);
      const advanced = prev !== undefined && window.activity > prev.lastActivity;
      const oldestValidTick = this.tickCounter - START_WINDOW_TICKS;
      const advanceTicks = (prev?.advanceTicks ?? []).filter((t) => t > oldestValidTick);
      if (advanced) advanceTicks.push(this.tickCounter);
      this.activityHistory.set(key, { lastActivity: window.activity, advanceTicks });
      if (advanceTicks.length < START_CONFIRM_ADVANCES) {
        if (!reasons.has(key)) reasons.set(key, 'unknown');
        continue;
      }

      next.set(key, entry);
    }

    // Enrich all entries with paneName from live session data
    for (const [key, entry] of next) {
      if (entry.paneName) continue;
      const sessions = sessionsByServer.get(entry.serverName);
      if (!sessions) continue;
      const win = findLiveWindow(sessions, entry.target);
      if (!win) continue;
      const { windowSpec } = parseWindowTarget(entry.target);
      const pi = extractPaneIndex(windowSpec, win.index, win.name);
      const name = getRelevantPaneName(win.panes, pi);
      if (name) next.set(key, { ...entry, paneName: name });
    }

    this.previousLiveKeys = liveKeys;
    return { next, reasons, deletedKeys };
  }

  /**
   * Tier 2: classify a candidate's liveness from its pane title, falling back
   * to a `capture-pane` screen tail only when the title alone is
   * inconclusive AND this window's activity has advanced since the last tick
   * (herdr-style cost containment — capture-pane is one extra remote call per
   * window, so it is skipped for windows that are not producing fresh
   * output at all). Returns 'unknown' when the classifier has no rule for
   * this agentType/title/screen combination, telling the caller to fall back
   * to the activity-advance heuristic (Tier 3).
   */
  private async classifyCandidateState(
    server: ServerConfig,
    w: AgentWindow,
    window: TmuxWindow,
    paneIndex: number | null,
    key: string,
  ): Promise<PaneAgentState> {
    if (!(CLASSIFIABLE_AGENT_TYPES as readonly string[]).includes(w.workerType)) return 'unknown';

    const paneTitle = getRelevantPaneTitle(window.panes, paneIndex);
    const titleOnly = classifyPaneState({ paneTitle, agentType: w.workerType });

    // Claude keeps a braille spinner title while showing a permission prompt,
    // so a 'working' title must be confirmed against the screen content.
    if (w.workerType === 'claude' && titleOnly === 'working') {
      const screenTail = await this.captureScreenTail(server, w.tmuxTarget);
      if (screenTail === null) return titleOnly;
      return classifyPaneState({ paneTitle, agentType: w.workerType, screenTail });
    }

    if (titleOnly !== 'unknown') return titleOnly;

    const prevHistory = this.activityHistory.get(key);
    const activityAdvanced = prevHistory !== undefined && window.activity > prevHistory.lastActivity;
    if (!activityAdvanced) return 'unknown';

    const screenTail = await this.captureScreenTail(server, w.tmuxTarget);
    if (screenTail === null) return 'unknown';
    return classifyPaneState({ paneTitle, agentType: w.workerType, screenTail });
  }

  /** Tail of `capture-pane` (~30 lines) for the classifier's screen-content rules. Null on any tmux error. */
  private async captureScreenTail(server: ServerConfig, target: string): Promise<string | null> {
    try {
      const { stdout, code } = await this.tmux.capturePane(server, target, -30);
      if (code !== 0) return null;
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * Populates `next` with entries for supervisorStates keys that neither an
   * operation run nor a windows-table candidate already covers — see
   * collect() step 3. Extracted so collect() itself does not have to grow
   * further; a `running: false`/absent supervisor state simply contributes
   * no entry, mirroring how every other source represents "not running" as
   * key-absence rather than an explicit false flag.
   */
  private collectPureSupervisedEntries(
    operationKeys: Set<string>,
    candidateKeys: Set<string>,
    next: Map<string, AgentActivityEntry>,
  ): void {
    for (const [key, sv] of this.supervisorStates) {
      if (operationKeys.has(key) || candidateKeys.has(key)) continue;
      if (sv.status !== 'running') continue;
      next.set(key, {
        serverName: sv.serverName,
        target: sv.target,
        running: true,
        source: 'supervised',
        operation: false,
        taskId: sv.taskId ?? undefined,
        label: sv.label ?? undefined,
        status: sv.agentStatus,
      });
    }
  }

  /** True when a probe-reported ending is recent enough to act on. */
  private isFreshOutcome(at: number | null): boolean {
    return at !== null && Date.now() - at <= COMPLETION_SYNTHESIS_MAX_AGE_MS;
  }

  /**
   * Resolve why a key that was running is not anymore. The ladder recorded the
   * reason at the rung that decided it; anything it could not attribute falls
   * back to 'unknown' — except a supervised entry whose supervisor connection
   * itself is gone (child_exit / WS disconnect), which is a process/connection
   * disappearance rather than a completion.
   */
  private stopReason(
    key: string,
    previous: AgentActivityEntry,
    reasons: Map<string, AgentActivityStopReason>,
  ): AgentActivityStopReason {
    const recorded = reasons.get(key);
    if (recorded) return recorded;
    if (previous.source === 'supervised' && !this.supervisorStates.has(key)) return 'offline';
    return 'unknown';
  }

  /**
   * Announce completions the tick loop cannot see because the turn was shorter
   * than the polling interval: the key was never in `state` (no tick ever
   * caught it working), yet the Tier 4 probe reports a `terminal_final` written
   * moments ago. Deduped on the completion's own timestamp, so the same ending
   * is announced exactly once. This is what replaces the old "keep terminal_final
   * looking `working` for 120s so the client can observe a working→idle edge"
   * hack (P3).
   */
  private emitSynthesizedCompletions(next: Map<string, AgentActivityEntry>, deletedKeys: Set<string>): void {
    for (const key of deletedKeys) {
      // The window is gone: its cached probe answer (taken while it still
      // existed) must not resurrect it as a completion right after the
      // deletion was announced — the client would rebuild the very finished
      // row the deletion just removed. Drop the cached answer outright so no
      // later tick can either, until the probe refreshes without it.
      this.processStates.delete(key);
      this.emittedCompletions.delete(key);
    }
    for (const [key, probe] of this.processStates) {
      if (next.has(key) || this.state.has(key)) continue;
      const completedAt = probe.completedAt;
      if (!this.isFreshOutcome(completedAt) || completedAt === null) continue;
      if (this.emittedCompletions.get(key) === completedAt) continue;
      this.emittedCompletions.set(key, completedAt);
      // Attribution: a run that started and finished between two ticks is
      // still an operation, and announcing it as a hand-launched agent makes
      // the client raise an "agent finished" notification on top of the task's
      // own task_done. recentOperationMeta keeps that attribution alive for a
      // short window after the run leaves getRunning().
      const operationMeta = this.recentOperationMeta.get(key);
      this.notificationBus.emit({
        type: 'agent:activity',
        payload: {
          serverName: probe.serverName,
          target: probe.target,
          running: false,
          source: operationMeta ? 'operation' : 'manual',
          operation: operationMeta !== undefined,
          taskId: operationMeta?.taskId ?? probe.taskId,
          label: probe.label,
          projectId: probe.projectId,
          reason: 'completed',
        },
      });
    }
  }

  private emitTransitions(
    next: Map<string, AgentActivityEntry>,
    reasons: Map<string, AgentActivityStopReason>,
    deletedKeys: Set<string>,
  ): void {
    for (const [key, entry] of next) {
      const previous = this.state.get(key);
      // Emit both on a brand-new key and on a status flip (e.g.
      // working → blocked) for an already-running key — otherwise a pane
      // that only becomes blocked mid-run (after its initial "running" emit
      // already fired) would never surface the transition at all.
      if (previous === undefined || previous.status !== entry.status) {
        this.notificationBus.emit({
          type: 'agent:activity',
          payload: {
            serverName: entry.serverName,
            target: entry.target,
            running: true,
            source: entry.source,
            operation: entry.operation,
            taskId: entry.taskId,
            label: entry.label,
            projectId: entry.projectId,
            status: entry.status,
            paneName: entry.paneName,
          },
        });
        if (previous === undefined) {
          this.onActivityDetected?.(entry.serverName, entry.target);
        }
      }
    }
    for (const [key, entry] of this.state) {
      if (!next.has(key)) {
        const reason = this.stopReason(key, entry, reasons);
        // Remember an announced completion so the synthesis pass below cannot
        // announce the same ending a second time.
        if (reason === 'completed') {
          const completedAt = this.processStates.get(key)?.completedAt;
          if (completedAt != null) this.emittedCompletions.set(key, completedAt);
        }
        this.notificationBus.emit({
          type: 'agent:activity',
          payload: {
            serverName: entry.serverName,
            target: entry.target,
            running: false,
            source: entry.source,
            status: entry.status,
            operation: entry.operation,
            taskId: entry.taskId,
            label: entry.label,
            projectId: entry.projectId,
            paneName: entry.paneName,
            reason,
          },
        });
      }
    }

    // A window deleted while already idle emits no transition above (it was not
    // in `state`), yet consumers must drop its finished row immediately. This is
    // one-shot by construction: `deletedKeys` holds only rows that vanished from
    // the candidate inventory on *this* tick.
    for (const key of deletedKeys) {
      if (this.state.has(key) || next.has(key)) continue;
      const [serverName, target] = splitWindowKey(key);
      this.notificationBus.emit({
        type: 'agent:activity',
        payload: { serverName, target, running: false, source: 'manual', operation: false, reason: 'deleted' },
      });
    }

    this.emitSynthesizedCompletions(next, deletedKeys);
  }
}
