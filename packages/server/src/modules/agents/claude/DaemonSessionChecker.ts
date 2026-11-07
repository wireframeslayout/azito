import { buildCommandSpec, type CommandResult } from '../../../shared/exec/commandSpec';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';

/**
 * What asking the server's own `claude agents --json` said about one recorded conversation id (Issue #540):
 * - `attach`  — the Claude Code daemon holds this conversation (it survives a closed pane, and `claude --resume`
 *   refuses it with "That session is running in the background"). Open it with `claude attach <id>` instead.
 * - `resume`  — the daemon does not hold it; `--resume` is the right launch, as before.
 * - `unknown` — the CLI could not be asked (missing, failed, or unreadable output). `--resume` proceeds as before:
 *   the `agents` listing and the daemon that keeps conversations in the background entered Claude Code together, so
 *   a CLI without one cannot hold a conversation the other refuses to resume. The reason is kept so the caller can
 *   log it — the answer is never swallowed silently.
 */
export type DaemonSessionVerdict =
  | { status: 'attach'; attachId: string }
  | { status: 'resume' }
  | { status: 'unknown'; reason: string };

/** One entry of `claude agents --json`. Only the fields the check reads; anything else is passed through. */
export interface ClaudeAgentsEntry {
  id?: unknown;
  kind?: unknown;
  state?: unknown;
  sessionId?: unknown;
  [key: string]: unknown;
}

/** Parses the JSON array `claude agents --json` prints. Throws on anything else (the caller turns that into `unknown`). */
export function parseAgentsJson(stdout: string): ClaudeAgentsEntry[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
  return parsed;
}

/**
 * The entry the daemon holds for exactly this conversation: `kind: "background"` (an interactive session in another
 * window is a different conversation of the same id) whose `sessionId` EQUALS the recorded one — never a prefix match,
 * so a shorter id of another conversation cannot be taken for this one.
 */
export function matchBackgroundSession(entries: ClaudeAgentsEntry[], sessionId: string): ClaudeAgentsEntry | null {
  for (const entry of entries) {
    if (
      entry && typeof entry === 'object' &&
      entry.kind === 'background' &&
      typeof entry.sessionId === 'string' && entry.sessionId === sessionId
    ) return entry;
  }
  return null;
}

/**
 * The id `claude attach` takes for this conversation: the `id` the listing printed, or — when an entry omits it — the
 * first 8 characters of the session id (the short form the CLI itself prints, which `attach` also accepts as a prefix).
 * A printed id is only taken when it is one plain word of letters, digits, `_` and `-` (no whitespace, no shell or
 * cmd.exe metacharacter): it is typed into a pane's shell line unquoted, so anything else falls back to the session
 * id's own hex prefix, which is always safe.
 */
export function attachIdOf(entry: ClaudeAgentsEntry, sessionId: string): string {
  if (typeof entry.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.id)) return entry.id;
  return sessionId.slice(0, 8);
}

/** How long `claude agents --json` gets to answer before the check gives up and lets the resume go ahead. */
const CHECK_TIMEOUT_MS = 8_000;
const CHECK_MAX_OUTPUT_BYTES = 1_000_000;

function failureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refusedReason(result: CommandResult): string {
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  return `claude agents --json exited with code ${result.exitCode}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}

/**
 * Whether the server's Claude Code daemon holds a recorded conversation, asked by running `claude agents --json` on
 * that server (no shell; the same `CommandSpec` path as every other host command — on a win32 host the bare `claude`
 * cannot be spawned, which the check reports as `unknown` and the resume proceeds, so a Windows hub keeps its current
 * behaviour). When the window records the conversation's own `CLAUDE_CONFIG_DIR`, the check runs with it too: the
 * daemon registers background sessions under the config directory that started them, so the listing of the default
 * one would not name such a conversation (observed on 2.1.319; the flag may not exist on every version — the same
 * `unknown` answer covers that).
 */
export class DaemonSessionChecker {
  constructor(private readonly transportFactory: TransportFactory) {}

  async check(server: ServerConfig, sessionId: string, claudeConfigDir?: string | null): Promise<DaemonSessionVerdict> {
    let result: CommandResult;
    try {
      result = await this.transportFactory.getTransport(server).run(
        buildCommandSpec('claude', ['agents', '--json'], {
          timeoutMs: CHECK_TIMEOUT_MS,
          maxOutputBytes: CHECK_MAX_OUTPUT_BYTES,
          ...(claudeConfigDir ? { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } } : {}),
        }),
      );
    } catch (err) {
      return { status: 'unknown', reason: `claude agents --json could not be run: ${failureReason(err)}` };
    }
    if (result.exitCode !== 0) return { status: 'unknown', reason: refusedReason(result) };
    let entries: ClaudeAgentsEntry[];
    try {
      entries = parseAgentsJson(result.stdout);
    } catch (err) {
      return { status: 'unknown', reason: `claude agents --json output could not be read: ${failureReason(err)}` };
    }
    const entry = matchBackgroundSession(entries, sessionId);
    if (!entry) return { status: 'resume' };
    return { status: 'attach', attachId: attachIdOf(entry, sessionId) };
  }
}
