import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOST_REMOVAL, deleteEntryOnly, deletionReducer, failedSteps, hostRemovalSupport, IDLE_DELETION, isDeletionBusy, readUninstallAnswer,
  runDeletion, runEntryOnly, setRemoveFromHost, setRemoveMisao, uninstallRequestFor,
  type DeletionCalls, type DeletionEvent, type DeletionState,
} from './serverDeletion';

describe('hostRemovalSupport', () => {
  it('a Windows agent can be removed from its host', () => {
    expect(hostRemovalSupport({ type: 'agent', hostProfile: { platform: 'win32', arch: 'x64' } })).toBe('windows');
  });

  it.each([
    ['a Linux agent', { type: 'agent', hostProfile: { platform: 'linux', arch: 'x64' } }],
    ['a macOS agent', { type: 'agent', hostProfile: { platform: 'darwin', arch: 'arm64' } }],
    ['an agent whose OS was never recorded', { type: 'agent', hostProfile: null }],
    ['an agent with no host profile field', { type: 'agent' }],
  ] as const)('%s is not supported in this release (#499)', (_label, server) => {
    expect(hostRemovalSupport(server)).toBe('unsupported');
  });

  it.each(['local', 'ssh'])('a %s server has no agent to remove', (type) => {
    expect(hostRemovalSupport({ type, hostProfile: { platform: 'win32', arch: 'x64' } })).toBe('none');
  });
});

describe('the default choice', () => {
  it('removes the agent from the host and leaves the misao', () => {
    expect(DEFAULT_HOST_REMOVAL).toEqual({ removeFromHost: true, removeMisao: false });
  });

  it('sends the uninstall request for a Windows agent, with the misao choice', () => {
    expect(uninstallRequestFor('windows', DEFAULT_HOST_REMOVAL)).toEqual({ removeMisao: false });
    expect(uninstallRequestFor('windows', { removeFromHost: true, removeMisao: true })).toEqual({ removeMisao: true });
  });

  it('sends nothing (only the row is deleted) when the host is not to be touched, or cannot be', () => {
    expect(uninstallRequestFor('windows', { removeFromHost: false, removeMisao: false })).toBeNull();
    expect(uninstallRequestFor('unsupported', DEFAULT_HOST_REMOVAL)).toBeNull();
    expect(uninstallRequestFor('none', DEFAULT_HOST_REMOVAL)).toBeNull();
  });
});

describe('the misao choice depends on the host choice', () => {
  it('turning the host removal off turns the misao off too', () => {
    expect(setRemoveFromHost({ removeFromHost: true, removeMisao: true }, false)).toEqual({ removeFromHost: false, removeMisao: false });
  });

  it('turning the host removal on keeps the misao choice', () => {
    expect(setRemoveFromHost({ removeFromHost: false, removeMisao: false }, true)).toEqual({ removeFromHost: true, removeMisao: false });
  });

  it('the misao cannot be chosen without the host removal', () => {
    expect(setRemoveMisao({ removeFromHost: false, removeMisao: false }, true)).toEqual({ removeFromHost: false, removeMisao: false });
    expect(setRemoveMisao({ removeFromHost: true, removeMisao: false }, true)).toEqual({ removeFromHost: true, removeMisao: true });
  });
});

describe('readUninstallAnswer', () => {
  const okSteps = [{ id: 'task', outcome: 'done' }, { id: 'folder', outcome: 'absent' }];

  it('is null (the agent is off the host) only for ok: true with well-formed steps', () => {
    expect(readUninstallAnswer({ ok: true, steps: okSteps })).toBeNull();
  });

  it('a skipped step (misao not asked for, a hub owns it) is not a failure', () => {
    expect(readUninstallAnswer({ ok: true, steps: [{ id: 'misaoTask', outcome: 'skipped', detail: 'a hub owns it' }] })).toBeNull();
  });

  it('gives the steps back when one failed', () => {
    const steps = [{ id: 'task', outcome: 'done' }, { id: 'firewall', outcome: 'failed', detail: 'not elevated' }];
    const failure = readUninstallAnswer({ ok: false, steps });
    expect(failure).toEqual({ kind: 'steps', steps });
    if (failure?.kind === 'steps') expect(failedSteps(failure.steps)).toEqual([steps[1]]);
  });

  it.each([
    ['ok: true without steps', { ok: true }],
    ['ok: true with steps it cannot read', { ok: true, steps: [{ id: 'nope', outcome: 'done' }] }],
    ['ok: true with an unknown outcome', { ok: true, steps: [{ id: 'task', outcome: 'fine' }] }],
    ['an empty object', {}],
    ['nothing', null],
  ])('does not take %s for a success', (_label, body) => {
    expect(readUninstallAnswer(body)).not.toBeNull();
  });

  it('carries the hub\'s reason for an answer that is an error (host unreachable, refused for its OS)', () => {
    expect(readUninstallAnswer({ error: 'Removing the agent from its host is only supported for Windows agents (#499)', code: 'unsupported_os' }))
      .toEqual({ kind: 'error', message: 'Removing the agent from its host is only supported for Windows agents (#499)' });
    expect(readUninstallAnswer({ error: 'operator_required', operation: 'servers.agent_uninstall' })).toEqual({ kind: 'error', message: 'operator_required' });
  });
});

/** The screen's state, driven by the events the flow sends (what the hook does with `useReducer`). */
function screen(initial: DeletionState = IDLE_DELETION) {
  const history: DeletionState[] = [];
  let state = initial;
  const events: DeletionEvent[] = [];
  const dispatch = (event: DeletionEvent): void => {
    events.push(event);
    state = deletionReducer(state, event);
    history.push(state);
  };
  return { dispatch, get state() { return state; }, history, events };
}

const OK = { ok: true, steps: [{ id: 'task', outcome: 'done' }] };
const FAILED_STEPS = [{ id: 'task', outcome: 'done' }, { id: 'firewall', outcome: 'failed', detail: 'not elevated' }];
function calls(over: Partial<DeletionCalls> = {}): DeletionCalls {
  return {
    uninstallHost: vi.fn(async () => OK),
    deleteRow: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

describe('the state of the confirmation', () => {
  it('opens with the defaults, and cancel goes back to idle', () => {
    const s = screen();
    s.dispatch({ type: 'open' });
    expect(s.state).toMatchObject({ phase: 'confirming', choice: DEFAULT_HOST_REMOVAL, failure: null, rowError: null, deletingRow: false });
    s.dispatch({ type: 'cancel' });
    expect(s.state).toEqual(IDLE_DELETION);
  });

  it('the choices follow the rules (the misao needs the host removal) and are fixed while something is in flight', () => {
    const s = screen();
    s.dispatch({ type: 'open' });
    s.dispatch({ type: 'chooseRemoveMisao', value: true });
    expect(s.state.choice).toEqual({ removeFromHost: true, removeMisao: true });
    s.dispatch({ type: 'chooseRemoveFromHost', value: false });
    expect(s.state.choice).toEqual({ removeFromHost: false, removeMisao: false });
    s.dispatch({ type: 'chooseRemoveMisao', value: true });
    expect(s.state.choice.removeMisao).toBe(false);
    s.dispatch({ type: 'chooseRemoveFromHost', value: true });
    s.dispatch({ type: 'removingHost' });
    expect(isDeletionBusy(s.state)).toBe(true);
    s.dispatch({ type: 'chooseRemoveMisao', value: true });
    expect(s.state.choice.removeMisao).toBe(false);
    s.dispatch({ type: 'cancel' });
    expect(s.state.phase).toBe('removingHost');
  });

  it('opening again while it is open changes nothing', () => {
    const s = screen();
    s.dispatch({ type: 'open' });
    s.dispatch({ type: 'chooseRemoveMisao', value: true });
    s.dispatch({ type: 'open' });
    expect(s.state.choice.removeMisao).toBe(true);
  });
});

describe('runDeletion', () => {
  it('on by default for a Windows agent: removes the agent from the host first, then deletes the row, and the screen ends idle', async () => {
    const c = calls();
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    expect(s.events.map((e) => e.type)).toEqual(['removingHost', 'deletingRow', 'result']);
    expect(s.history[0]).toMatchObject({ phase: 'removingHost' });
    expect(s.history[1]).toMatchObject({ phase: 'confirming', deletingRow: true });
    expect(s.state).toEqual(IDLE_DELETION);
    expect(c.uninstallHost).toHaveBeenCalledWith({ removeMisao: false });
    expect(c.deleteRow).toHaveBeenCalledOnce();
  });

  it('passes the misao choice', async () => {
    const c = calls();
    await runDeletion(c, 'windows', { removeFromHost: true, removeMisao: true }, () => undefined);
    expect(c.uninstallHost).toHaveBeenCalledWith({ removeMisao: true });
  });

  it('off: only the row is deleted, the host is not asked (an offline host can still be forgotten)', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => { throw new Error('connect ETIMEDOUT'); }) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', { removeFromHost: false, removeMisao: false }, s.dispatch);
    expect(c.uninstallHost).not.toHaveBeenCalled();
    expect(s.events.map((e) => e.type)).toEqual(['deletingRow', 'result']);
    expect(s.state).toEqual(IDLE_DELETION);
  });

  it.each(['unsupported', 'none'] as const)('%s: only the row is deleted', async (support) => {
    const c = calls();
    await runDeletion(c, support, DEFAULT_HOST_REMOVAL, () => undefined);
    expect(c.uninstallHost).not.toHaveBeenCalled();
    expect(c.deleteRow).toHaveBeenCalledOnce();
  });

  it('a failed step keeps the row and keeps every step on the screen', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => ({ ok: false, steps: FAILED_STEPS })) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    expect(c.deleteRow).not.toHaveBeenCalled();
    expect(s.state).toMatchObject({ phase: 'hostFailed', failure: { kind: 'steps', steps: FAILED_STEPS }, rowError: null, deletingRow: false });
  });

  it('an unreachable host (the call throws) keeps the row, with the reason', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => { throw new Error('Unauthorized'); }) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    expect(c.deleteRow).not.toHaveBeenCalled();
    expect(s.state).toMatchObject({ phase: 'hostFailed', failure: { kind: 'error', message: 'Unauthorized' } });
  });

  it('a refused request (an error body) keeps the row', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => ({ error: 'ssh: connect to host failed' })) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    expect(c.deleteRow).not.toHaveBeenCalled();
    expect(s.state).toMatchObject({ phase: 'hostFailed', failure: { kind: 'error', message: 'ssh: connect to host failed' } });
  });

  it('a row that cannot be deleted after the host was cleaned is reported on the choices screen, not hidden', async () => {
    const c = calls({ deleteRow: vi.fn(async () => ({ error: 'database is locked' })) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    expect(s.state).toMatchObject({ phase: 'confirming', rowError: 'database is locked', deletingRow: false, failure: null });
  });
});

describe('the failure screen across the steps that follow it', () => {
  it('host removal fails, then "delete the entry only" fails too: the failure and the row\'s reason are both there, with the three choices still possible', async () => {
    const c = calls({
      uninstallHost: vi.fn(async () => ({ ok: false, steps: FAILED_STEPS })),
      deleteRow: vi.fn(async () => ({ error: 'database is locked' })),
    });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    const afterHost = s.state;
    expect(afterHost).toMatchObject({ phase: 'hostFailed', failure: { kind: 'steps' } });

    const pending = runEntryOnly(c, s.dispatch);
    // While the entry is being deleted the host failure is still there (it used to be cleared, which left an empty screen).
    expect(s.state).toMatchObject({ phase: 'hostFailed', failure: afterHost.failure, deletingRow: true, rowError: null });
    expect(isDeletionBusy(s.state)).toBe(true);
    await pending;

    expect(s.state).toMatchObject({ phase: 'hostFailed', failure: afterHost.failure, deletingRow: false, rowError: 'database is locked' });
    expect(isDeletionBusy(s.state)).toBe(false);
    // The person can still cancel, and try again.
    const retry = vi.fn(async () => OK);
    c.uninstallHost = retry;
    c.deleteRow = vi.fn(async () => ({ ok: true }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    expect(retry).toHaveBeenCalledOnce();
    expect(s.state).toEqual(IDLE_DELETION);
  });

  it('a retry that fails again replaces the failure with the new one', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => ({ ok: false, steps: FAILED_STEPS })) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    const second = [{ id: 'folder', outcome: 'failed', detail: 'in use' }];
    c.uninstallHost = vi.fn(async () => ({ ok: false, steps: second }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    expect(s.state).toMatchObject({ phase: 'hostFailed', failure: { kind: 'steps', steps: second } });
  });

  it('cancel on the failure screen goes back to idle; it is refused while a deletion is in flight', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => ({ ok: false, steps: FAILED_STEPS })) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    s.dispatch({ type: 'deletingRow' });
    s.dispatch({ type: 'cancel' });
    expect(s.state.phase).toBe('hostFailed');
    s.dispatch({ type: 'result', result: { kind: 'rowFailed', message: 'x' } });
    s.dispatch({ type: 'cancel' });
    expect(s.state).toEqual(IDLE_DELETION);
  });

  it('deleting the entry only, after the failure, ends idle when it works', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => ({ ok: false, steps: FAILED_STEPS })) });
    const s = screen(deletionReducer(IDLE_DELETION, { type: 'open' }));
    await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, s.dispatch);
    await runEntryOnly(c, s.dispatch);
    expect(s.state).toEqual(IDLE_DELETION);
    expect(c.deleteRow).toHaveBeenCalledOnce();
  });
});

describe('deleteEntryOnly', () => {
  it('deletes the row without asking the host', async () => {
    const uninstallHost = vi.fn();
    expect(await deleteEntryOnly({ uninstallHost, deleteRow: async () => ({ ok: true }) })).toEqual({ kind: 'deleted' });
    expect(uninstallHost).not.toHaveBeenCalled();
  });

  it('reports a failure of the call', async () => {
    expect(await deleteEntryOnly({ uninstallHost: vi.fn(), deleteRow: async () => { throw new Error('network down'); } })).toEqual({ kind: 'rowFailed', message: 'network down' });
  });
});
