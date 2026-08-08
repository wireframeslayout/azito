import type { SidekickPackage } from './SidekickPackage';
import type { SidekickPackageLoader } from './SidekickPackageLoader';
import type { PhaseConfig } from './PhaseConfig';
import type { UnitTypePhase } from './UnitType';

/**
 * Single source of truth for "which Sidekick package renders this phase's
 * prompt" (Issue #263 Phase 5). Used by both the state-machine execution loop
 * (PhaseLoopRunner) and the skill-render compat endpoint (RenderSkillPromptUseCase)
 * so the two never diverge.
 *
 * Resolution rule:
 * 1. `phaseConfig[phase].sidekick` set → resolve that package by exact name.
 *    Fail fast (throw) if it doesn't exist or doesn't carry the required tag —
 *    assigning a package without that tag is a configuration error.
 * 2. Otherwise → the phase's default package (`loader.findDefaultForTag`).
 *    Fail fast if none is configured.
 *
 * Tags to match against are taken from the UnitTypePhase definition (phaseDef.tags).
 */
export function resolvePhaseSidekick(
  loader: SidekickPackageLoader,
  phase: string,
  phaseConfig: PhaseConfig | null | undefined,
  phaseDef: UnitTypePhase,
): SidekickPackage {
  const overrideName = phaseConfig?.[phase]?.sidekick;
  if (overrideName) {
    const pkg = loader.findByName(overrideName);
    if (!pkg) {
      throw new Error(`Sidekick "${overrideName}" configured for phase "${phase}" was not found`);
    }
    const hasMatchingTag = phaseDef.tags.some((tag) => pkg.tags.includes(tag));
    if (!hasMatchingTag) {
      throw new Error(
        `Sidekick "${overrideName}" cannot be assigned to the "${phase}" phase: its tags [${pkg.tags.join(', ')}] `
        + `do not include any of [${phaseDef.tags.join(', ')}] (tags に一致するものが必要です)`,
      );
    }
    return pkg;
  }

  const tag = phaseDef.tags[0];
  const defaultPkg = loader.findDefaultForTag(tag);
  if (!defaultPkg) {
    throw new Error(`No default Sidekick package is configured for phase "${phase}" (tag: "${tag}")`);
  }
  return defaultPkg;
}

/** `phaseConfig[phase].enabled !== false` (undefined/omitted = enabled). */
export function isPhaseEnabled(phaseConfig: PhaseConfig | null | undefined, phase: string): boolean {
  return phaseConfig?.[phase]?.enabled !== false;
}

/** UnitType phases filtered to those enabled in phaseConfig. */
export function resolveEnabledPhases(phaseConfig: PhaseConfig | null | undefined, unitTypePhases: UnitTypePhase[]): string[] {
  return unitTypePhases.map((p) => p.name).filter((name) => isPhaseEnabled(phaseConfig, name));
}

/** The next enabled phase after `currentPhase`, or null if it's the last one. */
export function resolveNextPhase(phaseConfig: PhaseConfig | null | undefined, currentPhase: string, unitTypePhases: UnitTypePhase[]): string | null {
  const enabled = resolveEnabledPhases(phaseConfig, unitTypePhases);
  const idx = enabled.indexOf(currentPhase);
  if (idx === -1 || idx >= enabled.length - 1) return null;
  return enabled[idx + 1];
}

/**
 * Resolves which enabled phase a task's `currentPhase` maps to — the "resume
 * point" logic PhaseLoopRunner.stateMachineLoop uses to pick up a run in
 * progress (or, when `currentPhase` is null/unset, the first enabled phase a
 * fresh run starts at). Extracted as a shared function (Issue #328 sixth-round
 * review) so ExecutionManifest.ts's approval-manifest resolution and the loop
 * itself always agree on "which phase actually runs next" — two independent
 * reimplementations of this are exactly how the manifest's earlier field gaps
 * opened up.
 *
 * Returns the enabled-phase list alongside the resolved index so callers that
 * only need "which phase" (index into the returned list) and the loop, which
 * also needs the index to keep iterating, share one resolution.
 */
export function resolveCurrentPhaseIndex(
  phaseConfig: PhaseConfig | null | undefined,
  unitTypePhases: UnitTypePhase[],
  currentPhase: string | null,
): { enabledPhases: string[]; index: number } {
  const enabledPhases = resolveEnabledPhases(phaseConfig, unitTypePhases);
  if (!currentPhase) return { enabledPhases, index: 0 };

  const idx = enabledPhases.indexOf(currentPhase);
  if (idx >= 0) return { enabledPhases, index: idx };

  // currentPhase was disabled since the run started: fall back to the next
  // enabled phase that comes after it in unitType's declared order.
  const allPhaseNames = unitTypePhases.map((p) => p.name);
  const phaseOrderIdx = allPhaseNames.indexOf(currentPhase);
  const fallbackIdx = enabledPhases.findIndex((p) => allPhaseNames.indexOf(p) > phaseOrderIdx);
  return { enabledPhases, index: fallbackIdx >= 0 ? fallbackIdx : 0 };
}
