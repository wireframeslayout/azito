import { describe, it, expect } from 'vitest';
import {
  getVisibleSteps, canAdvanceFromStep, stepIndex, nextStep, deriveCloneDirectoryName, deriveDefaultBranch,
  pickAvailableServer, isDiscoveryCurrent, clonesDirectlyOnServer,
  resolveCloneDeliveryMode, repoStepSignature, envStepSignature, cloneStepSignature,
  repoIdsToCleanup, reconcileDeletedRepositoryIds, cleanupStaleRepositoryIds,
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

describe('resolveCloneDeliveryMode (review finding: unresolved server type must never fall through to "distributed")', () => {
  const servers = [{ name: 'local', type: 'local' }, { name: 'remote1', type: 'ssh' }];

  it('is "none" when codeMode is not "clone" (nothing to deliver)', () => {
    expect(resolveCloneDeliveryMode('later', 'local', servers)).toBe('none');
    expect(resolveCloneDeliveryMode('existing', 'local', servers)).toBe('none');
  });

  it('is "local" when the selected server resolves to a local-type server', () => {
    expect(resolveCloneDeliveryMode('clone', 'local', servers)).toBe('local');
  });

  it('is "distributed" when the selected server resolves to a non-local type', () => {
    expect(resolveCloneDeliveryMode('clone', 'remote1', servers)).toBe('distributed');
  });

  it('is "unresolved" — never "distributed" — when no server is selected yet', () => {
    expect(resolveCloneDeliveryMode('clone', '', servers)).toBe('unresolved');
  });

  it('is "unresolved" — never "distributed" — when the selected server has no matching record yet (e.g. GET /servers still in flight)', () => {
    // The exact failure mode from the review: `selectedServer` defaults to
    // 'local' before `serverList` has loaded, so `serverList` is still `[]`
    // here — the OLD `serverList.find(...)?.type ?? ''` behavior silently
    // treated this as "not local", i.e. distributed.
    expect(resolveCloneDeliveryMode('clone', 'local', [])).toBe('unresolved');
    expect(resolveCloneDeliveryMode('clone', 'not-yet-loaded', servers)).toBe('unresolved');
  });
});

describe('repoStepSignature (review finding: completion flags must invalidate when their inputs change)', () => {
  it('is stable for the same "clone" mode inputs', () => {
    const a = repoStepSignature({ codeMode: 'clone', cloneUrl: 'https://github.com/acme/widgets', selectedRemoteUrls: [] });
    const b = repoStepSignature({ codeMode: 'clone', cloneUrl: 'https://github.com/acme/widgets', selectedRemoteUrls: [] });
    expect(a).toBe(b);
  });

  it('changes when the clone URL changes', () => {
    const a = repoStepSignature({ codeMode: 'clone', cloneUrl: 'https://github.com/acme/widgets', selectedRemoteUrls: [] });
    const b = repoStepSignature({ codeMode: 'clone', cloneUrl: 'https://github.com/acme/other', selectedRemoteUrls: [] });
    expect(a).not.toBe(b);
  });

  it('is order-independent for the selected remote URLs (a Set) in "existing" mode', () => {
    const a = repoStepSignature({ codeMode: 'existing', cloneUrl: '', selectedRemoteUrls: ['b', 'a'] });
    const b = repoStepSignature({ codeMode: 'existing', cloneUrl: '', selectedRemoteUrls: ['a', 'b'] });
    expect(a).toBe(b);
  });

  it('changes when the selected remote URLs change in "existing" mode', () => {
    const a = repoStepSignature({ codeMode: 'existing', cloneUrl: '', selectedRemoteUrls: ['a'] });
    const b = repoStepSignature({ codeMode: 'existing', cloneUrl: '', selectedRemoteUrls: ['a', 'b'] });
    expect(a).not.toBe(b);
  });
});

describe('envStepSignature / cloneStepSignature (review finding: completion flags must invalidate when their inputs change)', () => {
  it('envStepSignature changes when the working directory changes (e.g. cloneDirectory edited after a failed local clone)', () => {
    const a = envStepSignature({ selectedServer: 'local', workingDirectory: '/work/widgets', branch: 'main', distributingRepositoryId: null });
    const b = envStepSignature({ selectedServer: 'local', workingDirectory: '/work/widgets-2', branch: 'main', distributingRepositoryId: null });
    expect(a).not.toBe(b);
  });

  it('envStepSignature changes when the selected server changes', () => {
    const a = envStepSignature({ selectedServer: 'local', workingDirectory: '/work/widgets', branch: 'main', distributingRepositoryId: null });
    const b = envStepSignature({ selectedServer: 'remote1', workingDirectory: '/work/widgets', branch: 'main', distributingRepositoryId: null });
    expect(a).not.toBe(b);
  });

  it('envStepSignature changes when the distributed repository id changes (repo step re-registered a different repository)', () => {
    const a = envStepSignature({ selectedServer: 'remote1', workingDirectory: '/work/widgets', branch: 'main', distributingRepositoryId: 1 });
    const b = envStepSignature({ selectedServer: 'remote1', workingDirectory: '/work/widgets', branch: 'main', distributingRepositoryId: 2 });
    expect(a).not.toBe(b);
  });

  it('cloneStepSignature changes when cloneDirectory changes (the concrete review scenario: retry after a failed local clone with an edited target)', () => {
    const a = cloneStepSignature({ selectedServer: 'local', cloneDirectory: '/work/widgets', cloneBranch: 'main', repositoryId: 1 });
    const b = cloneStepSignature({ selectedServer: 'local', cloneDirectory: '/work/widgets-new', cloneBranch: 'main', repositoryId: 1 });
    expect(a).not.toBe(b);
  });

  it('cloneStepSignature changes when selectedServer changes', () => {
    const a = cloneStepSignature({ selectedServer: 'local', cloneDirectory: '/work/widgets', cloneBranch: 'main', repositoryId: 1 });
    const b = cloneStepSignature({ selectedServer: 'local-2', cloneDirectory: '/work/widgets', cloneBranch: 'main', repositoryId: 1 });
    expect(a).not.toBe(b);
  });

  it('is stable when nothing relevant changed', () => {
    const a = envStepSignature({ selectedServer: 'local', workingDirectory: '/work/widgets', branch: 'main', distributingRepositoryId: null });
    const b = envStepSignature({ selectedServer: 'local', workingDirectory: '/work/widgets', branch: 'main', distributingRepositoryId: null });
    expect(a).toBe(b);
  });
});

describe('repoIdsToCleanup (review finding: retrying the repository step must not duplicate rows — /repositories is append-only)', () => {
  it('returns every previously-created id to delete when the signature changed', () => {
    expect(repoIdsToCleanup([1, 2, 3], true)).toEqual([1, 2, 3]);
  });

  it('deletes nothing when the signature did not change (resume-after-a-later-step-failure)', () => {
    expect(repoIdsToCleanup([1, 2, 3], false)).toEqual([]);
  });

  it('is a no-op when nothing had been created yet', () => {
    expect(repoIdsToCleanup([], true)).toEqual([]);
  });

  it('handles a single tracked id (the "clone" mode single-repository registration path)', () => {
    expect(repoIdsToCleanup([42], true)).toEqual([42]);
  });
});

describe('reconcileDeletedRepositoryIds (Issue #87 review, Important: a non-2xx DELETE response must not drop the id from tracking)', () => {
  it('keeps ids whose DELETE did not come back 2xx', () => {
    const kept = reconcileDeletedRepositoryIds([
      { id: 1, status: 200 },
      { id: 2, status: 500 },
      { id: 3, status: 404 },
    ]);
    expect(kept).toEqual([2, 3]);
  });

  it('drops ids whose DELETE succeeded', () => {
    expect(reconcileDeletedRepositoryIds([{ id: 1, status: 200 }, { id: 2, status: 204 }])).toEqual([]);
  });

  it('is empty when there was nothing to reconcile', () => {
    expect(reconcileDeletedRepositoryIds([])).toEqual([]);
  });
});

describe('cleanupStaleRepositoryIds (Issue #87 review, Important: deletes must be validated and failures must stay tracked for retry)', () => {
  it('drops an id whose DELETE succeeds', async () => {
    const survivors = await cleanupStaleRepositoryIds([1], async () => ({ status: 200 }));
    expect(survivors).toEqual([]);
  });

  it('keeps an id whose DELETE returns a non-2xx status — apiWithStatus resolves normally on HTTP errors, so a naive .catch()-only caller would silently lose it', async () => {
    const survivors = await cleanupStaleRepositoryIds([1], async () => ({ status: 500 }));
    expect(survivors).toEqual([1]);
  });

  it('keeps an id whose DELETE call rejects outright (network failure)', async () => {
    const survivors = await cleanupStaleRepositoryIds([1], async () => { throw new Error('network down'); });
    expect(survivors).toEqual([1]);
  });

  it('resolves each id independently — one failure does not affect the others', async () => {
    const survivors = await cleanupStaleRepositoryIds([1, 2, 3], async (id) => ({ status: id === 2 ? 500 : 200 }));
    expect(survivors).toEqual([2]);
  });
});

describe('repository cleanup-before-registration ordering (Issue #87 review, Important: 削除の完了を待たずに再登録するため、リポジトリが失われる)', () => {
  // Mirrors the actual wiring in ProjectWizard.tsx: the repo-step effect
  // starts `cleanupStaleRepositoryIds` for the ids from the OLD selection
  // and stashes the promise; `handleRun`'s repository step must await that
  // exact promise before registering the NEW selection. This test drives
  // that same two-phase sequence with an artificially slow delete to prove
  // registration genuinely waits rather than merely being called after in
  // source order.
  it('never starts registration before the cleanup delete for stale ids has resolved', async () => {
    const events: string[] = [];
    let resolveDelete!: (v: { status: number }) => void;
    const deletePromise = new Promise<{ status: number }>((resolve) => { resolveDelete = resolve; });

    const cleanup = cleanupStaleRepositoryIds([1], async () => {
      events.push('delete:start');
      const result = await deletePromise;
      events.push('delete:end');
      return result;
    });

    const register = (async () => {
      await cleanup; // same gating handleRun performs via pendingRepoCleanupRef
      events.push('register:start');
      return [99];
    })();

    // The delete has started but not resolved — registration must not have
    // run yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['delete:start']);

    resolveDelete({ status: 200 });
    const registered = await register;

    expect(events).toEqual(['delete:start', 'delete:end', 'register:start']);
    expect(registered).toEqual([99]);
  });

  it('changing the selection from {A,B} to {A,C} ends with exactly A and C tracked, never losing A', async () => {
    // Old selection {A,B} -> ids [idA, idB]. User changes to {A,C}: the
    // signature changes, so a cleanup pass attempts to delete [idA, idB].
    // The bulk-discovery endpoint skips A (still present, delete not yet
    // landed for it in real timing — modeled here as A's delete failing)
    // and registers only C.
    const idA = 1;
    const idB = 2;
    const idC = 3;

    const deleteFn = async (id: number) => {
      if (id === idA) return { status: 500 }; // A's delete fails — A survives
      return { status: 200 }; // B's delete succeeds — B is gone
    };

    const survivors = await cleanupStaleRepositoryIds([idA, idB], deleteFn);
    // Registration (bulk /repositories/bulk) only ever happens after the
    // cleanup above has settled (enforced by handleRun awaiting
    // pendingRepoCleanupRef) and only creates a row for C, since A already
    // exists.
    const registeredIds = [idC];
    const finalTracked = [...survivors, ...registeredIds];

    expect(finalTracked).toEqual([idA, idC]);
    expect(finalTracked).not.toContain(idB);
  });
});
