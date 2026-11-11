import { splitCommandLine, type LaunchArg, type ProgramLaunch, flag, value } from '../agents/WorkerLaunch';
import { CLAUDE_LAUNCH_ENV } from '../agents/claude/suggestionEnv';
import type { RespawnConversation } from '../agents/SessionStrategy';
import { CODEX_MCP_DISABLE_TEXTS, CODEX_NO_UPDATE_CHECK_TEXT } from '../agents/codex/launchCommand';

export interface WorkerLaunchRecord {
  workerType: 'claude' | 'codex';
  args: string[];
}

// Only flags without values and flags whose values have a constrained vocabulary may be persisted.
export const RECORDABLE_LAUNCH_FLAGS = {
  claude: { boolean: ['--dangerously-skip-permissions', '--verbose'], values: { '--permission-mode': ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] } },
  codex: { boolean: ['--full-auto', '--dangerously-bypass-approvals-and-sandbox'], values: { '--ask-for-approval': ['untrusted', 'on-failure', 'on-request', 'never'], '--sandbox': ['read-only', 'workspace-write', 'danger-full-access'] } },
} as const;

export function parseWorkerLaunchRecord(command: string): WorkerLaunchRecord | null {
  if (command.includes('\\')) return null;
  let words: string[];
  try { words = splitCommandLine(command); } catch { return null; }
  const workerType = words.shift();
  if (workerType !== 'claude' && workerType !== 'codex') return null;
  const allowed = RECORDABLE_LAUNCH_FLAGS[workerType];
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const arg = words[i];
    if ((allowed.boolean as readonly string[]).includes(arg)) { args.push(arg); continue; }
    if (workerType === 'claude' && (arg === '--session-id' || arg === '--resume')) {
      const session = words[++i];
      if (!session || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) return null;
      continue;
    }
    if (arg === '--model' || arg === '-m') {
      const model = words[++i];
      if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(model)) return null;
      args.push(arg, model); continue;
    }
    const choices = (allowed.values as Record<string, readonly string[]>)[arg];
    if (!choices || !choices.includes(words[i + 1])) return null;
    args.push(arg, words[++i]);
  }
  return { workerType, args };
}

/**
 * The recorded arguments, or — with no record of this worker type — only the window's stored model (validated when it was saved).
 * Without a record no permission flag is added: an unrecorded launch is reopened on the safe side.
 */
function recordedArgs(record: WorkerLaunchRecord | null, workerType: WorkerLaunchRecord['workerType'], windowModel: string | null): LaunchArg[] {
  if (record?.workerType === workerType) return record.args.map(value);
  return windowModel ? [flag('--model'), value(windowModel)] : [];
}

export function buildRecordedClaudeLaunch(record: WorkerLaunchRecord | null, windowModel: string | null, sessionId: string | null, blockMcp: boolean, conversation: RespawnConversation = 'resume', attachId: string | null = null): ProgramLaunch {
  if (conversation === 'attach' && (attachId || sessionId)) return { kind: 'program', file: 'claude', env: CLAUDE_LAUNCH_ENV, args: [flag('attach'), flag(attachId || sessionId!.slice(0, 8))] };
  return { kind: 'program', file: 'claude', env: CLAUDE_LAUNCH_ENV, args: [
    ...(sessionId ? [flag(conversation === 'new' ? '--session-id' : '--resume'), flag(sessionId)] : []),
    ...(blockMcp ? [flag('--strict-mcp-config')] : []),
    ...recordedArgs(record, 'claude', windowModel),
  ] };
}

export function buildRecordedCodexLaunch(record: WorkerLaunchRecord | null, windowModel: string | null, sessionId: string | null, blockMcp: boolean): ProgramLaunch {
  return { kind: 'program', file: 'codex', args: [
    ...(sessionId ? [flag('resume'), flag(sessionId)] : []),
    flag('-c'), flag(CODEX_NO_UPDATE_CHECK_TEXT),
    ...(blockMcp ? CODEX_MCP_DISABLE_TEXTS.flatMap((text) => [flag('-c'), flag(text)]) : []),
    ...recordedArgs(record, 'codex', windowModel),
  ] };
}
