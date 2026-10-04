import { describe, it, expect } from 'vitest';
import { selectServersSupportingMux, serverSupportsMux, supportedMuxKinds } from './muxKinds';

const local = { type: 'local' as const, defaultMux: 'tmux' as const };
const localMisao = { type: 'local' as const, defaultMux: 'misao' as const };
const agent = { type: 'agent' as const, defaultMux: 'tmux' as const };

describe('supportedMuxKinds', () => {
  it('lets a local server host both muxes, its default first', () => {
    expect(supportedMuxKinds(local)).toEqual(['tmux', 'misao']);
    expect(supportedMuxKinds(localMisao)).toEqual(['misao', 'tmux']);
  });

  it('keeps an agent server on tmux only', () => {
    expect(supportedMuxKinds(agent)).toEqual(['tmux']);
    expect(serverSupportsMux(agent, 'misao')).toBe(false);
  });
});

describe('selectServersSupportingMux', () => {
  const servers = [
    { name: 'a', ...local },
    { name: 'b', ...localMisao },
    { name: 'c', ...agent },
  ];

  it('puts a local server in both selections and an agent server only in the tmux one, keeping order', () => {
    expect(selectServersSupportingMux(servers, 'tmux').map((s) => s.name)).toEqual(['a', 'b', 'c']);
    expect(selectServersSupportingMux(servers, 'misao').map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('returns nothing for no servers', () => {
    expect(selectServersSupportingMux([], 'tmux')).toEqual([]);
  });
});
