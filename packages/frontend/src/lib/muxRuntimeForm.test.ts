import { describe, it, expect } from 'vitest';
import { editableMuxRuntime, muxRuntimeOptions } from './muxRuntimeForm';

describe('muxRuntimeOptions', () => {
  it('offers misao only for a local server while the hub flag is on', () => {
    expect(muxRuntimeOptions('local', true)).toEqual(['system', 'managed', 'misao']);
  });

  it('never offers misao when the flag is off', () => {
    expect(muxRuntimeOptions('local', false)).toEqual(['system', 'managed']);
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
