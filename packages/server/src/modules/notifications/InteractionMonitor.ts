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
  muxPaneRef?: string;
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

/** チャットから数字キー1発で回答できるのは、この tool の質問だけ（ピッカーの操作規約が既知なため）。 */
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

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
   * The tmux pane index the signal fired from. A window can hold several panes, and only the
   * one the agent is blocked in has a picker open — a digit delivered to any other pane lands
   * in whatever is running there (a shell, a second agent's prompt). Recorded so an answer can
   * be pinned to the pane that actually asked, instead of trusting the pane the client names.
   */
  paneIndex: number;
  /**
   * The question, when a content-bearing signal has been seen for this window. Absent when
   * only contentless signals (Notification hook) have arrived — the chat view then shows the
   * banner rather than an answerable card.
   */
  content?: InteractionContent;
}

/** `consumePendingAnswer` の判定材料（呼び出し側が渡す「いま回答しようとしている対象」）。 */
export interface PendingAnswerClaim {
  /** 表示していた質問の世代識別子（pendingQuestion.openedAt）。 */
  openedAt: number;
  /** 選択肢の番号（1 始まり、= 送出する数字キー）。 */
  optionNumber: number;
  /** 送出先として解決済みのペイン index。シグナル元と一致しなければ回答は成立しない。 */
  paneIndex: number;
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
        paneIndex: signal.target.paneIndex,
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
   * Claim `windowId`'s pending question for answering. Returns true exactly once per open
   * question, clearing the pending state (and every sibling, like `clear()`) as it does; false
   * leaves the state untouched and the caller (the `answer` window-signal route) turns it into
   * a 409 without sending anything.
   *
   * Every condition an answer depends on is checked *here*, in the same synchronous step that
   * clears the state, because each one is a race the caller cannot close on its own:
   * - `openedAt` must name the question the client was looking at. Between the poll that
   *   rendered the card and the tap, the agent can answer that question and open a different
   *   one; a bare digit would then silently answer the *new* question with a number chosen for
   *   the old one's options.
   * - `paneIndex` must be the pane the signal fired from. The client names its own send target,
   *   and in a multi-pane window that need not be the pane holding the picker — a digit
   *   delivered elsewhere is typed into whatever is running there.
   * - the question must still be the shape a single digit can answer (AskUserQuestion, exactly
   *   one question, single-select) and `optionNumber` must index an option that exists. The
   *   frontend applies the same rule before showing the card, but a client is free not to.
   *
   * Consuming before the key is sent, rather than after, is deliberate: the digit answers a
   * modal picker, and a second digit arriving once the picker closed would go straight into the
   * agent's prompt. Everything that can reject the answer is checked before the state is
   * cleared, so a rejected claim never costs the pending question.
   */
  consumePendingAnswer(windowId: number, claim: PendingAnswerClaim): boolean {
    const state = this.getValidState(windowId);
    if (!state) return false;
    if (state.openedAt !== claim.openedAt) return false;
    if (state.paneIndex !== claim.paneIndex) return false;

    const content = state.content;
    if (!content || content.toolName !== ASK_USER_QUESTION_TOOL_NAME) return false;
    if (content.questions.length !== 1) return false;

    const question = content.questions[0];
    if (question.multiSelect) return false;
    if (!Number.isInteger(claim.optionNumber)) return false;
    if (claim.optionNumber < 1 || claim.optionNumber > question.options.length) return false;

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
