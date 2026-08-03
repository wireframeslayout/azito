import { shellQuote } from '../shellQuote';
import type { LaunchOptions } from '../AgentProvider';

export function buildClaudeLaunchCommand({ model, extraArgs }: LaunchOptions): string {
  const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
  const extra = extraArgs?.trim()
    ? ' ' + extraArgs.trim().split(/\s+/).map(shellQuote).join(' ')
    : '';
  return `claude --dangerously-skip-permissions${modelFlag}${extra}`;
}

export function buildClaudeHeadlessCommand(model: string): string {
  const modelFlag = ` --model ${shellQuote(model)}`;
  return `claude -p${modelFlag}`;
}
