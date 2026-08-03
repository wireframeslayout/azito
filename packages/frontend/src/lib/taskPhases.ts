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
