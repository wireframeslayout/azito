import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { asPaneHandle, type MuxRef, type PaneOrdinal } from '@azito/shared';
import { TransportFactory } from './TransportFactory';
import { LocalTransport } from './LocalTransport';
import { MuxlessLocalTransport } from './MuxlessLocalTransport';
import { MuxDriverRegistry } from '../../tmux/MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../../tmux/MuxCapabilityError';
import type { IMuxClient } from '../../tmux/IMuxClient';

const localMisao = { name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, defaultMux: 'misao' as const, muxRuntime: 'system' as const };
const agentMisao = { ...localMisao, name: 'remote', type: 'agent' as const, host: 'h', agentPort: 1, agentToken: 't' };
const MISAO_REF: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' };

function factoryWith(register?: 'misao'): TransportFactory {
  const registry = new MuxDriverRegistry();
  if (register) registry.register(register, { kind: register } as unknown as IMuxClient);
  return new TransportFactory('http://hub:3001', { muxAvailability: (kind, s) => registry.availabilityFor(kind, s) });
}

async function muxErrorOf(op: () => unknown): Promise<unknown> {
  try {
    await op();
  } catch (err) {
    return err;
  }
  throw new Error('expected the mux operation to fail');
}

describe('TransportFactory (misao local server)', () => {
  it('returns a shell transport whose exec works independently of the mux', async () => {
    const transport = factoryWith().getTransport(localMisao);
    expect(transport).toBeInstanceOf(MuxlessLocalTransport);
    const result = await transport.exec('echo misao-exec-ok');
    expect(result.stdout.trim()).toBe('misao-exec-ok');
  });

  it('fails every mux operation with the registry reason', async () => {
    const reason = 'driver_not_registered';
    const transport = factoryWith().getTransport(localMisao);
    const errors = [
      await muxErrorOf(() => transport.execMux({ kind: 'tmux', args: ['list-sessions'] })),
      await muxErrorOf(() => transport.openTerminal(MISAO_REF, 1 as PaneOrdinal, 80, 24)),
      await muxErrorOf(() => transport.createPaneStream(asPaneHandle('p_01J9Z8Y7X6W5V4T3S2R1Q0P9N8'))),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(MuxDriverUnavailableError);
      expect((err as MuxDriverUnavailableError).kind).toBe('misao');
      expect((err as MuxDriverUnavailableError).reason).toBe(reason);
    }
  });

  it('never routes mux operations to tmux even when a misao driver is registered', async () => {
    const transport = factoryWith('misao').getTransport(localMisao);
    const err = await muxErrorOf(() => transport.execMux({ kind: 'tmux', args: ['list-sessions'] }));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MuxDriverUnavailableError);
  });

  it('does not return a cached tmux transport once the server switches to misao', () => {
    const factory = factoryWith();
    expect(factory.getTransport({ ...localMisao, defaultMux: 'tmux' as const })).toBeInstanceOf(LocalTransport);
    expect(factory.getTransport(localMisao)).toBeInstanceOf(MuxlessLocalTransport);
  });

  it('keeps serving tmux servers with the tmux LocalTransport', () => {
    expect(factoryWith().getTransport({ ...localMisao, defaultMux: 'tmux' as const })).toBeInstanceOf(LocalTransport);
  });
});

describe('TransportFactory (misao on a non-local server)', () => {
  it('fails explicitly with the registry reason', () => {
    expect(() => factoryWith().getTransport(agentMisao)).toThrow(MuxDriverUnavailableError);
  });

  it('fails explicitly even when the driver is available', () => {
    expect(() => factoryWith('misao').getTransport(agentMisao)).toThrow('Mux kind "misao" is not supported on agent servers');
  });
});
