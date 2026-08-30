import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiWithStatus } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useIsMobile } from '../hooks/useIsMobile';
import { Button, type InstallStep } from './ui';
import ProjectGeneralFields, { generateSlug } from './ProjectGeneralFields';
import { notifyProjectsChanged } from '../lib/projectsChanged';
import { createRequestGuard, dedupeSelectableUrls } from './repoDiscoveryDialogLogic';
import {
  getVisibleSteps, canAdvanceFromStep, stepIndex, nextStep, deriveCloneDirectoryName, deriveDefaultBranch,
  type WizardStepId, type CodeMode, type WizardValidationState,
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
  const [selectedRemoteUrls, setSelectedRemoteUrls] = useState<Set<string>>(new Set());
  const discoveryGuardRef = useRef(createRequestGuard());
  const discoveryDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDirectory, setCloneDirectory] = useState('');
  const cloneDirectoryTouchedRef = useRef(false);
  const [cloneBranch, setCloneBranch] = useState('main');

  // ── Step 4: confirm / execution ──
  const [steps, setSteps] = useState<InstallStep[]>([]);
  const [running, setRunning] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<number | null>(mode === 'addEnvironment' ? (projectId ?? null) : null);
  const [envDone, setEnvDone] = useState(false);
  const [repoDone, setRepoDone] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const visibleSteps = useMemo(
    () => (mode === 'create' ? getVisibleSteps(serverList.length) : getVisibleSteps(serverList.length).filter((s) => s !== 'project')),
    [mode, serverList.length],
  );
  const [currentStep, setCurrentStep] = useState<WizardStepId>(visibleSteps[0]);

  // Auto-select the only server when the environment step is skipped, or
  // when the list first loads with a single entry.
  useEffect(() => {
    if (serverAutoTouchedRef.current) return;
    if (serverList.length === 1) {
      setSelectedServer(serverList[0].name);
    } else if (serverList.length > 1 && !serverList.some((sv) => sv.name === selectedServer)) {
      setSelectedServer(serverList.find((sv) => sv.name === 'local')?.name ?? serverList[0].name);
    }
  }, [serverList, selectedServer]);

  // Keep currentStep valid if visibleSteps changes shape (e.g. servers finish loading and the environment step appears/disappears).
  useEffect(() => {
    if (!visibleSteps.includes(currentStep)) setCurrentStep(visibleSteps[0]);
  }, [visibleSteps, currentStep]);

  // Auto-derive the clone target directory from the URL until the user edits it directly.
  useEffect(() => {
    if (!cloneDirectoryTouchedRef.current) setCloneDirectory(deriveCloneDirectoryName(cloneUrl));
  }, [cloneUrl]);

  const runDiscovery = useCallback(async (path: string) => {
    const requestId = discoveryGuardRef.current.start();
    if (!path.trim() || !selectedServer) {
      setDiscovery('idle');
      return;
    }
    setDiscovery('checking');
    try {
      const { status, body } = await apiWithStatus<DiscoverResponse | { error: string }>(
        `/servers/${encodeURIComponent(selectedServer)}/discover-repositories?path=${encodeURIComponent(path)}`,
      );
      if (!discoveryGuardRef.current.isCurrent(requestId)) return;
      if (status !== 200 || !('repositories' in body)) {
        setDiscovery('error');
        return;
      }
      setDiscovery({ repos: body.repositories, exists: body.exists, isGitRepository: body.isGitRepository });
      setSelectedRemoteUrls(new Set(dedupeSelectableUrls(body.repositories.flatMap((r) => r.remotes))));
    } catch {
      if (discoveryGuardRef.current.isCurrent(requestId)) setDiscovery('error');
    }
  }, [selectedServer]);

  const handleExistingPathChange = useCallback((value: string) => {
    setExistingPath(value);
    if (discoveryDebounceRef.current) clearTimeout(discoveryDebounceRef.current);
    discoveryDebounceRef.current = setTimeout(() => runDiscovery(value), 400);
  }, [runDiscovery]);

  useEffect(() => () => { if (discoveryDebounceRef.current) clearTimeout(discoveryDebounceRef.current); }, []);

  const toggleRemoteSelected = useCallback((url: string) => {
    setSelectedRemoteUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }, []);

  const validationState: WizardValidationState = {
    projectName: name, projectSlug: slug, selectedServer, codeMode, existingPath, cloneUrl, cloneDirectory,
  };
  const canAdvance = canAdvanceFromStep(currentStep, validationState);

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
      // Step: project (create mode only — 'addEnvironment' already has one)
      let pid = createdProjectId;
      if (mode === 'create' && pid === null) {
        setStep('project', 'running', t('wizard.steps.project'));
        try {
          const created = await api<{ id: number }>('/projects', {
            method: 'POST',
            body: JSON.stringify({
              name: name.trim(), slug: slug.trim(), description: description.trim(),
              default_branch: deriveDefaultBranch(codeMode, cloneBranch),
              sidekick_prompt: sidekickPrompt.trim(), icon: icon.trim() || null, color: color.trim() || null,
            }),
          });
          pid = created.id;
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

      // Step: environment. In 'create' mode, a "code" step of "later" (no
      // root entered) creates nothing here — spec: "ルートも未入力なら
      // project_servers を作らない". In 'addEnvironment' mode the whole
      // point of the wizard run is to add this environment, so it is
      // always created once a server is selected, root or not (the
      // pre-existing "add environment" form this replaces worked the same
      // way — workingDirectory was always optional there too).
      const wantsEnvironment = !!selectedServer && (mode === 'addEnvironment' || codeMode !== 'later');
      if (wantsEnvironment && pid !== null) {
        if (!envDone) {
          setStep('environment', 'running', t('wizard.confirm.stepEnvironment'));
          try {
            const workingDirectory = codeMode === 'existing' ? existingPath.trim()
              : codeMode === 'clone' ? cloneDirectory.trim()
              : '';
            await api(`/projects/${pid}/servers/${selectedServer}`, {
              method: 'PUT',
              body: JSON.stringify({
                working_directory: workingDirectory || null,
                branch: codeMode === 'clone' ? (cloneBranch.trim() || null) : null,
                tmux_session: null,
                input_policy: 'manual-approval',
              }),
            });
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

      // Step: repository
      if (pid !== null && !repoDone) {
        if (codeMode === 'existing' && repositoriesToRegister.length > 0) {
          setStep('repository', 'running', t('wizard.confirm.stepRepository'));
          try {
            await api(`/projects/${pid}/repositories/bulk`, {
              method: 'POST', body: JSON.stringify({ repositories: repositoriesToRegister }),
            });
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
            await api(`/projects/${pid}/repositories`, {
              method: 'POST',
              body: JSON.stringify({
                url: cloneUrl.trim(), provider: parsed.provider,
                owner: parsed.owner ?? undefined, repo_name: parsed.repoName ?? undefined,
              }),
            });
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

      if (pid !== null) onDone(pid);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [
    mode, createdProjectId, name, slug, description, sidekickPrompt, icon, color,
    selectedServer, codeMode, existingPath, cloneDirectory, cloneBranch, cloneUrl, envDone, repoDone,
    repositoriesToRegister, onDone, setStep, t,
  ]);

  const primaryLabel = isLastStep ? t('wizard.create') : t('wizard.next');
  const primaryAction = isLastStep ? handleRun : goNext;
  const primaryDisabled = isLastStep ? false : !canAdvance;

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
            />
          )}

          {currentStep === 'code' && (
            <CodeStep
              t={t} codeMode={codeMode} setCodeMode={setCodeMode}
              selectedServer={selectedServer}
              existingPath={existingPath} onExistingPathChange={handleExistingPathChange}
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
