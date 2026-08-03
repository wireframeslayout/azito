import type { AgentDefinition, IAgentProvider, LaunchOptions } from '../AgentProvider';

const definition: AgentDefinition = {
  type: 'generic',
  label: 'Generic',
  kind: 'cli',
  launchable: false,
  contexts: ['worker'],
  headlessCommand: null,
  models: [],
};

function buildLaunchCommand({ extraArgs }: LaunchOptions): string | null {
  return extraArgs?.trim() || null;
}

function buildHeadlessCommand(): null {
  return null;
}

function createSessionStrategy(): null {
  return null;
}

export const genericProvider: IAgentProvider = {
  definition,
  buildLaunchCommand,
  buildHeadlessCommand,
  createSessionStrategy,
};
