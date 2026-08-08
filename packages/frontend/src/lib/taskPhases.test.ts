import { describe, it, expect } from 'vitest';
import { resolveEnabledPhaseNames } from './taskPhases';

// Client-side port of the server's resolveEnabledPhases()
// (modules/sidekicks/resolvePhaseSidekick.ts) — used by the untrusted-import
// creation banner (task/328-input-trust-and-exec-gate follow-up) so it shows
// the same enabled-phase list the server will actually resolve.
describe('resolveEnabledPhaseNames', () => {
  const phases = [{ name: 'planning' }, { name: 'implementing' }, { name: 'reviewing' }, { name: 'pushing' }];

  it('returns every phase name, in order, when phaseConfig is null', () => {
    expect(resolveEnabledPhaseNames(null, phases)).toEqual(['planning', 'implementing', 'reviewing', 'pushing']);
  });

  it('returns every phase name when phaseConfig is undefined', () => {
    expect(resolveEnabledPhaseNames(undefined, phases)).toEqual(['planning', 'implementing', 'reviewing', 'pushing']);
  });

  it('treats a phase with no entry as enabled', () => {
    expect(resolveEnabledPhaseNames({}, phases)).toEqual(['planning', 'implementing', 'reviewing', 'pushing']);
  });

  it('treats enabled: undefined (omitted) as enabled', () => {
    expect(resolveEnabledPhaseNames({ planning: { sidekick: 'custom-planning' } }, phases)).toEqual(['planning', 'implementing', 'reviewing', 'pushing']);
  });

  it('excludes a phase explicitly disabled (enabled: false)', () => {
    expect(resolveEnabledPhaseNames({ reviewing: { enabled: false } }, phases)).toEqual(['planning', 'implementing', 'pushing']);
  });

  it('excludes multiple disabled phases while preserving UnitType order', () => {
    expect(resolveEnabledPhaseNames({ implementing: { enabled: false }, pushing: { enabled: false } }, phases)).toEqual(['planning', 'reviewing']);
  });
});
