/**
 * Per-phase override stored on Unit.phaseConfig (Issue #263 Phase 5).
 * - `sidekick`: name of the Sidekick package to use for this phase instead of
 *   the phase's default package. Must be a package whose own tags include the
 *   phase's tag (see resolvePhaseSidekick.ts).
 * - `enabled`: whether this phase runs at all. Omitted/undefined means enabled.
 */
export interface PhaseEntryConfig {
  sidekick?: string;
  enabled?: boolean;
}

export type PhaseConfig = Record<string, PhaseEntryConfig>;
