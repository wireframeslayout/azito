import { describe, it, expect } from 'vitest';
import { deriveInputTrust, validateTaskSourceFields } from './Task';

// Third-party review fix (task/328-input-trust-and-exec-gate follow-up):
// `source` decides `inputTrust` via deriveInputTrust()'s `===` comparison —
// before validateTaskSourceFields existed, POST/PUT /api/tasks only cast
// the raw request-body value, so a caller-supplied `'GitHub'` (wrong case)
// or `'github '` (stray whitespace) was stored verbatim and fell through to
// `'trusted'`, silently bypassing the execution gate for content that looks
// exactly like a GitHub import.
describe('validateTaskSourceFields', () => {
  it('accepts each valid source value with no source_ref', () => {
    expect(validateTaskSourceFields('local', undefined)).toEqual({ source: 'local', sourceRef: undefined });
    expect(validateTaskSourceFields('github', undefined)).toEqual({ source: 'github', sourceRef: undefined });
    expect(validateTaskSourceFields('gitlab', undefined)).toEqual({ source: 'gitlab', sourceRef: undefined });
  });

  it('accepts a matching source + source_ref pair', () => {
    expect(validateTaskSourceFields('github', 'org/repo#1')).toEqual({ source: 'github', sourceRef: 'org/repo#1' });
  });

  it('accepts both fields omitted (PUT partial-update semantics)', () => {
    expect(validateTaskSourceFields(undefined, undefined)).toEqual({ source: undefined, sourceRef: undefined });
  });

  it('accepts source_ref explicitly cleared to null without source (unlink)', () => {
    expect(validateTaskSourceFields(undefined, null)).toEqual({ source: undefined, sourceRef: null });
  });

  it('rejects a wrong-case source value ("GitHub")', () => {
    expect(validateTaskSourceFields('GitHub', undefined)).toEqual({ error: expect.stringContaining('source must be one of') });
  });

  it('rejects a source value with stray whitespace ("github ")', () => {
    expect(validateTaskSourceFields('github ', undefined)).toEqual({ error: expect.stringContaining('source must be one of') });
  });

  it('rejects an unrecognized source value', () => {
    expect(validateTaskSourceFields('bitbucket', undefined)).toEqual({ error: expect.stringContaining('source must be one of') });
  });

  it('rejects a non-string source value', () => {
    expect(validateTaskSourceFields(123, undefined)).toEqual({ error: expect.stringContaining('source must be one of') });
  });

  it('rejects source_ref supplied without source', () => {
    expect(validateTaskSourceFields(undefined, 'org/repo#1')).toEqual({ error: expect.stringContaining('source is required when source_ref is provided') });
  });

  it('rejects a non-string source_ref', () => {
    expect(validateTaskSourceFields('github', 42)).toEqual({ error: expect.stringContaining('source_ref must be a string') });
  });
});

describe('deriveInputTrust', () => {
  it("trusts ONLY the combination of createdByKind='operator' and source='local'", () => {
    expect(deriveInputTrust('operator', 'local')).toBe('trusted');
  });

  it("stays untrusted for an operator origin with source 'github'/'gitlab' (Issue #328 original rule preserved)", () => {
    expect(deriveInputTrust('operator', 'github')).toBe('untrusted');
    expect(deriveInputTrust('operator', 'gitlab')).toBe('untrusted');
  });

  it("is untrusted for a non-operator origin even with source='local' (Issue #28 design v3 §5 fail-safe reversal)", () => {
    expect(deriveInputTrust('task', 'local')).toBe('untrusted');
    expect(deriveInputTrust('trigger', 'local')).toBe('untrusted');
    expect(deriveInputTrust('system', 'local')).toBe('untrusted');
  });
});
