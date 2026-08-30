// Pure step/navigation logic for the project-creation wizard
// (ProjectCreationWizard.tsx) and the "add environment" wizard embedded in
// ProjectSettings.tsx (both share the environment/code/confirm steps — see
// EnvironmentCodeWizard.tsx). Split out so the transition logic can be unit
// tested directly, matching this codebase's existing convention of testing
// the pure-logic side of a component (see distributeCodePolicy.ts,
// repoDiscoveryDialogLogic.ts) rather than adding component tests.

/**
 * The four wizard steps, in a fixed order. `environment` is the only step
 * that can be skipped (see `getVisibleSteps`) — `project` always starts the
 * full create-project wizard, and `code`/`confirm` always follow.
 */
export type WizardStepId = 'project' | 'environment' | 'code' | 'confirm';

export type CodeMode = 'existing' | 'clone' | 'later';

export interface WizardValidationState {
  projectName: string;
  projectSlug: string;
  /** Which server is selected for the environment step (also the auto-selected/only choice when that step is skipped). */
  selectedServer: string;
  codeMode: CodeMode;
  existingPath: string;
  cloneUrl: string;
  cloneDirectory: string;
}

/**
 * Returns the steps to actually show, in order. The "environment" step is
 * skipped when there is only one server to choose from — there is nothing
 * to decide, so asking would just be a confirmation click. The wizard
 * still auto-selects that one server and shows it on the confirm step.
 *
 * `serverCount <= 0` is treated the same as `serverCount === 1`: with no
 * servers to list, there is likewise nothing to choose between (and the
 * environment step's server <select> would have no options to show).
 */
export function getVisibleSteps(serverCount: number): WizardStepId[] {
  const steps: WizardStepId[] = ['project'];
  if (serverCount > 1) steps.push('environment');
  steps.push('code', 'confirm');
  return steps;
}

/**
 * Whether the wizard may advance past `stepId` given the current input.
 * Each step's own required fields are checked here so the "next" action
 * and the near-input validation message (FormField's `error` prop) share
 * exactly one source of truth.
 */
export function canAdvanceFromStep(stepId: WizardStepId, state: WizardValidationState): boolean {
  switch (stepId) {
    case 'project':
      return state.projectName.trim().length > 0 && state.projectSlug.trim().length > 0;
    case 'environment':
      return state.selectedServer.trim().length > 0;
    case 'code':
      if (state.codeMode === 'existing') return state.existingPath.trim().length > 0;
      if (state.codeMode === 'clone') return state.cloneUrl.trim().length > 0 && state.cloneDirectory.trim().length > 0;
      return true; // 'later': nothing required
    case 'confirm':
      return true;
  }
}

/**
 * Steps up to and including `currentStep`, restricted to `visibleSteps` —
 * used to render the step indicator's "completed" segments without ever
 * showing a skipped step.
 */
export function stepIndex(visibleSteps: WizardStepId[], currentStep: WizardStepId): number {
  return visibleSteps.indexOf(currentStep);
}

/** The step to land on after moving forward/back from `currentStep`, clamped to the visible range. */
export function nextStep(visibleSteps: WizardStepId[], currentStep: WizardStepId, direction: 1 | -1): WizardStepId {
  const idx = stepIndex(visibleSteps, currentStep);
  const target = idx + direction;
  if (target < 0 || target >= visibleSteps.length) return currentStep;
  return visibleSteps[target];
}

/** Derives a default clone-target directory name from a repository URL, e.g. `git@github.com:acme/widgets.git` -> `widgets`. Editable afterward by the user; returns '' when no name can be derived. */
export function deriveCloneDirectoryName(cloneUrl: string): string {
  const trimmed = cloneUrl.trim().replace(/\/+$/, '');
  const match = trimmed.match(/([^/:]+?)(?:\.git)?$/);
  return match ? match[1] : '';
}
