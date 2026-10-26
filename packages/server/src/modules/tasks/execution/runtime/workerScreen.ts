/**
 * What a TUI worker's screen says about whether it can take a prompt (Issue #532). Pure functions over `capture-pane` text; the
 * runtime decides what to do with the answer. The texts are read from the shipped programs: Claude Code 2.0.50 / 2.1.310, codex
 * rust-v0.149.0 / rust-v0.164.0 (`tui/src/update_prompt.rs`, `onboarding/trust_directory.rs`, `bottom_pane/footer.rs`, `chatwidget.rs`).
 */

/** The agent whose screen is read. A generic worker has none. */
export type TuiAgentKind = 'claude' | 'codex';

/** A screen that waits for a person, named for the reason the task is stopped with. */
export type WorkerDialog = 'trust_dialog' | 'bypass_permissions_dialog' | 'codex_update_prompt' | 'codex_trust_prompt';

/** The agent a worker type runs; null for a generic worker (its screen is not read). */
export function tuiAgentKindOfWorkerType(workerType: string | null): TuiAgentKind | null {
  return workerType === 'claude' || workerType === 'codex' ? workerType : null;
}

/** The agent a launch line starts. */
export function tuiAgentKindOf(launchCommand: string): TuiAgentKind | null {
  const isCodex = /\bcodex\b/i.test(launchCommand);
  const isClaude = /\bclaude\b/i.test(launchCommand);
  if (isClaude && !isCodex) return 'claude';
  if (isCodex && !isClaude) return 'codex';
  return null;
}

function stripAnsi(output: string): string {
  return output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/** Lower-cased, box-drawing characters and runs of whitespace collapsed: the pane wraps a dialog's lines inside a frame. */
function flatten(output: string): string {
  return stripAnsi(output).toLowerCase().replace(/[─-╿]/g, ' ').replace(/\s+/g, ' ');
}

/**
 * What Claude Code shows only while it runs: the permission-mode status line (every launch carries --dangerously-skip-permissions, so it
 * is "bypass permissions on (shift+tab to cycle)", at the bottom of the screen at all times) and, while it works, "esc to interrupt".
 * Neither is on a dialog. Used for the position of a dialog against the live screen.
 */
const CLAUDE_STATUS_MARKERS = ['bypass permissions on', 'shift+tab to cycle', 'esc to interrupt'] as const;

/**
 * The "Bypass Permissions mode" confirmation `claude --dangerously-skip-permissions` shows until `skipDangerousModePermissionPrompt` is
 * set. Read from the shipped binary of 2.1.310 (`BypassPermissionsModeDialog`; the 2.0.50 `cli.js` has the same texts): the title is
 * "WARNING: Claude Code running in Bypass Permissions mode", the body ends "By proceeding, you accept all responsibility for actions taken
 * while running in Bypass Permissions mode.", the choices are "No, exit" / "Yes, I accept". The body also contains "bypass permissions",
 * which is why the ready check must exclude this screen.
 * The screen is the pane's last lines, which can also hold a conversation that quotes the whole dialog: it is the dialog only when the
 * title and both choices are there and nothing of the live screen (status line, working line) shows below them. Box-drawing characters
 * and whitespace are collapsed because the pane wraps the dialog's lines inside a frame.
 */
function bypassDialogAt(output: string): number {
  const text = flatten(output);
  const at = lastIndexOfChoiceSet(text, ['warning: claude code running in bypass permissions mode', 'yes, i accept', 'no, exit']);
  return at > lastIndexOfAny(text, CLAUDE_STATUS_MARKERS) ? at : -1;
}

/** Claude Code's folder trust screen ("Do you trust this folder?", choices "Yes, proceed" / "No, exit"), when nothing of the live screen is below it. */
function claudeTrustDialogAt(output: string): number {
  const text = flatten(output);
  const at = Math.max(text.lastIndexOf('trust this folder'), (text.includes('no,') && text.includes('exit') && text.includes('yes,') && text.includes('trust')) ? text.lastIndexOf('trust') : -1);
  return at > lastIndexOfAny(text, CLAUDE_STATUS_MARKERS) ? at : -1;
}

/**
 * The text codex shows only at its composer: the placeholder "Ask Codex to do anything" (`chatwidget.rs` PLACEHOLDER), the footer
 * ("? for shortcuts", "100% context left", `bottom_pane/footer.rs`) and the working line "esc to interrupt". None of these is on an
 * onboarding screen, and the composer is the bottom of the screen: whatever sits above it is the conversation.
 */
const CODEX_READY_MARKERS = ['ask codex to do anything', '? for shortcuts', 'context left', 'esc to interrupt'] as const;

function lastIndexOfAny(text: string, needles: readonly string[]): number {
  return Math.max(...needles.map((needle) => text.lastIndexOf(needle)));
}

/**
 * The last place in `text` where a whole choice set shows (every needle present), or -1. A conversation can quote a sentence of a dialog,
 * but only the dialog itself has its choices together.
 */
function lastIndexOfChoiceSet(text: string, needles: readonly string[]): number {
  return needles.every((needle) => text.includes(needle)) ? Math.max(...needles.map((needle) => text.lastIndexOf(needle))) : -1;
}

/**
 * codex's "Update available" screen (`update_prompt.rs`): "Update available · 0.149.1 → 0.164.0", the choices "Update now (runs `...`)" /
 * "Skip" / "Skip until next version". Its default choice is the first one, so an Enter typed over it runs the update command.
 */
const CODEX_UPDATE_CHOICES = ['update available', 'update now', 'skip until next version'] as const;

/**
 * codex's folder trust screen: rust-v0.149.0 asks "Do you trust the contents of this directory?" with "Yes, continue" / "No, quit";
 * rust-v0.164.0 says "Trust this folder? Codex can read, edit, and run files here ..." with "Trust and continue" / "Quit".
 * (Claude Code's own "trust this folder" screen does not mention Codex and has no "trust and continue".)
 */
const CODEX_TRUST_CHOICE_SETS = [
  ['trust the contents of this directory', 'yes, continue', 'no, quit'],
  ['trust this folder?', 'trust and continue', 'quit'],
] as const;

/**
 * The codex dialog on the screen right now. A dialog is a whole choice set, and it is the current screen only when nothing of the
 * composer (placeholder, footer) shows below it: a conversation that quotes "Update available ... Skip until next version" above a live
 * composer is not one, and a dialog under an old footer in the scrollback is.
 */
function detectCodexDialog(output: string): WorkerDialog | null {
  const text = flatten(output);
  const composerAt = lastIndexOfAny(text, CODEX_READY_MARKERS);
  const update = lastIndexOfChoiceSet(text, CODEX_UPDATE_CHOICES);
  const trust = Math.max(...CODEX_TRUST_CHOICE_SETS.map((set) => lastIndexOfChoiceSet(text, set)));
  if (update > composerAt && update >= trust) return 'codex_update_prompt';
  if (trust > composerAt) return 'codex_trust_prompt';
  return null;
}

/** The dialog `kind`'s screen shows, or null when it shows none this knows. */
export function detectWorkerDialog(kind: TuiAgentKind, output: string): WorkerDialog | null {
  if (kind === 'codex') return detectCodexDialog(output);
  if (bypassDialogAt(output) >= 0) return 'bypass_permissions_dialog';
  return claudeTrustDialogAt(output) >= 0 ? 'trust_dialog' : null;
}

function isClaudeReady(output: string): boolean {
  if (bypassDialogAt(output) >= 0 || claudeTrustDialogAt(output) >= 0) return false;
  const stripped = stripAnsi(output);
  const lower = stripped.toLowerCase();
  if (lower.includes('bypass permissions') || lower.includes('shift+tab to cycle') || lower.includes('esc to interrupt')) return true;
  return stripped.includes('/help') && /Claude/i.test(stripped);
}

function isCodexReady(output: string): boolean {
  if (detectCodexDialog(output) !== null) return false;
  return lastIndexOfAny(flatten(output), CODEX_READY_MARKERS) >= 0;
}

/**
 * The agent's input screen is up. A screen that shows the live status line (Claude) or composer (Codex) below any dialog-like text is
 * ready: the text above it is the conversation quoting a dialog. A dialog with nothing live below it is not.
 */
export function isWorkerScreenReady(kind: TuiAgentKind, output: string): boolean {
  return kind === 'claude' ? isClaudeReady(output) : isCodexReady(output);
}

/** The dialog that stops the worker taking a prompt: one of `kind`'s dialogs on a screen that is not ready. */
export function blockingWorkerDialog(kind: TuiAgentKind, output: string): WorkerDialog | null {
  return isWorkerScreenReady(kind, output) ? null : detectWorkerDialog(kind, output);
}

/**
 * What the worker's input box holds right now (Issue #532). `empty`: the box is there and has nothing in it (Claude: only the `❯`, or its
 * `Try "..."` hint; codex: its placeholder). `filled`: there is text in it (a draft, or the line we typed). `disabled`: codex shows
 * "Input disabled". `unknown`: no box of a known shape is on the screen: that is never taken for empty.
 */
export type InputBox =
  | { state: 'empty' }
  | { state: 'filled'; text: string }
  | { state: 'disabled' }
  | { state: 'unknown' };

const UNKNOWN: InputBox = { state: 'unknown' };

function screenLines(output: string): string[] {
  return stripAnsi(output).split('\n').map((line) => line.replace(/\s+$/, ''));
}

function boxOf(text: string, isEmpty: (text: string) => boolean): InputBox {
  const trimmed = text.trim();
  return trimmed === '' || isEmpty(trimmed) ? { state: 'empty' } : { state: 'filled', text: trimmed };
}

const RULE_LINE = /^─{10,}$/;
/** codex's lines below the composer: the model line is after a blank line, the shortcuts / context line carries these. */
const CODEX_FOOTER_LINE = /\? for shortcuts|context left|esc to interrupt/i;

/**
 * Claude Code 2.1.x: the box is the lines between the last two horizontal rules (`────`), first line `❯ <text>`, the rest wrapped
 * continuation. Claude Code 2.0.x: a frame (`╭──╮ │ > <text> │ ╰──╯`). Anything else is `unknown`: the lines between the rules must
 * start with the prompt, and only a few status lines may follow the lower rule.
 */
function readClaudeInput(lines: string[]): InputBox {
  const rules = lines.map((line, i) => (RULE_LINE.test(line.trim()) ? i : -1)).filter((i) => i >= 0);
  if (rules.length >= 2) {
    const upper = rules[rules.length - 2];
    const lower = rules[rules.length - 1];
    const inside = lines.slice(upper + 1, lower).filter((line) => line.trim() !== '');
    const below = lines.slice(lower + 1).filter((line) => line.trim() !== '');
    if (inside.length > 0 && /^[❯>]/.test(inside[0].trim()) && below.length <= 4) {
      return boxOf([inside[0].trim().replace(/^[❯>]\s?/, ''), ...inside.slice(1).map((line) => line.trim())].join(''), (text) => text.startsWith('Try "'));
    }
    if (inside.length === 0 && below.length <= 4) return UNKNOWN;
  }
  const top = lines.map((line, i) => (line.trim().startsWith('╭') ? i : -1)).filter((i) => i >= 0).pop();
  const bottom = lines.map((line, i) => (line.trim().startsWith('╰') ? i : -1)).filter((i) => i >= 0).pop();
  if (top !== undefined && bottom !== undefined && bottom > top + 1) {
    const inside = lines.slice(top + 1, bottom).map((line) => line.trim().replace(/^│\s?/, '').replace(/\s?│$/, '').trim()).filter((line) => line !== '');
    if (inside.length > 0 && /^[❯>]/.test(inside[0])) {
      return boxOf([inside[0].replace(/^[❯>]\s?/, ''), ...inside.slice(1)].join(''), (text) => text.startsWith('Try "'));
    }
  }
  return UNKNOWN;
}

/**
 * codex: the composer starts at the last line that begins with `›` and runs to the first blank line or footer line (a wrapped draft goes
 * on indented lines, without a blank). Its empty form is the placeholder "Ask Codex to do anything"; "Input disabled..." is its refusal of input.
 */
function readCodexInput(lines: string[]): InputBox {
  const start = lines.map((line, i) => (line.startsWith('›') ? i : -1)).filter((i) => i >= 0).pop();
  if (start === undefined) return UNKNOWN;
  const composer = [lines[start].replace(/^›\s?/, '')];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || CODEX_FOOTER_LINE.test(line)) break;
    composer.push(line.trim());
  }
  const text = composer.join(' ').trim();
  if (/^input disabled/i.test(text)) return { state: 'disabled' };
  return boxOf(composer.join(''), (t) => t.toLowerCase().startsWith('ask codex to do anything'));
}

/** What the input box of `kind`'s worker holds on this screen. */
export function readInputBox(kind: TuiAgentKind, output: string): InputBox {
  const lines = screenLines(output);
  return kind === 'claude' ? readClaudeInput(lines) : readCodexInput(lines);
}

/** The file name of the prompt file in a prompt instruction line (what tells our line from any other text in the input). */
export function promptFileNameOf(instruction: string): string {
  const name = /azito-prompt-\d+-[0-9a-f]+\.md/.exec(instruction)?.[0];
  if (name === undefined) throw new Error(`Not a prompt instruction: ${instruction}`);
  return name;
}

/** Whether the input holds our instruction line, whatever the pane did to wrap it (the file name is compared without white space). */
export function inputHoldsLine(box: InputBox, instruction: string): boolean {
  if (box.state !== 'filled') return false;
  const squashed = box.text.toLowerCase().replace(/\s+/g, '');
  return squashed.includes('azitopromptfile.') && squashed.includes(promptFileNameOf(instruction).replace(/\s+/g, ''));
}
