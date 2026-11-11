import { isValidModelId } from '@azito/shared';
import { splitCommandLine } from '../agents/WorkerLaunch';

export interface WorkerLaunchRecord {
  workerType: 'claude' | 'codex';
  args: string[];
}

// Only flags without values and flags whose values have a constrained vocabulary may be persisted.
export const RECORDABLE_LAUNCH_FLAGS = {
  claude: { boolean: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose'], values: { '--permission-mode': ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] } },
  codex: { boolean: ['--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'], values: { '--ask-for-approval': ['on-request', 'never'], '-a': ['on-request', 'never'], '--sandbox': ['read-only', 'workspace-write', 'danger-full-access'], '-s': ['read-only', 'workspace-write', 'danger-full-access'] } },
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
    if (arg === '--model' || (workerType === 'codex' && arg === '-m')) {
      const model = words[++i];
      if (!model || !isValidModelId(model)) return null;
      args.push(arg, model); continue;
    }
    const choices = (allowed.values as Record<string, readonly string[]>)[arg];
    if (!choices || !choices.includes(words[i + 1])) return null;
    args.push(arg, words[++i]);
  }
  return { workerType, args };
}
