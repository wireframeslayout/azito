/**
 * Test support: the screen of a worker whose input box the keys sent to the pane fill and empty, in a form both Claude Code's (two rules,
 * `❯`) and codex's (`›` composer, footer) parsers read, so one fake pane serves a test of either agent.
 */
/** Names of keys that are not text (tmux's send-keys names): they do not go into the box. */
const CONTROL_KEY = /^(C-|M-|Escape$|Tab$|BTab$|Up$|Down$|Left$|Right$|BSpace$|Home$|End$|PageUp$|PageDown$)/;
const RULE = '─'.repeat(60);

function wrapped(draft: string, width: number | undefined): string[] {
  if (width === undefined || draft.length <= width) return [draft];
  const pieces: string[] = [];
  for (let i = 0; i < draft.length; i += width) pieces.push(draft.slice(i, i + width));
  return pieces;
}

export function workerScreenWith(draft: string, wrapWidth?: number, onlyClaude = false, quiet = false): string {
  const pieces = wrapped(draft, wrapWidth);
  // Claude's input between its two rules, codex's composer and footer at the bottom (each parser reads its own part).
  return [
    RULE,
    ...pieces.map((piece, i) => (i === 0 ? `❯ ${piece}` : `  ${piece}`)),
    RULE,
    ...(onlyClaude ? [] : [
      // the line codex writes when a turn is over (a pane that has a "quiet" screen has none: a session just started)
      ...(quiet ? [] : ['  Worked for 1s • 9:00 AM']),
      ...pieces.map((piece, i) => (i === 0 ? `› ${draft === '' ? 'Ask Codex to do anything' : piece}` : `  ${piece}`)),
      '',
      '  ? for shortcuts                              100% context left',
    ]),
    '  bypass permissions on (shift+tab to cycle) · fake pane',
  ].join('\n');
}

export interface FakeWorkerPaneOptions {
  /** Only Claude's part of the screen is drawn (a wrapped codex composer would not leave room for the footer rows Claude's reader allows). */
  onlyClaude?: boolean;
  /** The screen has no "Worked for" line above the codex composer. */
  quiet?: boolean;
  /** The input wraps at this many characters. */
  wrapWidth?: number;
  /** Ctrl+U clears one display line of the input only (Claude Code's behaviour in a wrapped input). */
  clearsOneLine?: boolean;
}

/** A pane that takes keys the way a TUI's input does: text is appended to the box, Enter submits (empties) it. */
export function createFakeWorkerPane(options: FakeWorkerPaneOptions = {}): { sendKeys(keys: string[]): void; clear(): void; screen(): string; readonly submitted: string[] } {
  let draft = '';
  const submitted: string[] = [];
  return {
    sendKeys(keys) {
      for (const key of keys) {
        if (key === 'Enter') {
          if (draft !== '') submitted.push(draft);
          draft = '';
        } else if (!CONTROL_KEY.test(key)) {
          draft += key;
        }
      }
    },
    clear() {
      if (options.clearsOneLine && options.wrapWidth !== undefined) draft = draft.slice(0, Math.floor((draft.length - 1) / options.wrapWidth) * options.wrapWidth);
      else draft = '';
    },
    screen: () => workerScreenWith(draft, options.wrapWidth, options.onlyClaude, options.quiet),
    submitted,
  };
}
