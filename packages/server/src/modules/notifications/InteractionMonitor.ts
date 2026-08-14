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
  /**
   * The question itself, when the signal source could supply it (PermissionRequest hook,
   * `harness/hooks/azito-question.sh`). Optional because the other signal source — the
   * Notification hook — has no access to the tool input and can only report *that* an
   * answer is being waited on. A signal without content still opens the pending state; it
   * just degrades the chat view to the banner instead of an answerable question card.
   */
  content?: InteractionContent;
}

/** One selectable option of an AskUserQuestion question (mirrors the CLI's tool_input shape). */
export interface InteractionQuestionOption {
  label: string;
  description?: string;
}

/** One AskUserQuestion question (mirrors the CLI's tool_input shape). */
export interface InteractionQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: InteractionQuestionOption[];
}

/**
 * The tool input carried by a PermissionRequest hook signal. `toolName` is retained (rather
 * than assumed to be `AskUserQuestion`) so the pending state stays honest about what produced
 * it; the hook only ever forwards AskUserQuestion, and consumers key off the question shape.
 */
export interface InteractionContent {
  toolName: string;
  questions: InteractionQuestion[];
}

const TIMEOUT_MS = 10 * 60 * 1000;

interface PendingState {
  openedAt: number;
  /**
   * Every window ID resolved from the same signal (a project-owned window row
   * and a task-owned window row can both point at the same tmux target — same
   * serverName+session+windowIndex+pane — so one signal can match more than
   * one `windows` row, mirroring `AgentActivityMonitor.recordHookSignal`,
   * which also updates every matching row rather than just the first).
   * Recorded once at signal time so `clear(windowId)` can look this array up
   * and close every sibling symmetrically with how `recordSignal()` opened
   * them all, without needing to re-resolve against the windows table.
   */
  siblingIds: number[];
  /**
   * The question, when a content-bearing signal has been seen for this window. Absent when
   * only contentless signals (Notification hook) have arrived — the chat view then shows the
   * banner rather than an answerable card.
   */
  content?: InteractionContent;
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
   * Resolve the signal to every matching window (same matching approach as
   * AgentActivityMonitor.recordHookSignal: serverName + sessionName +
   * windowSpec, with an optional pane-suffix pin — looping over the full
   * `windows` table rather than stopping at the first match, since a
   * project-owned row and a task-owned row can both point at the same tmux
   * target) and update pending state for all of them. A signal naming no
   * known agent window is silently dropped.
   */
  recordSignal(signal: InteractionSignal): void {
    const windowIds = this.resolveWindowIds(signal);
    if (windowIds.length === 0) return;

    if (signal.event === 'cancel') {
      for (const windowId of windowIds) this.pending.delete(windowId);
      return;
    }

    for (const windowId of windowIds) {
      // Content beats no content, regardless of arrival order. The two hooks that can open the
      // same pending state fire at very different times — PermissionRequest (with content) the
      // instant the picker opens, Notification (contentless) roughly 60s later — so the common
      // case is a contentless signal arriving *after* the real question. Overwriting would
      // silently downgrade an answerable card back to a bare banner mid-question. A later
      // content-bearing signal does overwrite (it names a newer question). Only a still-live
      // state carries over: an expired one is treated as absent, same as everywhere else.
      const previousContent = this.getValidState(windowId)?.content;
      this.pending.set(windowId, {
        openedAt: signal.timestamp,
        siblingIds: windowIds,
        content: signal.content ?? previousContent,
      });
    }
  }

  /**
   * True while `windowId` has a live pending-answer signal: not yet cleared,
   * not timed out, and the window still exists. Lazily clears expired/stale
   * entries as a side effect of the check (no separate sweep timer needed —
   * this state is only ever read from the ~2s chat-polling response path).
   */
  isPending(windowId: number): boolean {
    return this.getValidState(windowId) !== undefined;
  }

  /**
   * The `openedAt` (epoch ms) of `windowId`'s live pending-answer signal, or
   * `undefined` if there isn't one — same liveness rules as `isPending()`
   * (not cleared, not timed out, window still exists). Lets callers (routes.ts)
   * compare a transcript entry's timestamp against the moment the signal opened,
   * to decide whether that entry counts as "newer than the open signal".
   */
  getOpenedAt(windowId: number): number | undefined {
    return this.getValidState(windowId)?.openedAt;
  }

  /**
   * The question carried by `windowId`'s live pending-answer signal, or `undefined` when there
   * is no live signal or the signal never carried content. Same liveness rules as
   * `isPending()`. Lets the chat read path offer an answerable question card instead of the
   * "waiting for an answer" banner.
   */
  getPendingContent(windowId: number): InteractionContent | undefined {
    return this.getValidState(windowId)?.content;
  }

  /**
   * Claim `windowId`'s pending question for answering: returns true exactly once per open
   * question, clearing the pending state (and every sibling, like `clear()`) as it does.
   * Returns false when there is no live pending state or it carries no content — the caller
   * (the `answer` window-signal route) turns that into a 409 rather than sending a digit.
   *
   * Consuming *before* the key is sent, rather than after, is deliberate: the digit answers a
   * modal picker, and a second digit arriving after the picker closed would be typed straight
   * into the agent's prompt. Losing the pending state when the send then fails is the cheaper
   * failure — that only costs the banner, and a pane that cannot be written to cannot be
   * answered from chat anyway.
   */
  consumePendingQuestion(windowId: number): boolean {
    if (this.getValidState(windowId)?.content === undefined) return false;
    this.clear(windowId);
    return true;
  }

  /**
   * Authoritative close: called once the polling read path observes a newer
   * transcript record. Symmetric with recordSignal(): also clears every
   * sibling window ID recorded alongside `windowId` at signal time (same
   * tmux target, different `windows` row), so clearing one clears all of
   * them. Falls back to clearing just `windowId` when it has no live pending
   * entry (siblingIds unknown) — a no-op in that case, same as before this
   * fix.
   */
  clear(windowId: number): void {
    const siblingIds = this.pending.get(windowId)?.siblingIds ?? [windowId];
    for (const id of siblingIds) this.pending.delete(id);
  }

  /** Shared liveness check backing isPending()/getOpenedAt(): validates timeout + window existence, lazily clearing stale entries. */
  private getValidState(windowId: number): PendingState | undefined {
    const state = this.pending.get(windowId);
    if (!state) return undefined;

    if (this.now() - state.openedAt >= TIMEOUT_MS) {
      this.pending.delete(windowId);
      return undefined;
    }

    if (!this.windowRepo.findById(windowId)) {
      this.pending.delete(windowId);
      return undefined;
    }

    return state;
  }

  /** Resolve the signal to every matching window ID (see recordSignal's doc comment on why more than one row can match). */
  private resolveWindowIds(signal: InteractionSignal): number[] {
    const windowIds: number[] = [];
    for (const w of this.windowRepo.findAll()) {
      if (!isAgentWindow(w)) continue;
      if (w.serverName !== signal.serverName) continue;

      const { sessionName, windowSpec } = parseWindowTarget(w.tmuxTarget);
      if (sessionName !== signal.target.sessionName) continue;
      if (!windowSpecMatches(windowSpec, signal.target.windowIndex, signal.target.windowName)) continue;

      const paneIndex = extractPaneIndex(windowSpec, signal.target.windowIndex, signal.target.windowName);
      if (paneIndex !== null && paneIndex !== signal.target.paneIndex) continue;

      windowIds.push(w.id);
    }
    return windowIds;
  }
}
