/**
 * Extracts OSC 0/2 window-title sequences from the PTY output stream and
 * classifies the latest title into an agent state.
 *
 * Rationale: the byte-volume heuristic (ActivityTracker) misreads keystroke
 * echo as activity — Claude Code's TUI repaints its whole input box on every
 * keypress, easily exceeding the active threshold while the agent is idle.
 * The pane title, by contrast, is set by the agent itself (a spinner glyph
 * while working, `✳` while idle) and flows through this very process, since
 * the supervisor relays the PTY stream verbatim. Parsing it inline gives an
 * authoritative signal with zero extra I/O.
 *
 * Classification rules are conceptually shared with the hub-side classifier
 * (packages/server/src/modules/operations/paneStateClassifier.ts — title
 * rules only; screen-content rules do not apply here). They are deliberately
 * re-implemented locally instead of imported: tui-supervisor is a standalone
 * single-file distribution (see scripts/build.ts) and must not depend on the
 * server package. Keep the two in sync when the title rules change.
 */

export type TitleAgentState = 'working' | 'idle' | 'blocked' | 'unknown';

/**
 * Upper bound on the carry-over buffer for an OSC sequence split across chunk
 * boundaries. Real titles are short; anything larger is either a pathological
 * OSC payload or a parser desync — drop it rather than buffering unboundedly.
 */
const MAX_PENDING_LEN = 4_096;

/**
 * Leading working-spinner glyph. Covers every spinner frame set observed
 * across Claude Code versions plus codex's braille spinner:
 * - U+2800-U+28FF: braille patterns (codex, and older Claude builds).
 * - U+25D0-U+25D3 (◐◑◒◓): the half-circle spinner used by the current
 *   Claude Code (real-world observed title: `◐ libghosttyのwasm版導入検討`).
 * - U+273B/U+2736/U+273D (✻✶✽) and `✢`/`∗`: additional asterisk-family
 *   spinner glyphs seen across other Claude Code releases.
 *
 * Bias rationale: when in doubt, prefer classifying a glyph as `working`
 * rather than `idle`. This state only overrides ActivityTracker's byte-volume
 * heuristic when it actually fires (see class doc); a glyph absent from this
 * set just falls through to `idle`/`unknown` and the byte heuristic keeps
 * deciding, whereas a spinner misclassified as `idle` would actively suppress
 * a real working signal. So extend this set liberally as new glyphs surface.
 *
 * Kept in sync with `WORKING_SPINNER_TITLE_RE` in
 * `packages/server/src/modules/operations/paneStateClassifier.ts` — the two
 * packages cannot share a constant, so when the glyph set changes, update both.
 */
const WORKING_SPINNER_RE = /^[⠀-⣿◐◑◒◓✻✶✽✢∗] /;

/**
 * Claude Code's idle title marker. `✳` is also a spinner frame in some
 * older builds, so this rule is ambiguous in isolation — but a genuine
 * working title cycles through other spinner frames within the same short
 * burst, so a stray `✳` misread as idle is corrected by the very next
 * WORKING_SPINNER_RE-matching title. Accepted trade-off, not a bug.
 */
const IDLE_MARKER_RE = /^✳ /;

/** Matches a complete OSC 0/2 title sequence: ESC ] 0|2 ; <title> (BEL | ESC \). */
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * Matches a trailing, still-unterminated OSC 0/2 prefix (possibly just a lone
 * ESC or `ESC ]`) at the end of a chunk — carried over to the next chunk so a
 * sequence split across chunk boundaries is still recognized. The inner
 * `\x1b?` also covers an ST terminator split between its ESC and `\`.
 */
const OSC_PARTIAL_TAIL_RE = /\x1b(?:\](?:[02](?:;[^\x07\x1b]*\x1b?)?)?)?$/;

function classifyTitle(title: string): TitleAgentState {
  // Order matters: blocked (codex's "Action Required") wins over everything,
  // then the working spinner, then the explicit idle marker. Any other
  // non-empty title still proves an agent owns the pane and is not asking
  // for anything → idle (codex convention; matches the hub-side classifier).
  if (title.includes('Action Required')) return 'blocked';
  if (WORKING_SPINNER_RE.test(title)) return 'working';
  if (IDLE_MARKER_RE.test(title)) return 'idle';
  if (title.length > 0) return 'idle';
  return 'unknown';
}

export class TitleStateTracker {
  /** Unterminated OSC-sequence tail carried over from the previous chunk. */
  private pending = '';
  private state: TitleAgentState = 'unknown';

  /**
   * Feed a raw PTY output chunk. Extracts every complete OSC 0/2 title in it
   * (the last one wins) and updates the classified state. An unterminated
   * sequence at the chunk's end is buffered for the next call.
   */
  push(chunk: string): void {
    let data = this.pending + chunk;
    this.pending = '';

    let lastTitle: string | null = null;
    OSC_TITLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let scannedUpTo = 0;
    while ((match = OSC_TITLE_RE.exec(data)) !== null) {
      lastTitle = match[1];
      scannedUpTo = OSC_TITLE_RE.lastIndex;
    }

    // Keep only the part after the last complete sequence when looking for a
    // partial tail — anything before it is fully consumed.
    const tailRegion = data.slice(scannedUpTo);
    const partial = OSC_PARTIAL_TAIL_RE.exec(tailRegion);
    if (partial && partial[0].length > 0 && partial[0].length <= MAX_PENDING_LEN) {
      this.pending = partial[0];
    }

    if (lastTitle !== null) {
      const classified = classifyTitle(lastTitle);
      // An empty title (classifyTitle → 'unknown') does not erase a previous
      // observation: some TUIs blank the title transiently while redrawing.
      if (classified !== 'unknown') this.state = classified;
    }
  }

  /**
   * Latest classified title state. 'unknown' means no classifiable title has
   * been observed yet (e.g. a generic agent that never sets one) — callers
   * should fall back to their own heuristic in that case.
   */
  getState(): TitleAgentState {
    return this.state;
  }
}
