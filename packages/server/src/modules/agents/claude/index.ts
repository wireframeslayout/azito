import type { AgentDefinition, IAgentProvider, LaunchOptions, SessionStrategyDeps } from '../AgentProvider';
import type { ISessionStrategy } from '../SessionStrategy';
import { buildClaudeLaunchCommand, buildClaudeHeadlessCommand } from './launchCommand';
import { ClaudeSessionStrategy } from './SessionStrategy';
import { collectClaudeUsage } from './UsageCollector';

const definition: AgentDefinition = {
  type: 'claude',
  label: 'Claude Code',
  kind: 'cli',
  launchable: true,
  contexts: ['worker', 'subagent'],
  headlessCommand: 'claude -p',
  models: [
    { id: 'opus', label: 'Opus (latest)' },
    { id: 'sonnet', label: 'Sonnet (latest)' },
    { id: 'haiku', label: 'Haiku (latest)' },
    { id: 'fable', label: 'Fable (latest)' },

    { id: 'claude-opus-5', label: 'Opus 5 — 200K ctx' },
    { id: 'claude-opus-5[1m]', label: 'Opus 5 — 1M ctx' },
    { id: 'claude-fable-5', label: 'Fable 5 — 1M ctx' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8 — 1M ctx' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5 — 1M ctx' },

    { id: 'claude-opus-4-7', label: 'Opus 4.7 — 1M ctx' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6 — 200K ctx' },
    { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 — 1M ctx' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — 200K ctx' },
    { id: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 — 1M ctx' },

    { id: 'claude-sonnet-4-5-20250514', label: 'Sonnet 4.5 — 200K ctx' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — 200K ctx' },
  ],
};

function buildLaunchCommand(opts: LaunchOptions): string {
  return buildClaudeLaunchCommand(opts);
}

function buildHeadlessCommand(model: string): string {
  return buildClaudeHeadlessCommand(model);
}

function createSessionStrategy(deps: SessionStrategyDeps): ISessionStrategy {
  return new ClaudeSessionStrategy(deps.transportFactory);
}

export const claudeProvider: IAgentProvider = {
  definition,
  buildLaunchCommand,
  buildHeadlessCommand,
  createSessionStrategy,
  collectUsage: async () => collectClaudeUsage(),
};
