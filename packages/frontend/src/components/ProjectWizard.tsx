import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';
import { Button, type InstallStep } from './ui';
import ProjectGeneralFields, { generateSlug } from './ProjectGeneralFields';
import { notifyProjectsChanged } from '../lib/projectsChanged';
import { createRequestGuard, dedupeSelectableUrls } from './repoDiscoveryDialogLogic';
import {
  getVisibleSteps, canAdvanceFromStep, stepIndex, nextStep, deriveCloneDirectoryName, deriveDefaultBranch,
  pickAvailableServer, isDiscoveryCurrent, clonesDirectlyOnServer,
  type WizardStepId, type CodeMode, type WizardValidationState, type DiscoveryKey,
} from '../lib/projectWizardLogic';
import {
  StepIndicator, EnvironmentStep, CodeStep, ConfirmStep, parseCloneUrlForRegistration,
  type ServerListItem, type DiscoveredRepo, type DiscoveryStatus,
} from './ProjectWizardSteps';

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
  const [cloneDirectory, setCloneDirectory] = useState('');
  const cloneDirectoryTouchedRef = useRef(false);
  const [cloneBranch, setCloneBranch] = useState('main');

  // ── Step 4: confirm / execution ──
  const [steps, setSteps] = useState<InstallStep[]>([]);
  const [running, setRunning] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<number | null>(mode === 'addEnvironment' ? (projectId ?? null) : null);
  const [createdRepositoryId, setCreatedRepositoryId] = useState<number | null>(null);
  const [envDone, setEnvDone] = useState(false);
  const [repoDone, setRepoDone] = useState(false);
  const [localCloneDone, setLocalCloneDone] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

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

  // Keep currentStep valid if visibleSteps changes shape (e.g. servers finish loading and the environment step appears/disappears).
  useEffect(() => {
    if (!visibleSteps.includes(currentStep)) setCurrentStep(visibleSteps[0]);
  }, [visibleSteps, currentStep]);

  // Auto-derive the clone target directory from the URL until the user edits it directly.
  useEffect(() => {
    if (!cloneDirectoryTouchedRef.current) setCloneDirectory(deriveCloneDirectoryName(cloneUrl));
  }, [cloneUrl]);

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

    if (codeMode !== 'existing' || !existingPath.trim() || !selectedServer) return;
    const handle = setTimeout(() => { runDiscovery(existingPath, selectedServer); }, 400);
    return () => clearTimeout(handle);
  }, [existingPath, selectedServer, codeMode, runDiscovery]);

  const toggleRemoteSelected = useCallback((url: string) => {
    setSelectedRemoteUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }, []);

  const discoveryReady = typeof discovery === 'object' && isDiscoveryCurrent(discoveryKey, selectedServer, existingPath);

  const validationState: WizardValidationState = {
    projectName: name, projectSlug: slug, selectedServer, codeMode, existingPath, cloneUrl, cloneDirectory,
    existingServerNames: existingServerList, discoveryReady,
  };
  const canAdvance = canAdvanceFromStep(currentStep, validationState);
  const availableServerCount = serverList.filter((sv) => !existingServerList.includes(sv.name)).length;
  const noServersAvailable = mode === 'addEnvironment' && availableServerCount === 0;

  const goNext = useCallback(() => setCurrentStep((s) => nextStep(visibleSteps, s, 1)), [visibleSteps]);
  const goBack = useCallback(() => setCurrentStep((s) => nextStep(visibleSteps, s, -1)), [visibleSteps]);

  const isLastStep = stepIndex(visibleSteps, currentStep) === visibleSteps.length - 1;

  const repositoriesToRegister = useMemo(() => {
    if (codeMode !== 'existing') return [];
    if (discovery === 'idle' || discovery === 'checking' || discovery === 'error') return [];
    return discovery.repos
      .flatMap((r) => r.remotes)
      .filter((r) => selectedRemoteUrls.has(r.url))
      .map((r) => ({ url: r.url, provider: r.provider, owner: r.owner ?? undefined, repoName: r.repoName ?? undefined }));
  }, [codeMode, discovery, selectedRemoteUrls]);

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
              default_branch: deriveDefaultBranch(codeMode, cloneBranch),
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

      // Step: repository. Registered BEFORE environment (Issue #87 review,
      // Important finding 4) — the environment PUT for a non-local "clone"
      // target needs the repository's own id to set distribution_repository_id.
      let repoId = createdRepositoryId;
      if (pid !== null && !repoDone) {
        if (codeMode === 'existing' && repositoriesToRegister.length > 0) {
          setStep('repository', 'running', t('wizard.confirm.stepRepository'));
          try {
            const { status, body } = await apiWithStatus<{ added: number } | { error: string }>(
              `/projects/${pid}/repositories/bulk`,
              { method: 'POST', body: JSON.stringify({ repositories: repositoriesToRegister }) },
            );
            if (status < 200 || status >= 300) {
              throw new Error(('error' in body && body.error) || t('wizard.errors.repositoryFailed'));
            }
            setRepoDone(true);
            setStep('repository', 'ok', t('wizard.confirm.stepRepository'));
          } catch (err) {
            setStep('repository', 'error', (err as Error).message);
            throw err;
          }
        } else if (codeMode === 'clone' && cloneUrl.trim()) {
          setStep('repository', 'running', t('wizard.confirm.stepRepository'));
          try {
            const parsed = parseCloneUrlForRegistration(cloneUrl.trim());
            const { status, body } = await apiWithStatus<{ id: number } | { error: string }>(
              `/projects/${pid}/repositories`,
              {
                method: 'POST',
                body: JSON.stringify({
                  url: cloneUrl.trim(), provider: parsed.provider,
                  owner: parsed.owner ?? undefined, repo_name: parsed.repoName ?? undefined,
                }),
              },
            );
            if (status < 200 || status >= 300 || !('id' in body) || typeof body.id !== 'number') {
              throw new Error(('error' in body && body.error) || t('wizard.errors.repositoryFailed'));
            }
            repoId = body.id;
            setCreatedRepositoryId(repoId);
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
      const selectedServerType = serverList.find((sv) => sv.name === selectedServer)?.type;
      const cloningLocally = codeMode === 'clone' && clonesDirectlyOnServer(selectedServerType ?? '');
      const distributingClone = codeMode === 'clone' && !cloningLocally && repoId !== null;
      const wantsEnvironment = !!selectedServer && (mode === 'addEnvironment' || codeMode !== 'later');
      if (wantsEnvironment && pid !== null) {
        if (!envDone) {
          setStep('environment', 'running', t('wizard.confirm.stepEnvironment'));
          try {
            const workingDirectory = codeMode === 'existing' ? existingPath.trim()
              : codeMode === 'clone' ? cloneDirectory.trim()
              : '';
            const { status, body } = await apiWithStatus<{ ok: true } | { error: string }>(
              `/projects/${pid}/servers/${selectedServer}`,
              {
                method: 'PUT',
                body: JSON.stringify({
                  working_directory: workingDirectory || null,
                  branch: codeMode === 'clone' ? (cloneBranch.trim() || null) : null,
                  tmux_session: null,
                  input_policy: 'manual-approval',
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
    selectedServer, serverList, existingServerList, codeMode, existingPath, cloneDirectory, cloneBranch, cloneUrl,
    envDone, repoDone, localCloneDone, repositoriesToRegister, onDone, setStep, t,
  ]);

  const primaryLabel = isLastStep ? t('wizard.create') : t('wizard.next');
  const primaryAction = isLastStep ? handleRun : goNext;
  // noServersAvailable is a last-resort guard (Issue #87 review, Important
  // finding 2): reaching 'confirm' with an empty selection should already
  // be unreachable, since canAdvanceFromStep('environment', ...) blocks
  // leaving that step while selectedServer is '' — but the primary button
  // must never complete the wizard on this condition either way.
  const primaryDisabled = isLastStep ? noServersAvailable : !canAdvance;

  // 'addEnvironment' is only ever mounted inline inside ProjectSettings's
  // servers section (spec: "別画面を作らないこと" — no separate screen) —
  // a bordered card matching the settings panel's existing add-form
  // affordance, not the full-height sticky-header/footer chrome the
  // create-project route uses.
  const embedded = mode === 'addEnvironment';

  return (
    <div style={embedded
      ? { border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', marginBottom: 16, overflow: 'hidden' }
      : { height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}
    >
      {embedded ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 0' }}>
          <h3 style={{ fontSize: 'var(--font-md)', fontWeight: 600, margin: 0 }}>{t('wizard.addEnvironment.title')}</h3>
          <button
            onClick={onCancel}
            aria-label={t('wizard.cancel')}
            style={{ background: 'none', border: 'none', padding: 4, color: 'var(--text-dim)', cursor: 'pointer', fontSize: 'var(--font-md)' }}
          >
            ✕
          </button>
        </div>
      ) : (
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
          padding: '8px 12px', margin: embedded ? '12px 16px 0' : 'var(--space-4) var(--space-4) 0', borderRadius: 'var(--radius-sm)',
          background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)', color: 'var(--danger)', fontSize: 'var(--font-md)',
        }}>
          {runError}
        </div>
      )}

      <div style={embedded ? undefined : { flex: 1, overflowY: 'auto' }}>
        <div style={embedded ? { padding: 16 } : { maxWidth: 720, margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
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
              selectedServerType={serverList.find((sv) => sv.name === selectedServer)?.type}
              existingPath={existingPath} onExistingPathChange={setExistingPath}
              discovery={discovery}
              selectedRemoteUrls={selectedRemoteUrls} toggleRemoteSelected={toggleRemoteSelected}
              cloneUrl={cloneUrl} setCloneUrl={setCloneUrl}
              cloneDirectory={cloneDirectory}
              setCloneDirectory={(v) => { cloneDirectoryTouchedRef.current = true; setCloneDirectory(v); }}
              cloneBranch={cloneBranch} setCloneBranch={setCloneBranch}
              showValidation={!canAdvance}
            />
          )}

          {currentStep === 'confirm' && (
            <ConfirmStep
              t={t} mode={mode}
              name={name} selectedServer={selectedServer} showEnvironmentStep={visibleSteps.includes('environment')}
              codeMode={codeMode} existingPath={existingPath} cloneUrl={cloneUrl} cloneDirectory={cloneDirectory}
              steps={steps} running={running} alreadyCreated={createdProjectId !== null}
            />
          )}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border)',
        background: 'var(--bg-card)', flexShrink: 0,
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
