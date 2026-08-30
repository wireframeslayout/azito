import { describe, it, expect } from 'vitest';
import {
  getVisibleSteps, canAdvanceFromStep, stepIndex, nextStep, deriveCloneDirectoryName, deriveDefaultBranch,
  pickAvailableServer, isDiscoveryCurrent, clonesDirectlyOnServer,
  type WizardValidationState,
} from './projectWizardLogic';

function makeState(overrides: Partial<WizardValidationState> = {}): WizardValidationState {
  return {
    projectName: '',
    projectSlug: '',
    selectedServer: '',
    codeMode: 'later',
    existingPath: '',
    cloneUrl: '',
    cloneDirectory: '',
    existingServerNames: [],
    discoveryReady: false,
    ...overrides,
  };
}

describe('getVisibleSteps', () => {
  it('skips the environment step when there is only one server', () => {
    expect(getVisibleSteps(1)).toEqual(['project', 'code', 'confirm']);
  });

  it('skips the environment step when there are no servers', () => {
    expect(getVisibleSteps(0)).toEqual(['project', 'code', 'confirm']);
  });

  it('includes the environment step when there are multiple servers', () => {
    expect(getVisibleSteps(2)).toEqual(['project', 'environment', 'code', 'confirm']);
  });
});

describe('canAdvanceFromStep', () => {
  it('blocks the project step until both name and slug are filled', () => {
    expect(canAdvanceFromStep('project', makeState())).toBe(false);
    expect(canAdvanceFromStep('project', makeState({ projectName: 'Widgets' }))).toBe(false);
    expect(canAdvanceFromStep('project', makeState({ projectName: 'Widgets', projectSlug: 'widgets' }))).toBe(true);
  });

  it('blocks the environment step until a server is selected', () => {
    expect(canAdvanceFromStep('environment', makeState())).toBe(false);
    expect(canAdvanceFromStep('environment', makeState({ selectedServer: 'local' }))).toBe(true);
  });

  it('blocks the environment step when the selected server is already configured for this project (Issue #87 Important finding 2)', () => {
    expect(canAdvanceFromStep('environment', makeState({ selectedServer: 'local', existingServerNames: ['local'] }))).toBe(false);
    expect(canAdvanceFromStep('environment', makeState({ selectedServer: 'remote1', existingServerNames: ['local'] }))).toBe(true);
  });

  it('requires an existing path AND a completed discovery for the current path when codeMode is "existing" (Issue #87 Important finding 3)', () => {
    expect(canAdvanceFromStep('code', makeState({ codeMode: 'existing' }))).toBe(false);
    // Path present but discovery not yet finished (or stale) must still block.
    expect(canAdvanceFromStep('code', makeState({ codeMode: 'existing', existingPath: '/work/widgets', discoveryReady: false }))).toBe(false);
    expect(canAdvanceFromStep('code', makeState({ codeMode: 'existing', existingPath: '/work/widgets', discoveryReady: true }))).toBe(true);
  });

  it('requires both a clone URL and a target directory when codeMode is "clone"', () => {
    expect(canAdvanceFromStep('code', makeState({ codeMode: 'clone' }))).toBe(false);
    expect(canAdvanceFromStep('code', makeState({ codeMode: 'clone', cloneUrl: 'git@github.com:acme/widgets.git' }))).toBe(false);
    expect(canAdvanceFromStep('code', makeState({
      codeMode: 'clone', cloneUrl: 'git@github.com:acme/widgets.git', cloneDirectory: 'widgets',
    }))).toBe(true);
  });

  it('requires nothing when codeMode is "later"', () => {
    expect(canAdvanceFromStep('code', makeState({ codeMode: 'later' }))).toBe(true);
  });

  it('never blocks the confirm step', () => {
    expect(canAdvanceFromStep('confirm', makeState())).toBe(true);
  });
});

describe('stepIndex / nextStep', () => {
  const visible = getVisibleSteps(2); // ['project', 'environment', 'code', 'confirm']

  it('reports the index of the current step within the visible steps', () => {
    expect(stepIndex(visible, 'project')).toBe(0);
    expect(stepIndex(visible, 'environment')).toBe(1);
    expect(stepIndex(visible, 'confirm')).toBe(3);
  });

  it('advances forward through visible steps only, never landing on a skipped one', () => {
    const singleServerVisible = getVisibleSteps(1); // ['project', 'code', 'confirm']
    expect(nextStep(singleServerVisible, 'project', 1)).toBe('code');
  });

  it('moves back one visible step', () => {
    expect(nextStep(visible, 'code', -1)).toBe('environment');
  });

  it('clamps at the first step (does not move before it)', () => {
    expect(nextStep(visible, 'project', -1)).toBe('project');
  });

  it('clamps at the last step (does not move past it)', () => {
    expect(nextStep(visible, 'confirm', 1)).toBe('confirm');
  });
});

describe('deriveCloneDirectoryName', () => {
  it('derives the repo name from an scp-like SSH URL', () => {
    expect(deriveCloneDirectoryName('git@github.com:acme/widgets.git')).toBe('widgets');
  });

  it('derives the repo name from an https URL without a .git suffix', () => {
    expect(deriveCloneDirectoryName('https://github.com/acme/widgets')).toBe('widgets');
  });

  it('strips a trailing slash before deriving the name', () => {
    expect(deriveCloneDirectoryName('https://github.com/acme/widgets/')).toBe('widgets');
  });

  it('returns an empty string for an empty URL', () => {
    expect(deriveCloneDirectoryName('')).toBe('');
  });
});

describe('deriveDefaultBranch', () => {
  it('uses the clone branch when codeMode is "clone"', () => {
    expect(deriveDefaultBranch('clone', 'develop')).toBe('develop');
  });

  it('falls back to "main" when codeMode is "clone" but no branch was entered', () => {
    expect(deriveDefaultBranch('clone', '')).toBe('main');
    expect(deriveDefaultBranch('clone', '   ')).toBe('main');
  });

  it('trims whitespace around the clone branch', () => {
    expect(deriveDefaultBranch('clone', '  develop  ')).toBe('develop');
  });

  it('falls back to "main" when codeMode is "existing" (discovery reports no branch info)', () => {
    expect(deriveDefaultBranch('existing', 'develop')).toBe('main');
  });

  it('falls back to "main" when codeMode is "later" (no repository at all)', () => {
    expect(deriveDefaultBranch('later', 'develop')).toBe('main');
  });
});

describe('pickAvailableServer', () => {
  it('keeps the current selection when it is still available', () => {
    expect(pickAvailableServer(['local', 'remote1'], [], 'remote1')).toBe('remote1');
  });

  it('never returns a server already configured for the project', () => {
    expect(pickAvailableServer(['local', 'remote1'], ['local'], 'local')).not.toBe('local');
  });

  it('prefers "local" among the available servers when the current selection is unavailable', () => {
    expect(pickAvailableServer(['remote1', 'local', 'remote2'], [], 'gone')).toBe('local');
  });

  it('falls back to the first available server when "local" is already configured', () => {
    expect(pickAvailableServer(['local', 'remote1'], ['local'], 'gone')).toBe('remote1');
  });

  it('returns an empty string when every server is already configured', () => {
    expect(pickAvailableServer(['local', 'remote1'], ['local', 'remote1'], 'local')).toBe('');
  });

  it('returns an empty string when there are no servers at all', () => {
    expect(pickAvailableServer([], [], '')).toBe('');
  });
});

describe('isDiscoveryCurrent', () => {
  it('is false when no discovery has resolved yet', () => {
    expect(isDiscoveryCurrent(null, 'local', '/work/widgets')).toBe(false);
  });

  it('is true when the resolved key matches the current server and (trimmed) path', () => {
    expect(isDiscoveryCurrent({ server: 'local', path: '/work/widgets' }, 'local', '/work/widgets')).toBe(true);
    expect(isDiscoveryCurrent({ server: 'local', path: '/work/widgets' }, 'local', '  /work/widgets  ')).toBe(true);
  });

  it('is false once the path has changed since the discovery that resolved (Issue #87 Important finding 3)', () => {
    expect(isDiscoveryCurrent({ server: 'local', path: '/work/widgets' }, 'local', '/work/other')).toBe(false);
  });

  it('is false once the server has changed since the discovery that resolved', () => {
    expect(isDiscoveryCurrent({ server: 'local', path: '/work/widgets' }, 'remote1', '/work/widgets')).toBe(false);
  });
});

describe('clonesDirectlyOnServer', () => {
  it('clones directly only on a local server', () => {
    expect(clonesDirectlyOnServer('local')).toBe(true);
  });

  it('does not clone directly on any other server type', () => {
    expect(clonesDirectlyOnServer('agent')).toBe(false);
    expect(clonesDirectlyOnServer('')).toBe(false);
  });
});
