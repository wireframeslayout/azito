import { shellQuote } from '../shellQuote';
import type { LaunchOptions } from '../AgentProvider';

export function buildCodexLaunchCommand({ model, extraArgs }: LaunchOptions): string {
  const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
  const extra = extraArgs?.trim()
    ? ' ' + extraArgs.trim().split(/\s+/).map(shellQuote).join(' ')
    : '';
  return `codex --dangerously-bypass-approvals-and-sandbox${modelFlag}${extra}`;
}

export function buildCodexHeadlessCommand(model: string): string {
  const modelFlag = ` --model ${shellQuote(model)}`;
  return `codex exec${modelFlag}`;
}
