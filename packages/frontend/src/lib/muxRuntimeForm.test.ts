import { describe, it, expect } from 'vitest';
import { editableMuxRuntime, muxRuntimeNotice, muxRuntimeOptions } from './muxRuntimeForm';

describe('muxRuntimeOptions', () => {
  it('offers misao only for a local server while the hub flag is on', () => {
    expect(muxRuntimeOptions('local', true)).toEqual(['system', 'managed', 'misao']);
  });

  it('never offers misao when the flag is off', () => {
    expect(muxRuntimeOptions('local', false)).toEqual(['system', 'managed']);
  });

  it('keeps offering misao to a local server stored on misao while the flag is unknown or off', () => {
    expect(muxRuntimeOptions('local', false, 'misao')).toEqual(['system', 'managed', 'misao']);
  });

  it('does not offer misao because of a stored runtime on another server type', () => {
    expect(muxRuntimeOptions('agent', false, 'misao')).toEqual(['system', 'managed']);
  });

  it('never offers misao for agent or ssh servers', () => {
    expect(muxRuntimeOptions('agent', true)).toEqual(['system', 'managed']);
    expect(muxRuntimeOptions('ssh', true)).toEqual(['system', 'managed']);
  });
});

describe('editableMuxRuntime', () => {
  const tmuxOnly = muxRuntimeOptions('agent', false);
  const withMisao = muxRuntimeOptions('local', true);

  it('keeps the runtimes the form offers', () => {
    expect(editableMuxRuntime('system', tmuxOnly)).toBe('system');
    expect(editableMuxRuntime('managed', tmuxOnly)).toBe('managed');
    expect(editableMuxRuntime('misao', withMisao)).toBe('misao');
  });

  it('starts as system when the runtime is missing', () => {
    expect(editableMuxRuntime(undefined, tmuxOnly)).toBe('system');
  });

  it('starts as system for a runtime the form does not offer', () => {
    expect(editableMuxRuntime('misao', tmuxOnly)).toBe('system');
  });
});

describe('editableMuxRuntime with a stored misao runtime', () => {
  it('stays on misao before /health resolves instead of falling back to system', () => {
    expect(editableMuxRuntime('misao', muxRuntimeOptions('local', false, 'misao'))).toBe('misao');
  });
});

describe('muxRuntimeNotice', () => {
  it('announces entering misao, in add and edit mode alike', () => {
    expect(muxRuntimeNotice(undefined, 'misao')).toBe('enterMisao');
    expect(muxRuntimeNotice('system', 'misao')).toBe('enterMisao');
  });

  it('warns that misao windows become unreachable when leaving misao', () => {
    expect(muxRuntimeNotice('misao', 'system')).toBe('leaveMisao');
    expect(muxRuntimeNotice('misao', 'managed')).toBe('leaveMisao');
  });

  it('warns about the socket only when moving between tmux runtimes', () => {
    expect(muxRuntimeNotice('system', 'managed')).toBe('tmuxMigration');
    expect(muxRuntimeNotice('managed', 'system')).toBe('tmuxMigration');
  });

  it('says nothing when the selection is unchanged or being added on tmux', () => {
    expect(muxRuntimeNotice('system', 'system')).toBeNull();
    expect(muxRuntimeNotice(undefined, 'managed')).toBeNull();
  });
});
