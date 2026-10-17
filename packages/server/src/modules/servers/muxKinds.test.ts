import { describe, it, expect } from 'vitest';
import { serverSupportsMux, supportedMuxKinds } from './muxKinds';

const local = { type: 'local' as const, defaultMux: 'tmux' as const };
const localMisao = { type: 'local' as const, defaultMux: 'misao' as const };
const agent = { type: 'agent' as const, defaultMux: 'tmux' as const };
const agentMisao = { type: 'agent' as const, defaultMux: 'misao' as const };

describe('supportedMuxKinds', () => {
  it('lets a local server host both muxes, its default first', () => {
    expect(supportedMuxKinds(local)).toEqual(['tmux', 'misao']);
    expect(supportedMuxKinds(localMisao)).toEqual(['misao', 'tmux']);
  });

  it('lets an agent server host both muxes too (misao runs through its relay)', () => {
    expect(supportedMuxKinds(agent)).toEqual(['tmux', 'misao']);
    expect(supportedMuxKinds(agentMisao)).toEqual(['misao', 'tmux']);
    expect(serverSupportsMux(agent, 'misao')).toBe(true);
  });
});
