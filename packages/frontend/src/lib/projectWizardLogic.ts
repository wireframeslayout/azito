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
  /**
   * Whether the selected server clones directly on the hub (i.e. is
   * `local`) — `clonesDirectlyOnServer(selectedServerType)`. Only
   * meaningful for `codeMode === 'clone'`; a non-local target relies on the
   * hub's 代行配信 path, which requires the repository to actually carry a
   * credential (Issue #87 review, Important finding 3).
   */
  cloneTargetIsLocal?: boolean;
  /** The clone-step token field's current (trimmed) value. */
  cloneToken?: string;
  /**
   * Whether the clone URL already matches a repository this project has
   * registered WITH a token — see `findReusableRepository`. When true, the
   * wizard can proceed without the operator entering a new token (the
   * reused row's own credential covers delivery).
   */
  cloneRepoReusableWithToken?: boolean;
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
      if (state.codeMode === 'clone') {
        if (!state.cloneUrl.trim() || !state.cloneDirectory.trim()) return false;
        // The clone target must be an absolute path — an auto-derived
        // basename (e.g. `widgets`) used to be accepted and later resolved
        // against the HUB PROCESS's cwd (which may not even be this
        // project's directory, or may be unwritable, under a daemon/
        // release deployment) — see `isAbsoluteWizardPath` (Issue #87
        // review, Important finding 2).
        if (!isAbsoluteWizardPath(state.cloneDirectory)) return false;
        // A non-local clone target relies on the hub's 代行配信 path, which
        // refuses a repository with no credential outright — the wizard
        // must collect a token before letting the operator finish, unless
        // an already-registered repository for this URL already carries
        // one (Issue #87 review, Important finding 3).
        if (!state.cloneTargetIsLocal && !state.cloneRepoReusableWithToken && !(state.cloneToken ?? '').trim()) return false;
        return true;
      }
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

/**
 * Whether the wizard must create the "existing directory" step's root on
 * the target server before saving it as the environment's
 * `working_directory` — i.e. `codeMode === 'existing'` AND the discovery
 * scan for the current path reported it missing (`exists: false`).
 *
 * Before this fix, a `false` here (or rather, the absence of ANY such
 * check) meant the UI told the operator "このパスは存在しません。作成し
 * ます。" (`wizard.code.pathWillBeCreated`) but `handleRun` just persisted
 * the never-created path as `working_directory` — later task execution's
 * containment resolution then failed against a root that was never
 * created (Issue #87 review, Important finding 1).
 */
export function needsDirectoryCreation(codeMode: CodeMode, discoveryExists: boolean | null): boolean {
  return codeMode === 'existing' && discoveryExists === false;
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

/**
 * Whether `p` is an absolute path, i.e. safe to pass straight to `git
 * clone`/store as `working_directory` without resolving it against
 * something else's current directory first.
 *
 * The wizard used to auto-derive the clone target as a bare basename (e.g.
 * `widgets` from `git@github.com:acme/widgets.git`) and let the operator
 * "accept" that as-is. A relative clone target resolves against the HUB
 * PROCESS's cwd when `git clone` actually runs — under a daemon/release
 * deployment that may be `/`, an unrelated directory, or simply
 * unwritable — producing a permission error or, worse, a clone landing
 * somewhere unintended (Issue #87 review, Important finding 2). The fix is
 * to require an absolute path outright rather than trying to guess a safe
 * relative-to base; `CodeStep` no longer auto-fills this field at all (see
 * the removed auto-derivation effect in `ProjectWizard.tsx`) — the operator
 * picks it explicitly via `DirectoryInput`, which lists real paths on the
 * selected server.
 */
export function isAbsoluteWizardPath(p: string): boolean {
  return p.trim().startsWith('/');
}

/**
 * Frontend mirror of the server's `normalizeRemoteUrl`
 * (`packages/server/src/modules/git/parseRemoteUrl.ts`) — kept in sync by
 * hand, same convention this file already follows for `parseRepoUrl`/
 * `parseCloneUrlForRegistration` (see that function's doc comment). Used
 * ONLY to decide whether the clone wizard step can skip asking for a
 * token (an already-registered, already-credentialed repository covers the
 * same remote) — the actual dedup-and-reuse decision is still made
 * server-side, in `POST /api/projects/:id/repositories`, using the real
 * `normalizeRemoteUrl`. A false negative here (two equivalent URLs judged
 * different) only means the operator is asked for a token that turns out
 * to be unnecessary — never lets the wizard skip past a step it shouldn't
 * (Issue #87 review, Important finding 3).
 */
export function normalizeRepoUrlForWizard(url: string): string {
  const trimmed = url.trim();
  const knownCrossProtocolHosts = new Set(['github.com', 'gitlab.com']);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
      const host = parsed.hostname.toLowerCase();
      const defaultPort: Record<string, string> = { https: '443', http: '80', ssh: '22' };
      const port = parsed.port && parsed.port !== defaultPort[scheme] ? `:${parsed.port}` : '';
      const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
      const schemePrefix = knownCrossProtocolHosts.has(host) ? '' : `${scheme}://`;
      return `${schemePrefix}${host}${port}/${path}`;
    } catch {
      // Fall through to scp-like/plain handling below.
    }
  }

  const scpMatch = trimmed.match(/^(?:[a-zA-Z0-9_.-]+@)?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):(.+)$/);
  if (scpMatch) {
    const [, rawHost, rawPath] = scpMatch;
    const host = rawHost.toLowerCase();
    const path = rawPath.replace(/\.git$/, '').replace(/\/+$/, '').replace(/^\/+/, '');
    const schemePrefix = knownCrossProtocolHosts.has(host) ? '' : 'ssh://';
    return `${schemePrefix}${host}/${path}`;
  }

  return trimmed;
}

export interface ReusableRepoCandidate {
  id: number;
  url: string;
  hasToken: boolean;
}

/**
 * Finds an already-registered project repository whose URL matches
 * `cloneUrl` (via `normalizeRepoUrlForWizard`) AND already carries a token
 * — i.e. one that, if reused, actually resolves the "no credential" problem
 * rather than just avoiding a duplicate row. Returns `null` when there is
 * no match or the match has no token (the wizard must still collect one in
 * that case — reuse alone does not supply a missing credential).
 */
export function findReusableRepositoryWithToken(cloneUrl: string, repos: ReusableRepoCandidate[]): ReusableRepoCandidate | null {
  if (!cloneUrl.trim()) return null;
  const normalized = normalizeRepoUrlForWizard(cloneUrl);
  return repos.find((r) => r.hasToken && normalizeRepoUrlForWizard(r.url) === normalized) ?? null;
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
export function repoStepSignature(input: { codeMode: CodeMode; cloneUrl: string; cloneToken?: string; selectedRemoteUrls: Iterable<string> }): string {
  return JSON.stringify({
    codeMode: input.codeMode,
    cloneUrl: input.codeMode === 'clone' ? input.cloneUrl.trim() : '',
    // `cloneToken` is an input to the clone-mode repository step (it is
    // sent as `token` in the POST /repositories body) but was missing from
    // this signature — so `repoDone` stayed true after a successful
    // registration even when the operator corrected the token following a
    // LATER step's failure, and the corrected token was never persisted
    // (Issue #87 review, Important finding 3).
    cloneToken: input.codeMode === 'clone' ? (input.cloneToken ?? '').trim() : '',
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
  /** Confirm-step "詳細設定" values; omitted means the wizard's defaults ('' / 'manual-approval'). */
  tmuxSession?: string;
  inputPolicy?: EnvironmentInputPolicy;
}): string {
  return JSON.stringify({
    selectedServer: input.selectedServer,
    workingDirectory: input.workingDirectory,
    branch: input.branch,
    distributingRepositoryId: input.distributingRepositoryId,
    tmuxSession: input.tmuxSession ?? '',
    inputPolicy: input.inputPolicy ?? 'manual-approval',
  });
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
 * Whether a repository id the "clone" mode registration call returned
 * should be added to the wizard's own "rows this run created" tracking
 * list (the list a later signature-change cleans up — see
 * `repoIdsToCleanup`).
 *
 * `reused` comes straight from the server's `POST /repositories` response
 * (Issue #87 review, Important finding 2): when the server matched an
 * already-registered repository row by remote URL and returned that
 * EXISTING row (`reused: true`), the row was not created by this wizard
 * run and may still be in use by other environments/projects — tracking
 * it would let a later cleanup pass (triggered by editing the clone
 * URL/token and re-running) delete someone else's still-in-use row. Only
 * a genuinely new row (`reused: false`) belongs in the cleanup list.
 */
export function trackCreatedRepositoryId(createdRepositoryIds: number[], repoId: number, reused: boolean): number[] {
  return reused ? createdRepositoryIds : [...createdRepositoryIds, repoId];
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

// ───────────────────────────────────────────────────────────────────────────
// Code-step shape per server kind (Issue #87 follow-up: 隔離サーバーで壊れた
// 環境が作れてしまう). What the "code" step may offer is decided by the
// SERVER, not by the operator — the same rule the backend already enforces
// in `DistributionHelper` (local: never distributed / remote+isolated:
// always distributed / remote+non-isolated: opt-in).
// ───────────────────────────────────────────────────────────────────────────

/** The subset of `GET /api/servers` the wizard's code step depends on. */
export interface WizardServerRecord {
  name: string;
  type: string;
  isolationIntent?: boolean;
}

/**
 * Which shape the "code" step takes for the selected server.
 *
 * - `unresolved`: `GET /servers` hasn't landed yet (or the selection names
 *   no known server). Kept a distinct outcome for the same reason
 *   `resolveCloneDeliveryMode` does — guessing here is what produced
 *   environments that were neither cloned nor distributed.
 * - `local`: the hub itself. It is structurally excluded from distribution,
 *   so "clone" means an actual `git clone` run right now.
 * - `remote`: a non-isolated remote server. Distribution is optional
 *   (`distribute_code` opt-in), so the operator still picks between an
 *   existing directory, hub-代行配信, or deciding later.
 * - `isolated`: a remote server with `isolation_intent = 1`. It holds no git
 *   credentials at all, so the backend distributes to it UNCONDITIONALLY —
 *   there is nothing to choose, and offering "既存のディレクトリを使う" /
 *   "まだ決めない" produced an environment whose first task execution fails
 *   with `no_distribution_repository`.
 */
export type CodeStepVariant = 'unresolved' | 'local' | 'remote' | 'isolated';

export function resolveCodeStepVariant(selectedServer: string, serverList: WizardServerRecord[]): CodeStepVariant {
  if (!selectedServer.trim()) return 'unresolved';
  const record = serverList.find((sv) => sv.name === selectedServer);
  if (!record) return 'unresolved';
  if (clonesDirectlyOnServer(record.type)) return 'local';
  return record.isolationIntent === true ? 'isolated' : 'remote';
}

/**
 * The code-mode choices the step may offer for `variant`. An isolated
 * server gets NONE: delivery is fixed to hub-代行配信, so the step asks only
 * for the repository/token/target directory/branch that delivery needs.
 */
export function codeModeOptionsForVariant(variant: CodeStepVariant): CodeMode[] {
  if (variant === 'isolated') return [];
  return ['existing', 'clone', 'later'];
}

/**
 * The code mode the wizard actually acts on. Identical to the operator's
 * own selection everywhere except an isolated server, where it is forced to
 * `clone` — the mode whose persistence path registers the repository and
 * sends `distribute_code`/`distribution_repository_id`. This is what makes
 * "配信設定が必ず保存される" structural rather than a branch someone can
 * forget: every downstream derivation (validation, signatures, `handleRun`)
 * consumes this, never the raw selection.
 */
export function effectiveCodeMode(variant: CodeStepVariant, codeMode: CodeMode): CodeMode {
  return variant === 'isolated' ? 'clone' : codeMode;
}

/**
 * Whether the environment PUT must carry `distribute_code: true` +
 * `distribution_repository_id`. `local` never distributes (the hub clones
 * for itself); `unresolved` never decides (the caller fails visibly
 * instead); everything else distributes exactly when the effective mode is
 * `clone` and the repository step produced an id.
 */
export function shouldPersistDistribution(
  variant: CodeStepVariant,
  codeMode: CodeMode,
  repositoryId: number | null,
): boolean {
  if (variant === 'local' || variant === 'unresolved') return false;
  return effectiveCodeMode(variant, codeMode) === 'clone' && repositoryId !== null;
}

/** `project_servers.input_policy` values, mirroring the server-side union. */
export type EnvironmentInputPolicy = 'manual-approval' | 'deny' | 'allow';

export interface EnvironmentAdvancedSettings {
  tmux_session: string | null;
  input_policy: EnvironmentInputPolicy;
}

/**
 * Resolves the confirm step's collapsed "詳細設定" into the environment
 * PUT's `tmux_session` / `input_policy` fields. Untouched defaults ('' /
 * 'manual-approval') resolve to exactly the values the wizard hard-coded
 * before, so leaving the section closed changes nothing.
 *
 * `allow` is only meaningful for an isolated server (`PUT
 * /api/projects/:id/servers/:name` rejects it otherwise with 400, and
 * `ProjectSettings.tsx` only enables that option for one) — it is downgraded
 * here rather than sent and rejected, so a stale selection left behind by
 * switching servers can never fail the run.
 */
export function resolveEnvironmentAdvancedSettings(input: {
  tmuxSession: string;
  inputPolicy: EnvironmentInputPolicy;
  isolationIntent: boolean;
}): EnvironmentAdvancedSettings {
  const policy: EnvironmentInputPolicy = input.inputPolicy === 'allow' && !input.isolationIntent
    ? 'manual-approval'
    : input.inputPolicy;
  return { tmux_session: input.tmuxSession.trim() || null, input_policy: policy };
}

/**
 * What the confirm step states about delivery. `repositoryName` is the
 * 配信元 to name in the summary — `null` while the repository URL is still
 * empty, so the row can say "配信元が未設定" instead of an empty string.
 * Before this, distribution was switched on as a silent side effect of
 * picking "クローン" and never appeared on the confirmation screen at all.
 */
export interface DistributionSummary {
  distributed: boolean;
  repositoryName: string | null;
}

export function resolveDistributionSummary(
  variant: CodeStepVariant,
  codeMode: CodeMode,
  cloneUrl: string,
): DistributionSummary {
  const distributed = variant !== 'local' && variant !== 'unresolved' && effectiveCodeMode(variant, codeMode) === 'clone';
  if (!distributed) return { distributed: false, repositoryName: null };
  return { distributed: true, repositoryName: cloneUrl.trim() || null };
}
