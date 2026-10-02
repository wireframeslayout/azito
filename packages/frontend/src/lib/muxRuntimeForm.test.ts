import { describe, it, expect } from 'vitest';
import { editableMuxRuntime } from './muxRuntimeForm';

describe('editableMuxRuntime', () => {
  it('keeps the runtimes the form offers', () => {
    expect(editableMuxRuntime('system')).toBe('system');
    expect(editableMuxRuntime('managed')).toBe('managed');
  });

  it('starts as system when the runtime is missing', () => {
    expect(editableMuxRuntime(undefined)).toBe('system');
  });

  it('starts as system for a runtime the form does not offer', () => {
    expect(editableMuxRuntime('misao')).toBe('system');
  });
});
