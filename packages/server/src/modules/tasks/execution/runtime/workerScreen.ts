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

/** The start of the one line a prompt is delivered as (see PromptFileDelivery), as `squash` writes it. */
const PROMPT_LINE_START = 'azitopromptfile.';
/** The prompt file's name inside that line. */
const PROMPT_FILE_NAME = /azito-prompt-\d+-[0-9a-f]+\.md/;
/** The most text that can follow the end of our line on a screen whose input still holds it: the footer / status lines. */
const PENDING_TAIL_CHARS = 400;

/** Lower-cased with every whitespace gone: the pane wraps a long line wherever it likes, so a line is only comparable without its breaks. */
function squash(output: string): string {
  return flatten(output).replace(/ /g, '');
}

/**
 * Whether the worker's input still holds our one-line prompt instruction: typed, not submitted (Issue #532: an Enter that was taken for
 * part of a paste, so the line sits in the input box and nothing runs). With `instruction`, that very line (its file name); without, any
 * such line (what an earlier prompt left behind). The line is in the input, not in the conversation, when the screen below it has nothing
 * but the footer: no working line ("esc to interrupt"), no reply, and for codex not its empty-composer placeholder.
 * Claude is told from the conversation by the same measure alone (its echo of a submitted message is followed by the working line almost
 * at once), so a stale line is only looked for in codex's input before a prompt is sent (`checkStale`).
 */
export function isPromptPendingInInput(kind: TuiAgentKind, output: string, instruction?: string): boolean {
  const text = squash(output);
  const start = text.lastIndexOf(PROMPT_LINE_START);
  if (start < 0) return false;
  let end = start + PROMPT_LINE_START.length;
  if (instruction) {
    const name = PROMPT_FILE_NAME.exec(instruction)?.[0];
    if (name === undefined) return false;
    const at = text.lastIndexOf(squash(name));
    if (at < start) return false;
    end = at + squash(name).length;
  } else {
    const md = text.indexOf('.md', start);
    if (md >= 0) end = md + 3;
  }
  const tail = text.slice(end);
  if (tail.includes('esctointerrupt')) return false;
  if (kind === 'codex' && tail.includes('askcodextodoanything')) return false;
  const prefix = text.slice(Math.max(0, start - 3), start);
  if (!(kind === 'codex' ? prefix.includes('›') : /[>❯]/.test(prefix))) return false;
  return tail.length < PENDING_TAIL_CHARS;
}

/** A line of an earlier prompt left in codex's input box (Claude's input is not read for this: see {@link isPromptPendingInInput}). */
export function hasStalePromptInInput(kind: TuiAgentKind, output: string): boolean {
  return kind === 'codex' && isPromptPendingInInput(kind, output);
}
