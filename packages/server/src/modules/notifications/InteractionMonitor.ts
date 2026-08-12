import type { IWindowRepository } from '../windows/Window';
import { isAgentWindow } from '../windows/Window';
import { windowSpecMatches } from '../tmux/TmuxClient';
import { parseWindowTarget } from '../operations/AgentActivityMonitor';

/**
 * Event-driven pending-answer signal delivered by a Claude Code Notification hook
 * (`harness/hooks/azito-interaction.sh`) via `POST /api/webhooks/agent-interaction`.
 * Identifies the tmux pane the hook fired from — resolved against the `windows`
 * table, mirroring `AgentActivityMonitor.recordHookSignal`'s matching approach (see
 * that file's `parseWindowTarget`/`windowSpecMatches` usage). `'cancel'` is part of
 * the normalized contract for future extension but has no caller yet (v1 only ever
 * sends `'open'` — see `harness/hooks/azito-interaction.sh` and the webhook route).
 */
export interface InteractionSignal {
  serverName: string;
  target: {
    sessionName: string;
    windowIndex: number;
    windowName: string;
    paneIndex: number;
  };
  event: 'open' | 'cancel';
  timestamp: number;
}

const TIMEOUT_MS = 10 * 60 * 1000;

interface PendingState {
  openedAt: number;
}

/**
 * Extract the pane index named by a `windowSpec[.pane]` target, if any — mirrors
 * the identically named private helper in AgentActivityMonitor.ts (duplicated
 * rather than shared: it is a few lines of pure logic and the two monitors are
 * deliberately independent, see the class doc comment on InteractionMonitor).
 */
function extractPaneIndex(windowSpec: string, windowIndex: number, windowName: string): number | null {
  const specMatchesWindow = (spec: string): boolean =>
    spec !== '' && (/^\d+$/.test(spec) ? spec === String(windowIndex) : spec === windowName);
  if (specMatchesWindow(windowSpec)) return null;
  const m = windowSpec.match(/\.(\d+)$/);
  if (!m) return null;
  const stripped = windowSpec.slice(0, -m[0].length);
  return specMatchesWindow(stripped) ? parseInt(m[1], 10) : null;
}

/**
 * Tracks, in memory only, which windows are currently waiting on a user answer —
 * a real-time "existence signal" distinct from the actual question content (which
 * arrives later from transcript logs once answered, see `TranscriptEntry
 * type: 'interaction'`). Intentionally has no persistence: this state is
 * inherently ephemeral (a pending answer either gets resolved within minutes or
 * times out), so losing it on restart is fine — the worst case is a missed
 * banner, never a stale one (isPending() re-validates the window and the
 * timeout on every read).
 *
 * "open" is best-effort (a hook signal naming no known window is silently
 * dropped, exactly like AgentActivityMonitor.recordHookSignal). "close" is
 * authoritative, via any of:
 * - a newer transcript record arriving for the window's session (the polling
 *   read path calls clear() once it observes new entries — see
 *   modules/transcripts/routes.ts)
 * - an explicit cancel signal (event: 'cancel', reserved — no caller yet)
 * - timeout expiry (10 minutes from the open signal)
 * - the window disappearing from the `windows` table (checked lazily in
 *   isPending(), not proactively swept)
 */
export class InteractionMonitor {
  private pending = new Map<number, PendingState>();

  constructor(
    private windowRepo: IWindowRepository,
    private now: () => number = Date.now,
  ) {}

  /**
   * Resolve the signal to a window (same matching approach as
   * AgentActivityMonitor.recordHookSignal: serverName + sessionName +
   * windowSpec, with an optional pane-suffix pin) and update pending state.
   * A signal naming no known agent window is silently dropped.
   */
  recordSignal(signal: InteractionSignal): void {
    const windowId = this.resolveWindowId(signal);
    if (windowId === null) return;

    if (signal.event === 'cancel') {
      this.pending.delete(windowId);
      return;
    }

    this.pending.set(windowId, { openedAt: signal.timestamp });
  }

  /**
   * True while `windowId` has a live pending-answer signal: not yet cleared,
   * not timed out, and the window still exists. Lazily clears expired/stale
   * entries as a side effect of the check (no separate sweep timer needed —
   * this state is only ever read from the ~2s chat-polling response path).
   */
  isPending(windowId: number): boolean {
    const state = this.pending.get(windowId);
    if (!state) return false;

    if (this.now() - state.openedAt >= TIMEOUT_MS) {
      this.pending.delete(windowId);
      return false;
    }

    if (!this.windowRepo.findById(windowId)) {
      this.pending.delete(windowId);
      return false;
    }

    return true;
  }

  /** Authoritative close: called once the polling read path observes a newer transcript record. */
  clear(windowId: number): void {
    this.pending.delete(windowId);
  }

  private resolveWindowId(signal: InteractionSignal): number | null {
    for (const w of this.windowRepo.findAll()) {
      if (!isAgentWindow(w)) continue;
      if (w.serverName !== signal.serverName) continue;

      const { sessionName, windowSpec } = parseWindowTarget(w.tmuxTarget);
      if (sessionName !== signal.target.sessionName) continue;
      if (!windowSpecMatches(windowSpec, signal.target.windowIndex, signal.target.windowName)) continue;

      const paneIndex = extractPaneIndex(windowSpec, signal.target.windowIndex, signal.target.windowName);
      if (paneIndex !== null && paneIndex !== signal.target.paneIndex) continue;

      return w.id;
    }
    return null;
  }
}
