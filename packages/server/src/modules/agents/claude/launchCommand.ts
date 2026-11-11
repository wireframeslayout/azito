import { shellQuote } from '../../../shared/shellQuote';
import type { LaunchOptions } from '../AgentProvider';
import { extraArgValues, flag, raw, value, type LaunchArg, type ProgramLaunch } from '../WorkerLaunch';
import { CLAUDE_LAUNCH_ENV } from './suggestionEnv';

/**
 * `--strict-mcp-config` (Issue #28 design v3 §3): a task worker's tmux pane
 * inherits the operator's `~/.claude/settings.json`, whose `azt-mcp` MCP
 * server config carries the operator's full-power `AZITO_UI_TOKEN` (see
 * harness/skills/azt-mcp) — without this flag, an untrusted-input task could
 * reach that MCP server and, through it, the UI-token-authenticated API
 * surface. Measured (not assumed): task workers never actually use MCP
 * tools, only the operator's own interactive Claude Code session does, so
 * this is safe to add unconditionally, not gated behind AZITO_SCOPED_AUTH —
 * see AGENTS.md's Issue #28 Phase A scope note. Deliberately claude-only:
 * `--strict-mcp-config` is a claude-cli-specific flag, and adding it to
 * codex/generic worker launches would just be an unrecognized argument.
 */
const STRICT_MCP_CONFIG_FLAG = '--strict-mcp-config';

/**
 * `claude` started fresh, or resumed when `agentSessionId` is given (`claude --resume <id> ...`; a new session's id is added by the caller).
 * With `startNew`, the given id is the one the new conversation is created under (`claude --session-id <id> ...`): for an id whose
 * conversation was never written (Claude creates the file at the first message).
 */
export function buildClaudeLaunch({ model, extraArgs, blockMcp = true, defaultPermissionFlags = true, recordedArgs }: LaunchOptions, agentSessionId: string | null = null, startNew = false): ProgramLaunch {
  return {
    kind: 'program',
    file: 'claude',
    env: CLAUDE_LAUNCH_ENV,
    args: [
      ...(agentSessionId ? [flag(startNew ? '--session-id' : '--resume'), flag(agentSessionId)] : []),
      ...(defaultPermissionFlags ? [flag('--dangerously-skip-permissions')] : []),
      ...(blockMcp ? [flag(STRICT_MCP_CONFIG_FLAG)] : []),
      ...(recordedArgs === undefined && model ? [flag('--model'), value(model)] : []),
      ...(recordedArgs?.map(value) ?? []),
      ...(agentSessionId ? resumeExtraArgs(extraArgs) : extraArgValues(extraArgs)),
    ],
  };
}

/** A resumed launch has always carried `extraArgs` in the line as the user wrote it (the fresh one quotes each word): kept as it was. */
function resumeExtraArgs(extraArgs: string | null | undefined): LaunchArg[] {
  return extraArgs?.trim() ? [raw(extraArgs.trim())] : [];
}

/**
 * `claude attach <id>` opens a conversation the Claude Code daemon is already running, as its client (Issue #639 —
 * `--resume` of a daemon-held conversation is refused with "That session is running in the background"). Deliberately
 * bare of the flags that shape a NEW claude process (`--dangerously-skip-permissions`, `--model`,
 * `--strict-mcp-config`): they are meaningless or refused for a client of a conversation the daemon already runs with
 * its own settings. Consequence: the MCP blocking of #471 does NOT apply through this launch — the conversation runs
 * with whatever the daemon started it with. When AZITO itself first started the conversation, the daemon inherited the
 * launch flags of that start (including the MCP blocking ones; both sides unconfirmed on real versions); when the user
 * started it elsewhere, it keeps theirs. The `CLAUDE_LAUNCH_ENV` still rides on the line (same as every other claude
 * launch, #648) so the CLIENT this pane starts does not offer prompt suggestions — whether the daemon side honours it
 * is unconfirmed.
 */
export function buildClaudeAttachLaunch(attachId: string): ProgramLaunch {
  return {
    kind: 'program',
    file: 'claude',
    env: CLAUDE_LAUNCH_ENV,
    args: [flag('attach'), flag(attachId)],
  };
}

export function buildClaudeHeadlessCommand(model: string): string {
  const modelFlag = ` --model ${shellQuote(model)}`;
  return `claude -p${modelFlag}`;
}
