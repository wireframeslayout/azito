import { describe, it, expect, vi } from 'vitest';
import type { MuxDriverKind } from '@azito/shared';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { AmbiguousWindowKindError, rawTargetProbeOf, resolveRawTarget, resolveStoredWindowKind } from './storedWindowKind';

const WIN = 'w_01M3XFD8H97JCPKS5Y5BH3JZQH';
const local = { name: 'local', type: 'local', defaultMux: 'misao', muxRuntime: 'system' } as ServerConfig;
const agent = { name: 'box', type: 'agent', defaultMux: 'tmux', muxRuntime: 'system' } as ServerConfig;

function registryWith(has: { tmux: boolean; misao: boolean }, misaoUp = true): MuxDriverRegistry {
  const registry = new MuxDriverRegistry();
  const driver = (kind: MuxDriverKind) => ({
    kind,
    windowExists: vi.fn(async () => has[kind]),
    resolveRef: vi.fn(async (_s: unknown, target: string) => (has[kind] ? { kind, workspace: target.split(':')[0], window: target.split(':')[1] } : null)),
  }) as unknown as IMuxClient;
  registry.register('tmux', driver('tmux'));
  registry.register('misao', driver('misao'), () => (misaoUp ? { available: true } : { available: false, reason: 'daemon_unreachable' }));
  return registry;
}

describe('resolveStoredWindowKind', () => {
  it('uses the primary row: its ref kind, tmux when the row has no ref (no lookup)', async () => {
    const registry = registryWith({ tmux: true, misao: true });
    expect(await resolveStoredWindowKind(registry, local, { muxRef: { kind: 'misao', workspace: 'ws', window: WIN } }, 'ws', WIN)).toBe('misao');
    expect(await resolveStoredWindowKind(registry, local, {}, 'ws', WIN)).toBe('tmux');
  });

  it('without a row, takes the mux that has the window on a server hosting both', async () => {
    expect(await resolveStoredWindowKind(registryWith({ tmux: false, misao: true }), local, undefined, 'ws', WIN)).toBe('misao');
    expect(await resolveStoredWindowKind(registryWith({ tmux: true, misao: false }), local, undefined, 'ws', WIN)).toBe('tmux');
  });

  it('without a row, throws when both muxes have the window', async () => {
    await expect(resolveStoredWindowKind(registryWith({ tmux: true, misao: true }), local, undefined, 'ws', WIN)).rejects.toBeInstanceOf(AmbiguousWindowKindError);
  });

  it('without a row, reads a window neither mux has as tmux, but cannot tell while a mux is down', async () => {
    expect(await resolveStoredWindowKind(registryWith({ tmux: false, misao: false }), local, undefined, 'ws', WIN)).toBe('tmux');
    await expect(resolveStoredWindowKind(registryWith({ tmux: false, misao: false }, false), local, undefined, 'ws', WIN)).rejects.toBeInstanceOf(MuxDriverUnavailableError);
    expect(await resolveStoredWindowKind(registryWith({ tmux: true, misao: false }, false), local, undefined, 'ws', WIN)).toBe('tmux');
  });

  it('is tmux on a tmux-only server without asking', async () => {
    const registry = registryWith({ tmux: false, misao: true });
    expect(await resolveStoredWindowKind(registry, agent, undefined, 'ws', WIN)).toBe('tmux');
  });
});

describe('resolveRawTarget', () => {
  const probe = (has: { tmux: boolean; misao: boolean }, misaoUp = true) => rawTargetProbeOf(registryWith(has, misaoUp));

  it('asks both muxes of a server hosting both; a window in both is ambiguous', async () => {
    expect(await resolveRawTarget(probe({ tmux: true, misao: false }), local, `ws:${WIN}`)).toMatchObject({ kind: 'tmux' });
    expect(await resolveRawTarget(probe({ tmux: false, misao: true }), local, `ws:${WIN}`)).toMatchObject({ kind: 'misao' });
    expect(await resolveRawTarget(probe({ tmux: false, misao: false }), local, `ws:${WIN}`)).toBeNull();
    await expect(resolveRawTarget(probe({ tmux: true, misao: true }), local, `ws:${WIN}`)).rejects.toBeInstanceOf(AmbiguousWindowKindError);
  });

  it('treats a mux that cannot answer as not having the window', async () => {
    expect(await resolveRawTarget(probe({ tmux: true, misao: true }, false), local, `ws:${WIN}`)).toMatchObject({ kind: 'tmux' });
  });

  it('reads a target on a tmux-only server as a tmux ref without asking', async () => {
    expect(await resolveRawTarget(probe({ tmux: false, misao: true }), agent, `ws:${WIN}`)).toEqual({ kind: 'tmux', ref: { kind: 'tmux', workspace: 'ws', window: WIN } });
  });
});
