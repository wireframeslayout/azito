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
  /**
   * Server names already configured for this project ('addEnvironment' mode
   * only). A selection matching one of these must never be allowed to
   * advance — the environment PUT would silently overwrite that
   * environment's working directory/branch/tmux session/input policy
   * (Issue #87 review, Important finding 2).
   */
  existingServerNames?: string[];
  /**
   * Whether repository discovery has FINISHED SUCCESSFULLY for the
   * currently-selected server + path (codeMode 'existing' only) — never
   * true while a scan is in flight, errored, or was run against a stale
   * server/path the user has since changed (Issue #87 review, Important
   * finding 3). The wizard must not advance to confirm/execute on a
   * previous path's discovery result.
   */
  discoveryReady?: boolean;
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
      return state.selectedServer.trim().length > 0 && !(state.existingServerNames ?? []).includes(state.selectedServer);
    case 'code':
      if (state.codeMode === 'existing') return state.existingPath.trim().length > 0 && state.discoveryReady === true;
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

/**
 * Picks the server the environment step should default to, given the
 * servers already configured for this project ('addEnvironment' mode).
 * Never returns a name in `existingServerNames` — selecting one would let
 * the environment PUT silently overwrite that environment's settings
 * (Issue #87 review, Important finding 2). Returns '' when every server is
 * already configured (the caller must then block completion and show a
 * message — there is nothing left to choose).
 *
 * `currentSelection` is kept as-is when it is still a valid (available)
 * choice, so this can be called on every server-list/existing-names change
 * without fighting a manual selection the user already made.
 */
export function pickAvailableServer(
  serverNames: string[],
  existingServerNames: string[],
  currentSelection: string,
): string {
  const available = serverNames.filter((name) => !existingServerNames.includes(name));
  if (available.includes(currentSelection)) return currentSelection;
  if (available.includes('local')) return 'local';
  return available[0] ?? '';
}

export interface DiscoveryKey {
  server: string;
  path: string;
}

/**
 * Whether a resolved discovery result (keyed by the server + path it was
 * fetched for) still matches the CURRENT server + path — used to gate
 * advancing past the "code" step so a stale result (from before the user
 * edited the path/server) can never be registered as if it were current
 * (Issue #87 review, Important finding 3).
 */
export function isDiscoveryCurrent(key: DiscoveryKey | null, currentServer: string, currentPath: string): boolean {
  return key !== null && key.server === currentServer && key.path === currentPath.trim();
}

/** Derives a default clone-target directory name from a repository URL, e.g. `git@github.com:acme/widgets.git` -> `widgets`. Editable afterward by the user; returns '' when no name can be derived. */
export function deriveCloneDirectoryName(cloneUrl: string): string {
  const trimmed = cloneUrl.trim().replace(/\/+$/, '');
  const match = trimmed.match(/([^/:]+?)(?:\.git)?$/);
  return match ? match[1] : '';
}

/**
 * Derives the project's `default_branch` (task base-branch fallback, see
 * `TaskExecutionEnv.resolveBaseBranch`) from the wizard's "code" step
 * instead of a dedicated step-1 field — repository choice, and therefore
 * its branch, is now decided in that step. Only the "clone" mode supplies
 * an explicit branch (the one the clone will check out); repository
 * discovery (`existing` mode) does not report a remote's default branch,
 * and "later" has no repository at all — both fall back to 'main', same
 * as the server-side fallback chain's own final default.
 */
export function deriveDefaultBranch(codeMode: CodeMode, cloneBranch: string): string {
  if (codeMode === 'clone') return cloneBranch.trim() || 'main';
  return 'main';
}

/**
 * Whether the wizard clones directly on the given server type, versus
 * relying on the hub's existing 代行配信 (distribution) path.
 *
 * `local` IS the hub itself and is structurally excluded from distribution
 * (ExecuteTaskUseCase's distribution gate never targets it) — it is the
 * only server type where "clone" can mean an actual `git clone` run right
 * now. Every other server type gets its code from distribution instead,
 * which only runs once a task actually executes there — never here (Issue
 * #87 review, Important finding 4: the previous "clone" mode registered a
 * repository row but configured neither distribution nor an actual clone).
 */
export function clonesDirectlyOnServer(serverType: string): boolean {
  return serverType === 'local';
}

/**
 * Resolves whether the confirm/execute step can actually tell local-clone
 * apart from distributed-clone for the selected server — and, critically,
 * whether it is safe to decide that at all yet.
 *
 * `serverList` starts empty (before `GET /servers` resolves) and
 * `selectedServer` defaults to `'local'` before that fetch lands. The old
 * call site computed `serverList.find(...)?.type ?? ''`, which folds
 * "not yet resolved" into the same `''` as "type genuinely unknown" — and
 * since `clonesDirectlyOnServer('') === false`, an unresolved `local`
 * selection silently fell through to the distribution path (`distribute_code:
 * true` is never sent for `''`, but neither is an actual local clone run),
 * producing an environment where the server review flagged as getting
 * neither cloned nor distributed. This function keeps "unresolved" a
 * distinct third outcome so the caller can block execution instead of
 * guessing (review finding: "サーバー種別が未解決のとき「リモート扱い」に
 * なる").
 */
export type CloneDeliveryMode = 'local' | 'distributed' | 'none' | 'unresolved';

export function resolveCloneDeliveryMode(
  codeMode: CodeMode,
  selectedServer: string,
  serverList: { name: string; type: string }[],
): CloneDeliveryMode {
  if (codeMode !== 'clone') return 'none';
  if (!selectedServer.trim()) return 'unresolved';
  const record = serverList.find((sv) => sv.name === selectedServer);
  if (!record) return 'unresolved';
  return clonesDirectlyOnServer(record.type) ? 'local' : 'distributed';
}

/**
 * Signature of the inputs that drove the "repository" confirm-step
 * success (`repoDone`/`createdRepositoryId`). Compared before/after every
 * render (by simple string equality) so the wizard can invalidate those
 * flags the moment the user edits something that step actually consumed —
 * instead of leaving a stale success flag that skips re-running the step
 * on a "go back, change something, run again" pass (review finding:
 * "完了フラグが入力と結びついていない"). Order-independent for the
 * discovered-remote-url selection (a Set), since selection order carries
 * no meaning.
 */
export function repoStepSignature(input: { codeMode: CodeMode; cloneUrl: string; selectedRemoteUrls: Iterable<string> }): string {
  return JSON.stringify({
    codeMode: input.codeMode,
    cloneUrl: input.codeMode === 'clone' ? input.cloneUrl.trim() : '',
    remoteUrls: input.codeMode === 'existing' ? [...input.selectedRemoteUrls].sort() : [],
  });
}

/**
 * Signature of the inputs that drove the "environment" confirm-step
 * success (`envDone`). Includes `distributingRepositoryId` (not just
 * `distributingClone`) so that when the repository step above gets
 * invalidated and re-creates a *different* repository id, the environment
 * PUT — which embedded the OLD id in `distribution_repository_id` — is
 * correctly treated as stale too, even though none of the environment
 * step's own fields changed.
 */
export function envStepSignature(input: {
  selectedServer: string;
  workingDirectory: string;
  branch: string;
  distributingRepositoryId: number | null;
}): string {
  return JSON.stringify(input);
}

/**
 * Signature of the inputs that drove the "local clone" confirm-step
 * success (`localCloneDone`). Same rationale as `envStepSignature`: a
 * failed local clone followed by editing `cloneDirectory` or
 * `selectedServer` and re-running must re-issue the clone against the new
 * target, not skip it because the OLD target already "succeeded" (the
 * concrete review scenario: code ends up in the new directory while
 * `project_servers.working_directory` — actually the whole point here is
 * the clone itself — silently still targets the old one).
 */
export function cloneStepSignature(input: {
  selectedServer: string;
  cloneDirectory: string;
  cloneBranch: string;
  repositoryId: number | null;
}): string {
  return JSON.stringify(input);
}

/**
 * Ids to attempt deleting when the repo-step signature changes ("やり直しで
 * リポジトリ行が重複して増える" — `/projects/:id/repositories`(`/bulk`) is
 * append-only, so retrying the repository step after editing an input that
 * changed `repoStepSignature` must clean up the PREVIOUS run's row(s)
 * first). Returns `[]` when the signature hasn't changed — nothing to
 * clean up, and a resume-after-a-later-step-failure run keeps its
 * still-valid tracked ids.
 *
 * Unlike the ids actually still tracked afterward (see
 * `reconcileDeletedRepositoryIds`), this list is NOT the new tracked
 * state — the caller must keep `createdRepositoryIds` unchanged until the
 * deletes this returns have actually settled, and only reconcile after
 * (Issue #87 review, Important finding: 削除の完了を待たずに再登録する
 * ため、リポジトリが失われる — clearing the tracked list synchronously,
 * before the DELETE requests resolve, both let registration race ahead of
 * cleanup and dropped the ids needed to retry a failed delete).
 */
export function repoIdsToCleanup(createdRepositoryIds: number[], signatureChanged: boolean): number[] {
  return signatureChanged ? createdRepositoryIds : [];
}

export interface RepoDeleteResult {
  id: number;
  status: number;
}

/**
 * Which of the ids a cleanup pass attempted to delete are still orphaned
 * (and must stay tracked for a future retry) — i.e. whose DELETE did NOT
 * come back 2xx. `apiWithStatus` resolves normally even for HTTP error
 * responses, so the caller must check `status` explicitly rather than
 * relying on the promise rejecting (Issue #87 review, Important finding:
 * エラー状態が無視され、後始末に必要な ID が恒久的に失われる — the
 * previous code fired every DELETE with `.catch(() => {})` and cleared the
 * whole tracked list regardless of the response, so a failed delete's row
 * was never retried and its id was gone for good).
 */
export function reconcileDeletedRepositoryIds(results: RepoDeleteResult[]): number[] {
  return results.filter((r) => r.status < 200 || r.status >= 300).map((r) => r.id);
}

/**
 * Runs a stale-signature cleanup pass: attempts to delete every id in
 * `idsToDelete` (independently — one failure never blocks the others) and
 * returns the ids that must stay tracked afterward (the ones whose delete
 * did not succeed). A thrown/rejected delete call is treated the same as a
 * non-2xx response (network failure — the row's existence is unknown, so
 * it is kept tracked rather than assumed gone).
 */
export async function cleanupStaleRepositoryIds(
  idsToDelete: number[],
  deleteFn: (id: number) => Promise<{ status: number }>,
): Promise<number[]> {
  const results = await Promise.all(idsToDelete.map(async (id): Promise<RepoDeleteResult> => {
    try {
      const { status } = await deleteFn(id);
      return { id, status };
    } catch {
      return { id, status: 0 };
    }
  }));
  return reconcileDeletedRepositoryIds(results);
}
