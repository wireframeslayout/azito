import { describe, it, expect } from 'vitest';
import { isDistributeCodeLocked, isDistributionRepositorySelected, resolveDistributeCodeForSave, resolveDistributeCodeToggleValue, resolveDistributeCodeToggleOnProjectServersChange, resolveDistributionRepositoryIdToggleValue, resolveDistributionRepositoryIdOnProjectServersChange } from './distributeCodePolicy';

// Issue #87 third-party review, seventh pass, Minor finding 3: an isolated
// server distributes code unconditionally on the backend (`isolationIntent`),
// so the distribute-code toggle must be locked ON for it, and the
// project-server list badge must show even when the saved `distributeCode`
// flag is stale/false.
describe('isDistributeCodeLocked', () => {
  it('is locked (true) for an isolated server', () => {
    expect(isDistributeCodeLocked({ isolationIntent: true })).toBe(true);
  });

  it('is not locked for a non-isolated server', () => {
    expect(isDistributeCodeLocked({ isolationIntent: false })).toBe(false);
  });

  it('is not locked when isolationIntent is undefined', () => {
    expect(isDistributeCodeLocked({})).toBe(false);
  });

  it('is not locked when server itself is undefined', () => {
    expect(isDistributeCodeLocked(undefined)).toBe(false);
  });
});

// Issue #87 review, eighth pass, Important finding 1: opening/saving an
// isolated server must not persist a forced `distribute_code: true` — the
// backend distributes unconditionally regardless of this flag, so writing
// `true` here would leave a stale opt-in behind once isolation is later
// disabled.
describe('resolveDistributeCodeForSave', () => {
  it('omits the value (returns undefined) for a locked (isolated) server, regardless of the form value', () => {
    expect(resolveDistributeCodeForSave({ isolationIntent: true }, true)).toBeUndefined();
    expect(resolveDistributeCodeForSave({ isolationIntent: true }, false)).toBeUndefined();
  });

  it('passes through the user-chosen value for a non-isolated server', () => {
    expect(resolveDistributeCodeForSave({ isolationIntent: false }, true)).toBe(true);
    expect(resolveDistributeCodeForSave({ isolationIntent: false }, false)).toBe(false);
  });

  it('passes through the user-chosen value when the server is unknown', () => {
    expect(resolveDistributeCodeForSave(undefined, true)).toBe(true);
  });
});

// Issue #87 third-party review, 10th round, Minor finding 3: opening the
// project-server form before `GET /projects/:id/servers` resolves used to
// compute the toggle off an empty `projectServers` list and never correct
// itself once the real rows arrived, because ProjectSettings.tsx's effect
// deliberately excluded `projectServers` from its dependency array. Saving
// in that window silently overwrote a saved `distribute_code: true` row
// with `false`. This pure function is now the effect's single source of
// truth, and is depended on via `projectServers` directly.
describe('resolveDistributeCodeToggleValue', () => {
  it('returns false when the project-server rows have not arrived yet (empty list)', () => {
    expect(resolveDistributeCodeToggleValue('agent', [], 'server-a')).toBe(false);
  });

  it('resolves to the saved value once the matching row arrives (simulating the late fetch)', () => {
    const projectServers = [{ serverName: 'server-a', distributeCode: true }];
    expect(resolveDistributeCodeToggleValue('agent', projectServers, 'server-a')).toBe(true);
  });

  it('resolves to false when the matching row is saved with distributeCode false', () => {
    const projectServers = [{ serverName: 'server-a', distributeCode: false }];
    expect(resolveDistributeCodeToggleValue('agent', projectServers, 'server-a')).toBe(false);
  });

  it('resolves to false when no row exists for this server yet (new project-server)', () => {
    const projectServers = [{ serverName: 'server-b', distributeCode: true }];
    expect(resolveDistributeCodeToggleValue('agent', projectServers, 'server-a')).toBe(false);
  });

  it('is unconditionally false for a local server, even if a stale row says otherwise', () => {
    const projectServers = [{ serverName: 'server-a', distributeCode: true }];
    expect(resolveDistributeCodeToggleValue('local', projectServers, 'server-a')).toBe(false);
  });
});

describe('resolveDistributeCodeToggleOnProjectServersChange (Issue #87 third-party review, 11th round, Minor finding 3)', () => {
  it('re-derives from the freshly-arrived projectServers when the user has not touched the toggle', () => {
    const projectServers = [{ serverName: 'server-a', distributeCode: true }];
    expect(
      resolveDistributeCodeToggleOnProjectServersChange(false, false, 'agent', projectServers, 'server-a'),
    ).toBe(true);
  });

  it('keeps the user\'s own value when touched, even though a late projectServers response disagrees', () => {
    // User opened the form (initial value false), manually flipped the
    // toggle on (currentValue: true, touched: true), and THEN the slow
    // initial fetch resolved with the server's old saved value (false).
    const projectServers = [{ serverName: 'server-a', distributeCode: false }];
    expect(
      resolveDistributeCodeToggleOnProjectServersChange(true, true, 'agent', projectServers, 'server-a'),
    ).toBe(true);
  });

  it('keeps the user\'s edit across an unrelated later refetch while the form stays open', () => {
    // Simulates: user toggles off (currentValue: false, touched: true) after
    // the form already had the saved `true` row, then something else in the
    // component (e.g. removing a different server) triggers a projectServers
    // refetch that still reports this row as `true`.
    const projectServers = [{ serverName: 'server-a', distributeCode: true }];
    expect(
      resolveDistributeCodeToggleOnProjectServersChange(false, true, 'agent', projectServers, 'server-a'),
    ).toBe(false);
  });

  it('re-derives again once touched resets to false (form reopened for the server)', () => {
    const projectServers = [{ serverName: 'server-a', distributeCode: true }];
    expect(
      resolveDistributeCodeToggleOnProjectServersChange(false, false, 'agent', projectServers, 'server-a'),
    ).toBe(true);
  });
});

// Issue #87 review (Minor finding): a repository that was selected for
// distribution can be deleted while the project-server form is still open
// with it selected (the DB FK is set to NULL on delete, but the form's own
// local state and the stale `projectServers` list it was seeded from don't
// know that). Non-emptiness of the selected id alone used to be treated as
// "selected", which let Save submit a dangling, no-longer-existing id and
// get rejected with a 400 from the server. `isDistributionRepositorySelected`
// is the single place that now checks the id actually names a live
// repository, not just that it's non-empty.
describe('isDistributionRepositorySelected', () => {
  it('is true when the selected id names an existing repository', () => {
    expect(isDistributionRepositorySelected([{ id: 1 }, { id: 2 }], '2')).toBe(true);
  });

  it('is false when nothing is selected (empty string)', () => {
    expect(isDistributionRepositorySelected([{ id: 1 }, { id: 2 }], '')).toBe(false);
  });

  it('is false when the selected id no longer exists in repositories (deleted)', () => {
    expect(isDistributionRepositorySelected([{ id: 1 }], '2')).toBe(false);
  });

  it('is false when repositories is empty', () => {
    expect(isDistributionRepositorySelected([], '1')).toBe(false);
  });

  it('is false when repositories is undefined', () => {
    expect(isDistributionRepositorySelected(undefined, '1')).toBe(false);
  });
});

// 指摘2 (Issue #87 review, forge/87-mirror follow-up): the
// distribution-target-repository select shares the same "form opened before
// projectServers resolved" hazard `resolveDistributeCodeToggleValue`/
// `resolveDistributeCodeToggleOnProjectServersChange` were introduced for,
// but had not been fixed the same way.
describe('resolveDistributionRepositoryIdToggleValue', () => {
  it('resolves to the saved id (as a string) for the matching project-server row', () => {
    const projectServers = [{ serverName: 'server-a', distributionRepositoryId: 2 }];
    expect(resolveDistributionRepositoryIdToggleValue(projectServers, 'server-a')).toBe('2');
  });

  it('resolves to empty string when no row exists for this server yet', () => {
    const projectServers = [{ serverName: 'server-b', distributionRepositoryId: 2 }];
    expect(resolveDistributionRepositoryIdToggleValue(projectServers, 'server-a')).toBe('');
  });

  it('resolves to empty string when the row exists but distributionRepositoryId is null', () => {
    const projectServers = [{ serverName: 'server-a', distributionRepositoryId: null }];
    expect(resolveDistributionRepositoryIdToggleValue(projectServers, 'server-a')).toBe('');
  });
});

describe('resolveDistributionRepositoryIdOnProjectServersChange', () => {
  it('re-derives from the freshly-arrived projectServers when the user has not touched the field', () => {
    // Form opened before the projectServers fetch resolved (initial value
    // ''), then the response arrives with the saved repository id.
    const projectServers = [{ serverName: 'server-a', distributionRepositoryId: 3 }];
    expect(
      resolveDistributionRepositoryIdOnProjectServersChange('', false, projectServers, 'server-a'),
    ).toBe('3');
  });

  it('keeps the user\'s own selection when touched, even though a late projectServers response disagrees', () => {
    const projectServers = [{ serverName: 'server-a', distributionRepositoryId: 1 }];
    expect(
      resolveDistributionRepositoryIdOnProjectServersChange('3', true, projectServers, 'server-a'),
    ).toBe('3');
  });

  it('keeps the user\'s edit across an unrelated later refetch while the form stays open', () => {
    const projectServers = [{ serverName: 'server-a', distributionRepositoryId: 1 }];
    expect(
      resolveDistributionRepositoryIdOnProjectServersChange('', true, projectServers, 'server-a'),
    ).toBe('');
  });

  it('re-derives again once touched resets to false (form reopened for the server)', () => {
    const projectServers = [{ serverName: 'server-a', distributionRepositoryId: 4 }];
    expect(
      resolveDistributionRepositoryIdOnProjectServersChange('', false, projectServers, 'server-a'),
    ).toBe('4');
  });
});
