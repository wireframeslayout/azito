import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';
import { Button, type InstallStep } from './ui';
import ProjectGeneralFields, { generateSlug } from './ProjectGeneralFields';
import { resolveRepositoryRegistration } from '../lib/repositoryForm';
import { notifyProjectsChanged } from '../lib/projectsChanged';
import { createRequestGuard, dedupeSelectableUrls } from './repoDiscoveryDialogLogic';
import {
  getVisibleSteps, canAdvanceFromStep, stepIndex, nextStep, deriveDefaultBranch,
  pickAvailableServer, isDiscoveryCurrent, resolveCloneDeliveryMode,
  repoStepSignature, envStepSignature, cloneStepSignature, repoIdsToCleanup, cleanupStaleRepositoryIds,
  findReusableRepositoryWithToken, needsDirectoryCreation, trackCreatedRepositoryId,
  resolveCodeStepVariant, effectiveCodeMode, shouldPersistDistribution,
  resolveEnvironmentAdvancedSettings, resolveDistributionSummary,
  type WizardStepId, type CodeMode, type WizardValidationState, type DiscoveryKey, type ReusableRepoCandidate,
  type EnvironmentInputPolicy,
} from '../lib/projectWizardLogic';
import {
  StepIndicator, EnvironmentStep, CodeStep, ConfirmStep,
  type ServerListItem, type DiscoveredRepo, type DiscoveryStatus,
} from './ProjectWizardSteps';
import { resolveBranchOnCandidateSelect, type RepositoryCandidate } from './repositoryCandidateInputLogic';

interface DiscoverResponse {
  exists: boolean;
  isGitRepository: boolean;
  repositories: DiscoveredRepo[];
}

interface ProjectWizardProps {
  /**
   * 'create': runs the full wizard starting at the "project" step and
   * creates a new project as its final action.
   * 'addEnvironment': starts directly at the "environment" step for an
   * EXISTING project (ProjectSettings's "add environment" entry point) —
   * see the module doc comment below for why this is the same component.
   */
  mode: 'create' | 'addEnvironment';
  /** Required for 'addEnvironment'; ignored for 'create' (the project doesn't exist yet). */
  projectId?: number;
  /** For 'addEnvironment': server names already configured for this project — shown disabled with a reason, not hidden (spec: keep them selectable-looking so the operator understands why). */
  existingServerNames?: string[];
  /** Called once the wizard's work is fully done. Receives the created/target project id. */
  onDone: (projectId: number) => void;
  onCancel: () => void;
  backLabel?: string;
  onBack?: () => void;
}

/**
 * Project-creation wizard (Issue: wizard-ize project creation). Also doubles
 * as the "add environment" flow opened from ProjectSettings — both need the
 * exact same environment/code/confirm steps (server choice, repository
 * discovery/clone-preview, and the create-time execution sequence with
 * partial-failure recovery), so rather than duplicate that logic across two
 * components, this ONE component renders the full step set for 'create' and
 * a subset (skipping the "project" step) for 'addEnvironment'. ProjectSettings
 * mounts this inline (spec: no separate screen) where its old add-environment
 * form used to live.
 */
export default function ProjectWizard({ mode, projectId, existingServerNames, onDone, onCancel, backLabel, onBack }: ProjectWizardProps) {
  const { t } = useTranslation(['projects', 'common']);
  const isMobile = useIsMobile();
  const { data: servers } = useApi<ServerListItem[]>('/servers');
  const serverList = useMemo(() => servers ?? [], [servers]);

  // ── Step 1: project fields (mode === 'create' only) ──
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [sidekickPrompt, setSidekickPrompt] = useState('');

  // ── Step 2: environment ──
  const [selectedServer, setSelectedServer] = useState('local');
  const serverAutoTouchedRef = useRef(false);

  // ── Step 3: code ──
  const [codeMode, setCodeMode] = useState<CodeMode>('later');
  const [existingPath, setExistingPath] = useState('');
  const [discovery, setDiscovery] = useState<DiscoveryStatus>('idle');
  const [discoveryKey, setDiscoveryKey] = useState<DiscoveryKey | null>(null);
  const [selectedRemoteUrls, setSelectedRemoteUrls] = useState<Set<string>>(new Set());
  const discoveryGuardRef = useRef(createRequestGuard());

  const [cloneUrl, setCloneUrl] = useState('');
  // No auto-derived default (Issue #87 review, Important finding 2): a
  // bare basename like `widgets` used to be filled in and accepted as-is,
  // then resolved against the HUB PROCESS's cwd at actual clone time —
  // wrong under a daemon/release deployment. The operator must pick an
  // absolute path explicitly via DirectoryInput.
  const [cloneDirectory, setCloneDirectory] = useState('');
  const [cloneToken, setCloneToken] = useState('');
  const [cloneBranch, setCloneBranch] = useState('main');
  // Whether the operator has edited the branch field by hand — once true,
  // picking a repository candidate must never silently overwrite it (see
  // resolveBranchOnCandidateSelect).
  const cloneBranchTouchedRef = useRef(false);
  const handleCloneBranchChange = useCallback((v: string) => {
    cloneBranchTouchedRef.current = true;
    setCloneBranch(v);
  }, []);
  const handleSelectRepoCandidate = useCallback((candidate: RepositoryCandidate) => {
    setCloneBranch((current) => resolveBranchOnCandidateSelect(cloneBranchTouchedRef.current, candidate.defaultBranch, current));
  }, []);

  // What the "code" step may offer is decided by the SERVER, not the
  // operator (Issue #87 follow-up): an isolated server holds no git
  // credentials, so the backend distributes to it unconditionally — the
  // step drops the choice and `effectiveMode` is forced to 'clone', the one
  // mode whose persistence path actually registers a repository and sends
  // `distribute_code`/`distribution_repository_id`. Every derivation below
  // consumes `effectiveMode`, never the raw `codeMode` selection, so an
  // isolated environment can no longer be created without distribution.
  const codeStepVariant = useMemo(
    () => resolveCodeStepVariant(selectedServer, serverList),
    [selectedServer, serverList],
  );
  const effectiveMode = effectiveCodeMode(codeStepVariant, codeMode);

  // ── Step 4: confirm / execution ──
  // Confirm-step "詳細設定" (collapsed by default). The defaults below are
  // exactly the values this wizard used to hard-code into the environment
  // PUT, so leaving the section closed keeps the previous behavior.
  const [tmuxSession, setTmuxSession] = useState('');
  const [inputPolicy, setInputPolicy] = useState<EnvironmentInputPolicy>('manual-approval');
  const [steps, setSteps] = useState<InstallStep[]>([]);
  const [running, setRunning] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<number | null>(mode === 'addEnvironment' ? (projectId ?? null) : null);
  const [createdRepositoryId, setCreatedRepositoryId] = useState<number | null>(null);
  // Every repository row id created by THIS wizard run's repository step
  // (single id for 'clone' mode, one or more for a bulk 'existing'-mode
  // registration) — tracked purely for cleanup, so a ref rather than state
  // (see `repoIdsToCleanup`/`cleanupStaleRepositoryIds` / the repo-signature
  // invalidation effect below; Issue #87 review, Important finding 1).
  const createdRepositoryIdsRef = useRef<number[]>([]);
  // The in-flight (or already-settled) cleanup delete(s) for the PREVIOUS
  // repo-step signature, chained so overlapping signature changes never
  // fire overlapping DELETE batches for the same ids. `handleRun` awaits
  // this before ever registering a repository, so a new registration can
  // never race ahead of the cleanup it depends on (Issue #87 review,
  // Important finding: 削除の完了を待たずに再登録するため、リポジトリが
  // 失われる).
  const pendingRepoCleanupRef = useRef<Promise<void>>(Promise.resolve());
  const [envDone, setEnvDone] = useState(false);
  const [repoDone, setRepoDone] = useState(false);
  const [localCloneDone, setLocalCloneDone] = useState(false);
  // Whether the wizard has already created the "existing directory" step's
  // root on the target server (Issue #87 review, Important finding 1: the
  // UI used to say "このパスを作成します" for a path discovery reported
  // missing, but nothing ever created it — task execution's containment
  // resolution then failed against a root that never existed).
  const [directoryCreated, setDirectoryCreated] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Project repositories already registered — used to detect a clone URL
  // that matches an existing, already-credentialed repository (Issue #87
  // review, Important finding 3), so the wizard can skip asking for a
  // token it doesn't need. Only fetched once a project id is known (either
  // 'addEnvironment' mode from the start, or 'create' mode after step 1).
  const { data: projectDetail } = useApi<{ repositories: ReusableRepoCandidate[] }>(
    createdProjectId !== null ? `/projects/${createdProjectId}` : null,
  );
  const existingRepositories = useMemo(() => projectDetail?.repositories ?? [], [projectDetail]);

  const existingServerList = useMemo(() => existingServerNames ?? [], [existingServerNames]);
  // 'addEnvironment' always shows the environment step — choosing which
  // not-yet-added server to configure is this mode's entire purpose, and it
  // must render even with zero remaining choices so the "none left" message
  // has somewhere to appear (Issue #87 review, Important finding 2).
  // getVisibleSteps(2) is a sentinel that forces the step present regardless
  // of the real server count; 'create' mode is unaffected (existingServerNames is empty there).
  const visibleSteps = useMemo(
    () => (mode === 'create' ? getVisibleSteps(serverList.length) : getVisibleSteps(2).filter((s) => s !== 'project')),
    [mode, serverList.length],
  );
  const [currentStep, setCurrentStep] = useState<WizardStepId>(visibleSteps[0]);

  // Auto-select an available server: never one already configured for this
  // project (Issue #87 review, Important finding 2) — the old version only
  // checked that `selectedServer` existed in `serverList` at all, so a
  // `local` default left over from a previous "add environment" run could
  // sit selected-but-invalid (a disabled <option> can't actually be chosen,
  // yet the state variable never noticed).
  useEffect(() => {
    if (serverAutoTouchedRef.current) return;
    const names = serverList.map((sv) => sv.name);
    const next = pickAvailableServer(names, existingServerList, selectedServer);
    if (next !== selectedServer) setSelectedServer(next);
  }, [serverList, existingServerList, selectedServer]);

  // `allow` is only accepted for an isolated server (PUT rejects it with
  // 400 otherwise). Switching to a non-isolated server must not leave the
  // selection stranded on a now-disabled option — reset it, so what the
  // confirm step shows is what actually gets sent.
  useEffect(() => {
    if (codeStepVariant !== 'isolated') setInputPolicy((p) => (p === 'allow' ? 'manual-approval' : p));
  }, [codeStepVariant]);

  // Keep currentStep valid if visibleSteps changes shape (e.g. servers finish loading and the environment step appears/disappears).
  useEffect(() => {
    if (!visibleSteps.includes(currentStep)) setCurrentStep(visibleSteps[0]);
  }, [visibleSteps, currentStep]);

  const runDiscovery = useCallback(async (path: string, server: string) => {
    const requestId = discoveryGuardRef.current.start();
    setDiscovery('checking');
    try {
      const { status, body } = await apiWithStatus<DiscoverResponse | { error: string }>(
        `/servers/${encodeURIComponent(server)}/discover-repositories?path=${encodeURIComponent(path)}`,
      );
      if (!discoveryGuardRef.current.isCurrent(requestId)) return;
      if (status !== 200 || !('repositories' in body)) {
        setDiscovery('error');
        return;
      }
      setDiscovery({ repos: body.repositories, exists: body.exists, isGitRepository: body.isGitRepository });
      setDiscoveryKey({ server, path: path.trim() });
      setSelectedRemoteUrls(new Set(dedupeSelectableUrls(body.repositories.flatMap((r) => r.remotes))));
    } catch {
      if (discoveryGuardRef.current.isCurrent(requestId)) setDiscovery('error');
    }
  }, []);

  // Any change to the path or server invalidates whatever discovery was in
  // flight or previously resolved — reset SYNCHRONOUSLY (in the same effect
  // pass, before the debounced fetch below is even scheduled) so a fast
  // "next" click right after editing the path can never register a
  // stale/previous result (Issue #87 review, Important finding 3: the old
  // debounce-only handler left the previous discovery/selection live for
  // 400ms after every keystroke).
  useEffect(() => {
    discoveryGuardRef.current.start();
    setDiscovery('idle');
    setDiscoveryKey(null);
    setSelectedRemoteUrls(new Set());

    if (effectiveMode !== 'existing' || !existingPath.trim() || !selectedServer) return;
    const handle = setTimeout(() => { runDiscovery(existingPath, selectedServer); }, 400);
    return () => clearTimeout(handle);
  }, [existingPath, selectedServer, effectiveMode, runDiscovery]);

  const toggleRemoteSelected = useCallback((url: string) => {
    setSelectedRemoteUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }, []);

  const discoveryReady = typeof discovery === 'object' && isDiscoveryCurrent(discoveryKey, selectedServer, existingPath);

  // Whether "clone" mode clones directly on the selected server (local) or
  // relies on the hub's existing distribution path — kept as a 3-way result
  // ('local' | 'distributed' | 'unresolved') rather than folding "the
  // server record hasn't loaded yet" into "distributed" (review finding:
  // "サーバー種別が未解決のとき「リモート扱い」になる"). `serverList` starts
  // empty until `GET /servers` resolves, so a fast wizard run can otherwise
  // reach execute() before the selected server's type is known.
  const cloneDeliveryMode = useMemo(
    () => resolveCloneDeliveryMode(effectiveMode, selectedServer, serverList),
    [effectiveMode, selectedServer, serverList],
  );
  const cloningLocally = cloneDeliveryMode === 'local';
  const serverTypeUnresolvedForClone = cloneDeliveryMode === 'unresolved';

  // An already-registered, already-credentialed repository for this same
  // URL (Issue #87 review, Important finding 3) — when found, the wizard
  // can proceed on a non-local target without collecting a new token.
  const reusableRepo = useMemo(
    () => (effectiveMode === 'clone' ? findReusableRepositoryWithToken(cloneUrl, existingRepositories) : null),
    [effectiveMode, cloneUrl, existingRepositories],
  );

  const validationState: WizardValidationState = {
    projectName: name, projectSlug: slug, selectedServer, codeMode: effectiveMode, existingPath, cloneUrl, cloneDirectory,
    existingServerNames: existingServerList, discoveryReady,
    cloneTargetIsLocal: cloningLocally, cloneToken, cloneRepoReusableWithToken: reusableRepo !== null,
  };
  const canAdvance = canAdvanceFromStep(currentStep, validationState);
  const availableServerCount = serverList.filter((sv) => !existingServerList.includes(sv.name)).length;
  const noServersAvailable = mode === 'addEnvironment' && availableServerCount === 0;

  const goNext = useCallback(() => setCurrentStep((s) => nextStep(visibleSteps, s, 1)), [visibleSteps]);
  const goBack = useCallback(() => setCurrentStep((s) => nextStep(visibleSteps, s, -1)), [visibleSteps]);

  const isLastStep = stepIndex(visibleSteps, currentStep) === visibleSteps.length - 1;

  const repositoriesToRegister = useMemo(() => {
    if (effectiveMode !== 'existing') return [];
    if (discovery === 'idle' || discovery === 'checking' || discovery === 'error') return [];
    return discovery.repos
      .flatMap((r) => r.remotes)
      .filter((r) => selectedRemoteUrls.has(r.url))
      .map((r) => ({ url: r.url, provider: r.provider, owner: r.owner ?? undefined, repoName: r.repoName ?? undefined }));
  }, [effectiveMode, discovery, selectedRemoteUrls]);

  // "existing directory" mode where discovery reported the path missing —
  // the wizard must actually create it (Issue #87 review, Important
  // finding 1) rather than just saving it as `working_directory`.
  const pathNeedsCreation = needsDirectoryCreation(effectiveMode, typeof discovery === 'object' ? discovery.exists : null);

  const environmentWorkingDirectory = effectiveMode === 'existing' ? existingPath.trim()
    : effectiveMode === 'clone' ? cloneDirectory.trim()
    : '';
  // Only meaningful once the repository step has actually produced an id —
  // `createdRepositoryId` invalidates back to `null` (see the repo-step
  // signature effect below) whenever the inputs that produced it change.
  const distributingRepositoryId = cloneDeliveryMode === 'distributed' ? createdRepositoryId : null;

  // ── Completion-flag invalidation (review finding: "完了フラグが入力と
  // 結びついていない"). Each confirm-step success flag is compared against
  // a signature of the inputs it actually consumed; the moment that
  // signature changes (the user went back and edited something), the flag
  // — and any id it produced — is invalidated so the next run re-executes
  // that step instead of skipping it as "already done" against stale
  // inputs. A step that already succeeded AND whose inputs are unchanged is
  // deliberately left alone, preserving "resume after a failed step"
  // without re-running work that is still valid. ──
  const repoSignature = repoStepSignature({ codeMode: effectiveMode, cloneUrl, cloneToken, selectedRemoteUrls });
  const repoSignatureRef = useRef(repoSignature);
  useEffect(() => {
    const signatureChanged = repoSignatureRef.current !== repoSignature;
    if (!signatureChanged) return;
    repoSignatureRef.current = repoSignature;
    setRepoDone(false);
    setCreatedRepositoryId(null);
    // Delete whatever THIS wizard run already persisted for the repository
    // step before letting it re-run — `/repositories`(`/bulk`) is
    // append-only, so re-registering without cleanup left the previous
    // run's row(s) as orphaned duplicates (Issue #87 review, Important
    // finding 1). The ids stay tracked (NOT cleared here) until the delete
    // requests actually settle — `handleRun` awaits `pendingRepoCleanupRef`
    // before registering anything, so a fast re-registration can never run
    // ahead of this cleanup and end up re-adding a row whose delete hadn't
    // landed yet (Issue #87 review, Important finding: 削除の完了を待たず
    // に再登録するため、リポジトリが失われる). Chained onto any previous
    // pending cleanup so overlapping signature changes never issue
    // overlapping DELETE batches for the same ids.
    const idsToDelete = repoIdsToCleanup(createdRepositoryIdsRef.current, true);
    if (idsToDelete.length === 0 || createdProjectId === null) return;
    const pid = createdProjectId;
    const previousCleanup = pendingRepoCleanupRef.current;
    pendingRepoCleanupRef.current = (async () => {
      await previousCleanup;
      // Ids whose DELETE did not come back 2xx stay tracked so a later
      // cleanup pass retries them instead of the id being silently lost
      // (Issue #87 review, Important finding: エラー状態が無視され、後始
      // 末に必要な ID が恒久的に失われる).
      const stillOrphaned = await cleanupStaleRepositoryIds(
        idsToDelete,
        (id) => apiWithStatus(`/projects/${pid}/repositories/${id}`, { method: 'DELETE' }),
      );
      createdRepositoryIdsRef.current = stillOrphaned;
    })();
  }, [repoSignature, createdProjectId]);

  const envSignature = envStepSignature({
    selectedServer, workingDirectory: environmentWorkingDirectory,
    branch: effectiveMode === 'clone' ? cloneBranch.trim() : '', distributingRepositoryId,
    tmuxSession, inputPolicy,
  });
  const envSignatureRef = useRef(envSignature);
  useEffect(() => {
    if (envSignatureRef.current !== envSignature) {
      envSignatureRef.current = envSignature;
      setEnvDone(false);
    }
  }, [envSignature]);

  const cloneSignature = cloneStepSignature({
    selectedServer, cloneDirectory: cloneDirectory.trim(), cloneBranch: cloneBranch.trim(), repositoryId: createdRepositoryId,
  });
  const cloneSignatureRef = useRef(cloneSignature);
  useEffect(() => {
    if (cloneSignatureRef.current !== cloneSignature) {
      cloneSignatureRef.current = cloneSignature;
      setLocalCloneDone(false);
    }
  }, [cloneSignature]);

  // Directory-creation completion flag (Issue #87 review, Important
  // finding 1), same invalidation pattern as the other confirm-step flags
  // above: a directory already created for one server+path combination
  // must not be treated as "done" once the operator goes back and picks a
  // different server or path.
  const directorySignature = effectiveMode === 'existing' ? `${selectedServer}::${existingPath.trim()}` : '';
  const directorySignatureRef = useRef(directorySignature);
  useEffect(() => {
    if (directorySignatureRef.current !== directorySignature) {
      directorySignatureRef.current = directorySignature;
      setDirectoryCreated(false);
    }
  }, [directorySignature]);

  const setStep = useCallback((stepName: string, status: InstallStep['status'], message: string) => {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.step === stepName);
      const entry = { step: stepName, status, message };
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
  }, []);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    try {
      // Step: project (create mode only — 'addEnvironment' already has one).
      // Uses apiWithStatus + an explicit 2xx/shape check (Issue #87 review,
      // Important finding 1): api() returns a 4xx/5xx `{ error }` body the
      // same way it returns a success body, so a slug conflict or any other
      // rejection used to be reported to the UI as "done".
      let pid = createdProjectId;
      if (mode === 'create' && pid === null) {
        setStep('project', 'running', t('wizard.steps.project'));
        try {
          const { status, body } = await apiWithStatus<{ id: number } | { error: string }>('/projects', {
            method: 'POST',
            body: JSON.stringify({
              name: name.trim(), slug: slug.trim(), description: description.trim(),
              default_branch: deriveDefaultBranch(effectiveMode, cloneBranch),
              sidekick_prompt: sidekickPrompt.trim(), icon: icon.trim() || null, color: color.trim() || null,
            }),
          });
          if (status < 200 || status >= 300 || !('id' in body) || typeof body.id !== 'number') {
            throw new Error(('error' in body && body.error) || t('wizard.errors.projectFailed'));
          }
          pid = body.id;
          setCreatedProjectId(pid);
          notifyProjectsChanged();
          setStep('project', 'ok', t('wizard.steps.project'));
        } catch (err) {
          setStep('project', 'error', (err as Error).message);
          throw err;
        }
      } else if (mode === 'create') {
        setStep('project', 'ok', t('wizard.steps.project'));
      }

      // Defense in depth (Issue #87 review, Important finding 2): the
      // environment step already blocks advancing past it, and the primary
      // button is disabled when nothing is left to select — but the
      // environment PUT below must never overwrite an already-configured
      // server's settings even if reached some other way.
      if (mode === 'addEnvironment' && existingServerList.includes(selectedServer)) {
        throw new Error(t('wizard.environment.alreadyAddedError', { server: selectedServer }));
      }

      // Defense in depth (Issue #87 review, Important finding 3): the code
      // step already blocks advancing while a non-local clone target has
      // no token and no reusable credentialed repository — but re-verify
      // here in case the operator changed the server/URL after already
      // passing that step once.
      if (effectiveMode === 'clone' && !cloningLocally && !serverTypeUnresolvedForClone && reusableRepo === null && !cloneToken.trim()) {
        throw new Error(t('wizard.errors.cloneTokenRequired'));
      }

      // Step: directory. "既存のディレクトリを使う" with a path discovery
      // reported missing means the wizard told the operator "このパスを
      // 作成します" — it must actually create it before saving it as the
      // environment's working_directory, or task execution's containment
      // resolution later fails against a root that was never created
      // (Issue #87 review, Important finding 1).
      if (pid !== null && pathNeedsCreation && !directoryCreated) {
        setStep('directory', 'running', t('wizard.confirm.stepDirectory'));
        try {
          const { status, body } = await apiWithStatus<{ ok: true } | { error: string }>(
            `/servers/${encodeURIComponent(selectedServer)}/directories`,
            { method: 'POST', body: JSON.stringify({ path: existingPath.trim() }) },
          );
          if (status < 200 || status >= 300) {
            throw new Error(('error' in body && body.error) || t('wizard.errors.directoryFailed'));
          }
          setDirectoryCreated(true);
          setStep('directory', 'ok', t('wizard.confirm.stepDirectory'));
        } catch (err) {
          setStep('directory', 'error', (err as Error).message);
          throw err;
        }
      }

      // Step: repository. Registered BEFORE environment (Issue #87 review,
      // Important finding 4) — the environment PUT for a non-local "clone"
      // target needs the repository's own id to set distribution_repository_id.
      let repoId = createdRepositoryId;
      if (pid !== null && !repoDone) {
        // Never register a new/updated repository set while a stale-signature
        // cleanup from a previous selection is still deleting rows — doing so
        // let the bulk-registration call run ahead of the delete, see it as
        // "already exists", skip re-adding it, and then have the in-flight
        // delete remove it out from under the just-registered set (Issue #87
        // review, Important finding: 削除の完了を待たずに再登録するため、
        // リポジトリが失われる).
        await pendingRepoCleanupRef.current;
        if (effectiveMode === 'existing' && repositoriesToRegister.length > 0) {
          setStep('repository', 'running', t('wizard.confirm.stepRepository'));
          try {
            const { status, body } = await apiWithStatus<{ added: number; ids?: number[] } | { error: string }>(
              `/projects/${pid}/repositories/bulk`,
              { method: 'POST', body: JSON.stringify({ repositories: repositoriesToRegister }) },
            );
            if (status < 200 || status >= 300) {
              throw new Error(('error' in body && body.error) || t('wizard.errors.repositoryFailed'));
            }
            // Track every row this call created, UNIONED with any id a
            // previous cleanup pass still failed to delete (Issue #87
            // review, Important finding 1 + エラー状態が無視され後始末に
            // 必要な ID が失われる) — overwriting instead of merging would
            // silently drop those still-orphaned ids from tracking, the
            // same "lost id" bug for a different reason. A later retry
            // then attempts all of them again — see the repo-signature
            // invalidation effect above.
            createdRepositoryIdsRef.current = [
              ...createdRepositoryIdsRef.current,
              ...('ids' in body && Array.isArray(body.ids) ? body.ids : []),
            ];
            setRepoDone(true);
            setStep('repository', 'ok', t('wizard.confirm.stepRepository'));
          } catch (err) {
            setStep('repository', 'error', (err as Error).message);
            throw err;
          }
        } else if (effectiveMode === 'clone' && cloneUrl.trim()) {
          setStep('repository', 'running', t('wizard.confirm.stepRepository'));
          try {
            const parsed = resolveRepositoryRegistration(cloneUrl.trim());
            const { status, body } = await apiWithStatus<{ id: number; reused: boolean } | { error: string }>(
              `/projects/${pid}/repositories`,
              {
                method: 'POST',
                body: JSON.stringify({
                  url: cloneUrl.trim(), provider: parsed.provider,
                  owner: parsed.owner ?? undefined, repo_name: parsed.repoName ?? undefined,
                  token: cloneToken.trim() || undefined,
                }),
              },
            );
            if (status < 200 || status >= 300 || !('id' in body) || typeof body.id !== 'number') {
              throw new Error(('error' in body && body.error) || t('wizard.errors.repositoryFailed'));
            }
            repoId = body.id;
            setCreatedRepositoryId(repoId);
            // Only track ids this wizard run actually CREATED — a `reused`
            // row (an existing repository the server matched by remote
            // URL, possibly used by other environments too) must never
            // enter the cleanup-on-signature-change list, or a later step's
            // failure followed by editing the clone URL/token would delete
            // someone else's still-in-use repository row (Issue #87
            // review, Important finding 2).
            createdRepositoryIdsRef.current = trackCreatedRepositoryId(createdRepositoryIdsRef.current, repoId, body.reused);
            setRepoDone(true);
            setStep('repository', 'ok', t('wizard.confirm.stepRepository'));
          } catch (err) {
            setStep('repository', 'error', (err as Error).message);
            throw err;
          }
        } else {
          setRepoDone(true);
        }
      }

      // Step: environment. In 'create' mode, a "code" step of "later" (no
      // root entered) creates nothing here — spec: "ルートも未入力なら
      // project_servers を作らない". In 'addEnvironment' mode the whole
      // point of the wizard run is to add this environment, so it is
      // always created once a server is selected, root or not (the
      // pre-existing "add environment" form this replaces worked the same
      // way — workingDirectory was always optional there too).
      // Never proceed while the selected server's own record hasn't
      // resolved yet — folding "unresolved" into "distributed" used to
      // leave an environment that is neither cloned locally nor set up for
      // distribution (review finding: "サーバー種別が未解決のとき「リモー
      // ト扱い」になる"). Fail visibly instead of guessing.
      if (effectiveMode === 'clone' && serverTypeUnresolvedForClone) {
        throw new Error(t('wizard.errors.serverTypeUnresolved', { server: selectedServer }));
      }
      // An isolated server MUST carry distribution — `shouldPersistDistribution`
      // derives that from the server itself (via `effectiveCodeMode`), so
      // the flags below are no longer a side effect of the operator having
      // happened to pick "クローン".
      const distributingClone = shouldPersistDistribution(codeStepVariant, codeMode, repoId);
      const advanced = resolveEnvironmentAdvancedSettings({
        tmuxSession, inputPolicy, isolationIntent: codeStepVariant === 'isolated',
      });
      const wantsEnvironment = !!selectedServer && (mode === 'addEnvironment' || effectiveMode !== 'later');
      if (wantsEnvironment && pid !== null) {
        if (!envDone) {
          setStep('environment', 'running', t('wizard.confirm.stepEnvironment'));
          try {
            const { status, body } = await apiWithStatus<{ ok: true } | { error: string }>(
              `/projects/${pid}/servers/${selectedServer}`,
              {
                method: 'PUT',
                body: JSON.stringify({
                  working_directory: environmentWorkingDirectory || null,
                  branch: effectiveMode === 'clone' ? (cloneBranch.trim() || null) : null,
                  tmux_session: advanced.tmux_session,
                  input_policy: advanced.input_policy,
                  // 'local' IS the hub — distribution is provisioned by an
                  // explicit clone-local call below instead (Issue #87
                  // review, Important finding 4).
                  ...(distributingClone ? { distribute_code: true, distribution_repository_id: repoId } : {}),
                }),
              },
            );
            if (status < 200 || status >= 300) {
              throw new Error(('error' in body && body.error) || t('wizard.errors.environmentFailed'));
            }
            setEnvDone(true);
            setStep('environment', 'ok', t('wizard.confirm.stepEnvironment'));
          } catch (err) {
            setStep('environment', 'error', (err as Error).message);
            throw err;
          }
        } else {
          setStep('environment', 'ok', t('wizard.confirm.stepEnvironment'));
        }
      }

      // Step: local clone. Only for a `local` server in "clone" mode — the
      // hub excludes itself from distribution, so this is the only path
      // that actually puts code on disk for it (Issue #87 review, Important
      // finding 4).
      if (pid !== null && cloningLocally && repoId !== null && !localCloneDone) {
        setStep('clone', 'running', t('wizard.confirm.stepClone'));
        try {
          const { status, body } = await apiWithStatus<{ ok: true } | { error: string }>(
            `/projects/${pid}/servers/${selectedServer}/clone-local`,
            {
              method: 'POST',
              body: JSON.stringify({
                repository_id: repoId, target_directory: cloneDirectory.trim(), branch: cloneBranch.trim() || 'main',
              }),
            },
          );
          if (status < 200 || status >= 300) {
            throw new Error(('error' in body && body.error) || t('wizard.errors.cloneFailed'));
          }
          setLocalCloneDone(true);
          setStep('clone', 'ok', t('wizard.confirm.stepClone'));
        } catch (err) {
          setStep('clone', 'error', (err as Error).message);
          throw err;
        }
      }

      if (pid !== null) onDone(pid);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [
    mode, createdProjectId, createdRepositoryId, name, slug, description, sidekickPrompt, icon, color,
    selectedServer, existingServerList, codeMode, effectiveMode, codeStepVariant, tmuxSession, inputPolicy,
    existingPath, cloneDirectory, cloneBranch, cloneUrl, cloneToken,
    envDone, repoDone, localCloneDone, directoryCreated, pathNeedsCreation, reusableRepo, repositoriesToRegister, onDone, setStep, t,
    cloningLocally, serverTypeUnresolvedForClone, environmentWorkingDirectory,
  ]);

  // Stated outright on the confirm step — distribution used to be enabled
  // as an unannounced side effect of the "clone" choice.
  const distributionSummary = resolveDistributionSummary(codeStepVariant, codeMode, cloneUrl);

  const primaryLabel = isLastStep ? t('wizard.create') : t('wizard.next');
  const primaryAction = isLastStep ? handleRun : goNext;
  // noServersAvailable is a last-resort guard (Issue #87 review, Important
  // finding 2): reaching 'confirm' with an empty selection should already
  // be unreachable, since canAdvanceFromStep('environment', ...) blocks
  // leaving that step while selectedServer is '' — but the primary button
  // must never complete the wizard on this condition either way.
  // serverTypeUnresolvedForClone blocks the SAME way, proactively: the
  // selected server's record hasn't resolved yet, so completing now would
  // create an environment with neither a local clone nor distribution
  // configured (review finding: "サーバー種別が未解決のとき「リモート扱
  // い」になる"). handleRun also throws on this as defense in depth, for
  // any other path that reaches it.
  // cloneTokenRequired mirrors the same defense-in-depth as the other two:
  // canAdvanceFromStep('code', ...) already blocks leaving that step
  // without a token/reusable credentialed repository for a non-local clone
  // target, but the operator could reach 'confirm', go back, change the
  // server or URL, and jump forward without re-triggering that check
  // (Issue #87 review, Important finding 3).
  const cloneTokenRequired = effectiveMode === 'clone' && !cloningLocally && !serverTypeUnresolvedForClone && reusableRepo === null && !cloneToken.trim();
  const primaryDisabled = isLastStep ? (noServersAvailable || serverTypeUnresolvedForClone || cloneTokenRequired) : !canAdvance;

  // 'addEnvironment' is hosted inside a Modal (components/settings/
  // EnvironmentModals.tsx's AddEnvironmentModal), opened from the project
  // settings' server-environment list. The modal already supplies the
  // surface, the title and the Cancel affordance, so this mode renders
  // neither a card of its own nor the full-height sticky-header/footer
  // chrome the create-project route uses — only the steps and the
  // Back/Next row.
  const inModal = mode === 'addEnvironment';

  return (
    <div style={inModal ? undefined : { height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {!inModal && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border)',
          background: 'var(--bg-card)', flexShrink: 0, gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {backLabel && onBack && (
              <button
                onClick={onBack}
                style={{ background: 'none', border: 'none', padding: 0, marginBottom: 4, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', cursor: 'pointer' }}
              >
                ← {backLabel}
              </button>
            )}
            <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 600, margin: 0 }}>
              {t('form.newProject')}
            </h2>
          </div>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 16px', background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            {t('wizard.cancel')}
          </button>
        </div>
      )}

      <StepIndicator visibleSteps={visibleSteps} currentStep={currentStep} isMobile={isMobile} t={t} />

      {runError && (
        <div role="alert" style={{
          padding: '8px 12px', margin: inModal ? 'var(--space-3) 0 0' : 'var(--space-4) var(--space-4) 0', borderRadius: 'var(--radius-sm)',
          background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)', color: 'var(--danger)', fontSize: 'var(--font-md)',
        }}>
          {runError}
        </div>
      )}

      <div style={inModal ? undefined : { flex: 1, overflowY: 'auto' }}>
        <div style={inModal ? { padding: 'var(--space-4) 0' } : { maxWidth: 720, margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
          {currentStep === 'project' && (
            <ProjectGeneralFields
              name={name} setName={(v) => { setName(v); if (!slugManuallyEdited) setSlug(generateSlug(v)); }}
              slug={slug} setSlug={setSlug} slugManuallyEdited={slugManuallyEdited} setSlugManuallyEdited={setSlugManuallyEdited}
              description={description} setDescription={setDescription}
              icon={icon} setIcon={setIcon} color={color} setColor={setColor}
              sidekickPrompt={sidekickPrompt} setSidekickPrompt={setSidekickPrompt}
            />
          )}

          {currentStep === 'environment' && (
            <EnvironmentStep
              t={t} serverList={serverList} selectedServer={selectedServer}
              setSelectedServer={(v) => { serverAutoTouchedRef.current = true; setSelectedServer(v); }}
              existingServerNames={existingServerNames}
              showValidation={!canAdvance}
              noServersAvailable={noServersAvailable}
            />
          )}

          {currentStep === 'code' && (
            <CodeStep
              t={t} codeMode={codeMode} setCodeMode={setCodeMode}
              selectedServer={selectedServer}
              variant={codeStepVariant}
              existingPath={existingPath} onExistingPathChange={setExistingPath}
              discovery={discovery}
              selectedRemoteUrls={selectedRemoteUrls} toggleRemoteSelected={toggleRemoteSelected}
              cloneUrl={cloneUrl} setCloneUrl={setCloneUrl} onSelectRepoCandidate={handleSelectRepoCandidate}
              cloneDirectory={cloneDirectory}
              setCloneDirectory={setCloneDirectory}
              cloneBranch={cloneBranch} setCloneBranch={handleCloneBranchChange}
              cloneToken={cloneToken} setCloneToken={setCloneToken}
              reusableRepo={reusableRepo}
              showValidation={!canAdvance}
            />
          )}

          {currentStep === 'confirm' && (
            <ConfirmStep
              t={t} mode={mode}
              name={name} selectedServer={selectedServer} showEnvironmentStep={visibleSteps.includes('environment')}
              codeMode={effectiveMode} existingPath={existingPath} cloneUrl={cloneUrl} cloneDirectory={cloneDirectory}
              distribution={distributionSummary}
              tmuxSession={tmuxSession} setTmuxSession={setTmuxSession}
              inputPolicy={inputPolicy} setInputPolicy={setInputPolicy}
              allowPolicyAvailable={codeStepVariant === 'isolated'}
              steps={steps} running={running} alreadyCreated={createdProjectId !== null}
            />
          )}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: inModal ? 0 : 'var(--space-3) var(--space-4)',
        borderTop: inModal ? undefined : '1px solid var(--border)',
        background: inModal ? undefined : 'var(--bg-card)', flexShrink: 0,
      }}>
        <Button
          onClick={goBack}
          disabled={stepIndex(visibleSteps, currentStep) === 0 || running}
          style={{ visibility: stepIndex(visibleSteps, currentStep) === 0 ? 'hidden' : 'visible' }}
        >
          {t('wizard.back')}
        </Button>
        <Button
          variant="primary"
          onClick={primaryAction}
          disabled={primaryDisabled}
          loading={running}
          loadingLabel={t('wizard.creating')}
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}
