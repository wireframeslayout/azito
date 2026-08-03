import type { AgentDefinition, IAgentProvider, LaunchOptions, SessionStrategyDeps } from '../AgentProvider';
import type { ISessionStrategy } from '../SessionStrategy';
import { buildCodexLaunchCommand, buildCodexHeadlessCommand } from './launchCommand';
import { CodexSessionStrategy } from './SessionStrategy';
import { collectCodexUsage } from './UsageCollector';

const definition: AgentDefinition = {
  type: 'codex',
  label: 'Codex',
  kind: 'cli',
  launchable: true,
  contexts: ['worker', 'subagent'],
  headlessCommand: 'codex exec',
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ],
};

function buildLaunchCommand(opts: LaunchOptions): string {
  return buildCodexLaunchCommand(opts);
}

function buildHeadlessCommand(model: string): string {
  return buildCodexHeadlessCommand(model);
}

function createSessionStrategy(deps: SessionStrategyDeps): ISessionStrategy {
  return new CodexSessionStrategy(deps.transportFactory);
}

export const codexProvider: IAgentProvider = {
  definition,
  buildLaunchCommand,
  buildHeadlessCommand,
  createSessionStrategy,
  collectUsage: async () => collectCodexUsage(),
};
