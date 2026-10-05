import { describe, it, expect } from 'vitest';
import { defaultMuxNotice, defaultMuxOptions, editableDefaultMux, editableMuxRuntime, tmuxRuntimeNotice } from './muxRuntimeForm';

describe('defaultMuxOptions', () => {
  it('offers misao and tmux for a local server', () => {
    expect(defaultMuxOptions('local')).toEqual(['misao', 'tmux']);
  });

  it('offers misao and tmux for an agent server too: its misao runs through the agent', () => {
    expect(defaultMuxOptions('agent')).toEqual(['misao', 'tmux']);
  });

  it('offers only tmux for any other server type', () => {
    expect(defaultMuxOptions('ssh')).toEqual(['tmux']);
  });
});

describe('editableDefaultMux', () => {
  it('keeps the stored kind when the form offers it', () => {
    expect(editableDefaultMux('misao', defaultMuxOptions('local'))).toBe('misao');
    expect(editableDefaultMux('tmux', defaultMuxOptions('local'))).toBe('tmux');
  });

  it('starts as tmux for a kind the form does not offer', () => {
    expect(editableDefaultMux('misao', defaultMuxOptions('ssh'))).toBe('tmux');
  });
});

describe('editableMuxRuntime', () => {
  it('keeps system and managed', () => {
    expect(editableMuxRuntime('system')).toBe('system');
    expect(editableMuxRuntime('managed')).toBe('managed');
  });

  it('starts as system when the runtime is missing or unknown', () => {
    expect(editableMuxRuntime(undefined)).toBe('system');
    expect(editableMuxRuntime('misao')).toBe('system');
  });
});

describe('defaultMuxNotice', () => {
  it('announces entering misao, in add and edit mode alike', () => {
    expect(defaultMuxNotice(undefined, 'misao')).toBe('enterMisao');
    expect(defaultMuxNotice('tmux', 'misao')).toBe('enterMisao');
  });

  it('warns that misao windows become unreachable when leaving misao', () => {
    expect(defaultMuxNotice('misao', 'tmux')).toBe('leaveMisao');
  });

  it('says nothing when the selection is unchanged or being added on tmux', () => {
    expect(defaultMuxNotice('misao', 'misao')).toBeNull();
    expect(defaultMuxNotice('tmux', 'tmux')).toBeNull();
    expect(defaultMuxNotice(undefined, 'tmux')).toBeNull();
  });
});

describe('tmuxRuntimeNotice', () => {
  it('warns about the socket only when moving between tmux runtimes', () => {
    expect(tmuxRuntimeNotice('system', 'managed')).toBe('tmuxMigration');
    expect(tmuxRuntimeNotice('managed', 'system')).toBe('tmuxMigration');
  });

  it('says nothing when the selection is unchanged or being added', () => {
    expect(tmuxRuntimeNotice('system', 'system')).toBeNull();
    expect(tmuxRuntimeNotice(undefined, 'managed')).toBeNull();
  });
});
