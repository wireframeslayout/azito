import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOST_REMOVAL, deleteEntryOnly, runDeletion, type DeletionCalls, failedSteps, hostRemovalSupport, readUninstallAnswer, setRemoveFromHost, setRemoveMisao, uninstallRequestFor,
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

  it('a skipped step (misao not asked for, a hub on the host) is not a failure', () => {
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

describe('runDeletion', () => {
  const OK = { ok: true, steps: [{ id: 'task', outcome: 'done' }] };
  function calls(over: Partial<DeletionCalls> = {}): DeletionCalls & { order: string[] } {
    const order: string[] = [];
    return {
      order,
      uninstallHost: vi.fn(async () => { order.push('uninstall'); return OK; }),
      deleteRow: vi.fn(async () => { order.push('delete'); return { ok: true }; }),
      ...over,
    };
  }

  it('on by default for a Windows agent: removes the agent from the host first, then deletes the row', async () => {
    const c = calls();
    const started = vi.fn();
    expect(await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, started)).toEqual({ kind: 'deleted' });
    expect(c.order).toEqual(['uninstall', 'delete']);
    expect(c.uninstallHost).toHaveBeenCalledWith({ removeMisao: false });
    expect(started).toHaveBeenCalledOnce();
  });

  it('passes the misao choice', async () => {
    const c = calls();
    await runDeletion(c, 'windows', { removeFromHost: true, removeMisao: true }, () => undefined);
    expect(c.uninstallHost).toHaveBeenCalledWith({ removeMisao: true });
  });

  it('off: only the row is deleted, the host is not asked (an offline host can still be forgotten)', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => { throw new Error('connect ETIMEDOUT'); }) });
    const started = vi.fn();
    expect(await runDeletion(c, 'windows', { removeFromHost: false, removeMisao: false }, started)).toEqual({ kind: 'deleted' });
    expect(c.uninstallHost).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'none'] as const)('%s: only the row is deleted', async (support) => {
    const c = calls();
    expect(await runDeletion(c, support, DEFAULT_HOST_REMOVAL, () => undefined)).toEqual({ kind: 'deleted' });
    expect(c.uninstallHost).not.toHaveBeenCalled();
  });

  it('a failed step keeps the row and hands back every step', async () => {
    const steps = [{ id: 'task', outcome: 'done' }, { id: 'firewall', outcome: 'failed', detail: 'not elevated' }];
    const c = calls({ uninstallHost: vi.fn(async () => ({ ok: false, steps })) });
    expect(await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, () => undefined)).toEqual({ kind: 'hostFailed', failure: { kind: 'steps', steps } });
    expect(c.deleteRow).not.toHaveBeenCalled();
  });

  it('an unreachable host (the call throws) keeps the row, with the reason', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => { throw new Error('Unauthorized'); }) });
    expect(await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, () => undefined)).toEqual({ kind: 'hostFailed', failure: { kind: 'error', message: 'Unauthorized' } });
    expect(c.deleteRow).not.toHaveBeenCalled();
  });

  it('a refused request (an error body) keeps the row', async () => {
    const c = calls({ uninstallHost: vi.fn(async () => ({ error: 'ssh: connect to host failed' })) });
    const result = await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, () => undefined);
    expect(result).toEqual({ kind: 'hostFailed', failure: { kind: 'error', message: 'ssh: connect to host failed' } });
    expect(c.deleteRow).not.toHaveBeenCalled();
  });

  it('a row that cannot be deleted after the host was cleaned is reported, not hidden', async () => {
    const c = calls({ deleteRow: vi.fn(async () => ({ error: 'database is locked' })) });
    expect(await runDeletion(c, 'windows', DEFAULT_HOST_REMOVAL, () => undefined)).toEqual({ kind: 'rowFailed', message: 'database is locked' });
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
