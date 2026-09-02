/**
 * Rule-based pane state classification, ported from herdr's manifest rules
 * (`claude.toml`/`codex.toml`) — herdr classifies an agent's liveness from the
 * tmux pane's OSC title and, when the title alone is inconclusive, its screen
 * content, rather than from tmux `window_activity` freshness (which cannot
 * distinguish "the agent is producing output" from "a human just typed a
 * keystroke into a focused pane").
 *
 * Verified facts (Issue: AgentActivityMonitor Tier 2 redesign):
 * - Claude Code writes its state into the pane title via an OSC 2 sequence:
 *   a leading braille spinner glyph (e.g. `⠐ タスク要約`) while working, a
 *   leading `✳` (e.g. `✳ タスク要約`) while idle.
 * - `tui-supervisor` (pty-proxy) passes OSC sequences through untouched, so
 *   title-based detection also works for supervised panes.
 * - codex's title/screen rules below are ported directly from herdr's
 *   `codex.toml` manifest; unlike the claude rules, they have NOT been
 *   verified against a live `codex` pane on this machine (no interactive
 *   codex session was launched to confirm the literal title/screen text) —
 *   treat them as best-effort until spot-checked against a real session.
 */

export type PaneAgentState = 'working' | 'idle' | 'blocked' | 'unknown';

/**
 * Agent types the classifier has rules for. Exported so callers (e.g.
 * AgentActivityMonitor) can skip the extra `capture-pane` cost for an
 * agentType classifyPaneState can never resolve (it always returns
 * 'unknown' for anything not in this list, regardless of screenTail).
 */
export const CLASSIFIABLE_AGENT_TYPES = ['claude', 'codex'] as const;

export interface ClassifyPaneStateInput {
  paneTitle: string | null;
  /** Tail of `capture-pane` output — only needed when the title alone does not resolve the state. */
  screenTail?: string | null;
  agentType: 'claude' | 'codex' | 'generic' | string;
}

interface TitleRule {
  test: (title: string) => boolean;
  state: PaneAgentState;
}

interface ScreenRule {
  /** `screen` is already lower-cased. */
  test: (screen: string) => boolean;
  state: PaneAgentState;
}

/**
 * Leading working-spinner glyph. Covers every spinner frame set observed
 * across Claude Code versions plus codex's braille spinner:
 * - U+2800-U+28FF: braille patterns (codex, and older Claude builds).
 * - U+25D0-U+25D3 (◐◑◒◓): the half-circle spinner used by the current
 *   Claude Code (real-world observed title: `◐ libghosttyのwasm版導入検討`).
 * - U+273B/U+2736/U+273D (✻✶✽) and `✢`/`∗`: additional asterisk-family
 *   spinner glyphs seen across other Claude Code releases.
 *
 * Kept in sync with `WORKING_SPINNER_RE` in
 * `packages/tui-supervisor/src/TitleStateTracker.ts` — the two packages
 * cannot share a constant, so when the glyph set changes, update both.
 *
 * NOTE: Claude Code ≥2.1.236 does not animate spinner glyphs in pane titles
 * under tmux (title is written only when its text changes). Tier 2 title
 * classification therefore cannot detect 'working' for these versions.
 */
const WORKING_SPINNER_TITLE_RE = /^[⠀-⣿◐◑◒◓✻✶✽✢∗] /;

/** Claude Code's idle title marker. */
const CLAUDE_IDLE_TITLE_RE = /^✳ /;

/** A prompt-box line (`❯ `) at the start of a line — Claude Code's idle input box. */
const CLAUDE_PROMPT_BOX_RE = /^\s*❯/m;

// Order matters: first matching rule wins.

const CLAUDE_TITLE_RULES: TitleRule[] = [
  { test: (t) => WORKING_SPINNER_TITLE_RE.test(t), state: 'working' },
  { test: (t) => CLAUDE_IDLE_TITLE_RE.test(t), state: 'idle' },
];

const CLAUDE_SCREEN_RULES: ScreenRule[] = [
  { test: (s) => s.includes('esc to interrupt'), state: 'working' },
  // blocked screen rules are checked early in classifyClaude() — not duplicated here.
  { test: (s) => CLAUDE_PROMPT_BOX_RE.test(s), state: 'idle' },
];

const CODEX_TITLE_RULES: TitleRule[] = [
  { test: (t) => t.includes('Action Required'), state: 'blocked' },
  { test: (t) => WORKING_SPINNER_TITLE_RE.test(t), state: 'working' },
];

const CODEX_SCREEN_RULES: ScreenRule[] = [
  {
    test: (s) => s.includes('press enter to confirm or esc to cancel') || s.includes('allow command?') || s.includes('enter to submit'),
    state: 'blocked',
  },
  // Weaker signals: only meaningful together with an explicit yes/no choice.
  { test: (s) => s.includes('[y/n]') || (s.includes('do you want to') && s.includes('yes')), state: 'blocked' },
];

function classifyClaude(paneTitle: string, screenTail: string | null): PaneAgentState {
  // Screen blocked check runs before title: Claude keeps the working spinner in the
  // title while showing a permission prompt, so title-first would return 'working'.
  if (screenTail) {
    const screen = screenTail.toLowerCase();
    if (
      (screen.includes('enter to select') && screen.includes('esc to cancel')) ||
      screen.includes('do you want to proceed?')
    ) {
      return 'blocked';
    }
  }
  for (const rule of CLAUDE_TITLE_RULES) {
    if (rule.test(paneTitle)) return rule.state;
  }
  if (screenTail) {
    const screen = screenTail.toLowerCase();
    for (const rule of CLAUDE_SCREEN_RULES) {
      if (rule.test(screen)) return rule.state;
    }
  }
  return 'unknown';
}

function classifyCodex(paneTitle: string, screenTail: string | null): PaneAgentState {
  for (const rule of CODEX_TITLE_RULES) {
    if (rule.test(paneTitle)) return rule.state;
  }
  if (screenTail) {
    const screen = screenTail.toLowerCase();
    for (const rule of CODEX_SCREEN_RULES) {
      if (rule.test(screen)) return rule.state;
    }
  }
  // A non-empty title that named no rule above still tells us codex is in
  // the foreground and not asking for anything — idle.
  if (paneTitle.length > 0) return 'idle';
  return 'unknown';
}

/**
 * Classify a pane's agent liveness from its title (checked first) and,
 * only when the title is inconclusive, its screen tail. `generic` (and any
 * other agent type) always returns 'unknown' — callers fall back to their
 * own heuristic for those.
 */
export function classifyPaneState(input: ClassifyPaneStateInput): PaneAgentState {
  const paneTitle = input.paneTitle ?? '';
  const screenTail = input.screenTail ?? null;

  switch (input.agentType) {
    case 'claude':
      return classifyClaude(paneTitle, screenTail);
    case 'codex':
      return classifyCodex(paneTitle, screenTail);
    default:
      return 'unknown';
  }
}
