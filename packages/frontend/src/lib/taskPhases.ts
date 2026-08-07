export interface PhaseConfigEntryLike {
  sidekick?: string;
  enabled?: boolean;
}

export interface PhaseConfigSummary {
  disabledPhases: string[];
  customizedPhases: string[];
}

export function summarizePhaseConfig(
  phaseConfig: Record<string, PhaseConfigEntryLike> | null | undefined,
  phases: Array<{ name: string }>,
): PhaseConfigSummary {
  const disabledPhases: string[] = [];
  const customizedPhases: string[] = [];
  if (!phaseConfig) return { disabledPhases, customizedPhases };
  for (const phase of phases) {
    const entry = phaseConfig[phase.name];
    if (!entry) continue;
    if (entry.enabled === false) disabledPhases.push(phase.name);
    if (entry.sidekick) customizedPhases.push(phase.name);
  }
  return { disabledPhases, customizedPhases };
}

export function getPhaseLabel(phases: Array<{ name: string; label: string }>, phaseName: string): string {
  return phases.find((p) => p.name === phaseName)?.label ?? phaseName;
}

/**
 * Ordered list of phase names actually enabled for a Unit — a client-side
 * port of the server's `resolveEnabledPhases()`
 * (modules/sidekicks/resolvePhaseSidekick.ts): `phaseConfig[phase].enabled
 * !== false` (undefined/omitted = enabled), in UnitType phase order. Used
 * by the untrusted-import creation banner (TaskFormView) to show the SAME
 * phase list the server will actually resolve into the execution manifest,
 * so the post-creation comparison against GET
 * /api/tasks/:id/execution-approval's `execution.phases` has something
 * meaningful to compare against.
 */
export function resolveEnabledPhaseNames(
  phaseConfig: Record<string, PhaseConfigEntryLike> | null | undefined,
  phases: Array<{ name: string }>,
): string[] {
  return phases.map((p) => p.name).filter((name) => phaseConfig?.[name]?.enabled !== false);
}
