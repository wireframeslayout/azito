import type { AgentDefinition, IAgentProvider, LaunchOptions } from '../AgentProvider';
import { commandLineLaunch, type WorkerLaunch } from '../WorkerLaunch';

const definition: AgentDefinition = {
  type: 'generic',
  label: 'Generic',
  kind: 'cli',
  launchable: false,
  contexts: ['worker'],
  headlessCommand: null,
  models: [],
};

function buildLaunch({ extraArgs }: LaunchOptions): WorkerLaunch | null {
  const line = extraArgs?.trim();
  return line ? commandLineLaunch(line) : null;
}

function buildHeadlessCommand(): null {
  return null;
}

function createSessionStrategy(): null {
  return null;
}

export const genericProvider: IAgentProvider = {
  definition,
  buildLaunch,
  buildHeadlessCommand,
  createSessionStrategy,
};
