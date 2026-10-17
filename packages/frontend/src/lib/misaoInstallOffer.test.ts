import { describe, expect, it, vi } from 'vitest';
import { createWithMisaoInstallOffer } from './misaoInstallOffer';

const NOT_INSTALLED = { error: 'mux_kind_unavailable', kind: 'misao', reason: 'not_installed' };
const CREATED = { target: 'ws:w_1', ref: '{}' };

function deps(over: Partial<Parameters<typeof createWithMisaoInstallOffer>[1]> = {}) {
  return { confirm: vi.fn(async () => true), install: vi.fn(async () => ({ ok: true })), ...over };
}

describe('createWithMisaoInstallOffer', () => {
  it('asks nothing when the call works', async () => {
    const d = deps();
    const create = vi.fn(async () => CREATED);
    expect(await createWithMisaoInstallOffer(create, d)).toBe(CREATED);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not offer an install for any other refusal', async () => {
    const d = deps();
    for (const refusal of [
      { error: 'mux_kind_unavailable', kind: 'misao', reason: 'daemon_unreachable' },
      { error: 'mux_kind_unavailable', kind: 'tmux', reason: 'not_installed' },
      { error: 'window exists' },
    ]) {
      expect(await createWithMisaoInstallOffer(async () => refusal, d)).toBe(refusal);
    }
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it('installs after the operator agrees, then runs the call again', async () => {
    const d = deps();
    const create = vi.fn().mockResolvedValueOnce(NOT_INSTALLED).mockResolvedValueOnce(CREATED);
    expect(await createWithMisaoInstallOffer(create, d)).toBe(CREATED);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.install).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("keeps the hub's refusal when the operator declines, and installs nothing", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    const create = vi.fn(async () => NOT_INSTALLED);
    expect(await createWithMisaoInstallOffer(create, d)).toBe(NOT_INSTALLED);
    expect(d.install).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("answers with the install's error when it fails, without running the call again", async () => {
    const d = deps({ install: vi.fn(async () => ({ error: 'The agent has no node-pty', code: 'unsupported_host' })) });
    const create = vi.fn(async () => NOT_INSTALLED);
    expect(await createWithMisaoInstallOffer(create, d)).toEqual({ error: 'The agent has no node-pty' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not offer a second time when the call is refused again after the install', async () => {
    const d = deps();
    const create = vi.fn(async () => NOT_INSTALLED);
    expect(await createWithMisaoInstallOffer(create, d)).toBe(NOT_INSTALLED);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
