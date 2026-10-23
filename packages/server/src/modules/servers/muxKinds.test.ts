import { describe, it, expect } from 'vitest';
import { hostRunsTmux, serverSupportsMux, supportedMuxKinds } from './muxKinds';

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

  it('hosts misao only on a Windows host, whatever the stored default: its tmux is closed', () => {
    const win32 = { platform: 'win32' as const };
    expect(supportedMuxKinds({ ...localMisao, hostProfile: win32 })).toEqual(['misao']);
    expect(supportedMuxKinds({ ...agent, hostProfile: win32 })).toEqual(['misao']);
    expect(serverSupportsMux({ ...localMisao, hostProfile: win32 }, 'tmux')).toBe(false);
    expect(serverSupportsMux({ ...localMisao, hostProfile: win32 }, 'misao')).toBe(true);
  });

  it('keeps both muxes on Unix hosts and on a host whose OS is not recorded', () => {
    expect(supportedMuxKinds({ ...local, hostProfile: { platform: 'linux' } })).toEqual(['tmux', 'misao']);
    expect(supportedMuxKinds({ ...local, hostProfile: { platform: 'darwin' } })).toEqual(['tmux', 'misao']);
    expect(supportedMuxKinds({ ...agent, hostProfile: null })).toEqual(['tmux', 'misao']);
  });
});

describe('hostRunsTmux', () => {
  it('is the tmux row of hostFeatureSupport: closed on win32 only', () => {
    expect(hostRunsTmux({ hostProfile: { platform: 'win32' } })).toBe(false);
    expect(hostRunsTmux({ hostProfile: { platform: 'linux' } })).toBe(true);
    expect(hostRunsTmux({ hostProfile: null })).toBe(true);
    expect(hostRunsTmux({})).toBe(true);
  });
});
