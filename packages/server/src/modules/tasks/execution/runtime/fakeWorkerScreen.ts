/**
 * Test support: the screen of a worker whose input box the keys sent to the pane fill and empty, in a form both Claude Code's (two rules,
 * `❯`) and codex's (`›` composer, footer) parsers read, so one fake pane serves a test of either agent. `typed` is what the box holds.
 */
/** Names of keys that are not text (tmux's send-keys names): they do not go into the box. */
const CONTROL_KEY = /^(C-|M-|Escape$|Tab$|BTab$|Up$|Down$|Left$|Right$|BSpace$|Home$|End$|PageUp$|PageDown$)/;
const RULE = '─'.repeat(60);

export function workerScreenWith(draft: string): string {
  // Claude's input between its two rules, codex's composer and footer at the bottom (each parser reads its own part).
  return [
    RULE,
    `❯ ${draft}`,
    RULE,
    `› ${draft === '' ? 'Ask Codex to do anything' : draft}`,
    '',
    '  ? for shortcuts                              100% context left',
    '  bypass permissions on (shift+tab to cycle) · fake pane',
  ].join('\n');
}

/** A pane that takes keys the way a TUI's input does: text is appended to the box, Enter submits (empties) it. */
export function createFakeWorkerPane(): { sendKeys(keys: string[]): void; clear(): void; screen(): string; readonly submitted: string[] } {
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
      draft = '';
    },
    screen: () => workerScreenWith(draft),
    submitted,
  };
}
