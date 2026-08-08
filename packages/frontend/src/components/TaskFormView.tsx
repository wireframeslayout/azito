import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { emptyTaskForm, buildTaskPayload, compareExecutionApprovalContext } from '../lib/taskForm';
import type { TaskFormValue, DisplayedExecutionContext } from '../lib/taskForm';
import { resolveEnabledPhaseNames } from '../lib/taskPhases';
import TaskFormFields from './TaskFormFields';
import IssueImportModal from './IssueImportModal';
import type { RemoteIssue } from './IssueImportModal';
import { LoadingState, FormPage } from './ui';
import { isSupportedProvider } from '../lib/gitProvider';
import { useToast } from '../hooks/useToast';
import { useUnitTypes, findUnitType } from '../hooks/useUnitTypes';
import type { ExecutionApprovalData } from '../pages/workspace/types';

interface Repository {
  id: number;
  name?: string;
  provider?: string;
  owner?: string;
  repoName?: string;
}

interface TaskFormViewProps {
  mode: 'create' | 'edit';
  taskId?: number;
  initial?: Partial<TaskFormValue>;
  projects?: { id: number; name: string }[];
  units: {
    id: number; name: string; workerType?: string | null;
    selfReviewMaxAttempts?: number;
    reviewSubagent?: { enabled: boolean; provider: string; model: string } | null;
    implementSubagent?: { enabled: boolean; provider: string; model: string } | null;
    // Needed to resolve the Unit's enabled-phase list for the untrusted-import
    // banner (task/328 follow-up, part A) — see resolveEnabledPhaseNames().
    unitType: string;
    phaseConfig?: Record<string, { enabled?: boolean; sidekick?: string }> | null;
  }[];
  repositories: Repository[];
  projectId?: number;
  projectServers?: { serverName: string; workingDirectory: string | null }[];
  defaultUnitId?: number | null;
  onSaved: (taskId?: number, title?: string) => void;
  onCancel: () => void;
  backLabel?: string;
  onBack?: () => void;
}

export default function TaskFormView({ mode, taskId, initial, projects, units, repositories, projectId, projectServers, defaultUnitId, onSaved, onCancel, backLabel, onBack }: TaskFormViewProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { showToast } = useToast();
  const [form, setForm] = useState<TaskFormValue>(() => emptyTaskForm({
    projectId: projectId ? String(projectId) : '',
    unitId: mode === 'create' && defaultUnitId ? String(defaultUnitId) : '',
    ...initial,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);

  // Untrusted-origin import (task/328-input-trust-and-exec-gate follow-up,
  // part A) — the SAME condition the server derives inputTrust from
  // (deriveInputTrust in modules/tasks/Task.ts: source is 'github' or
  // 'gitlab'), kept in exact lockstep here rather than re-guessed, so this
  // banner/auto-approval only ever fires for content the server will
  // actually gate. `form.source` is populated by all three github/gitlab
  // import paths that reach this form (IssueDetailPanel/IssueListPanel's
  // presetSource, and this component's own "Import from GitHub" button via
  // handleSelectIssue below) — there is no other way to reach this form with
  // a github/gitlab `source` set.
  const isUntrustedImport = mode === 'create' && (form.source?.source === 'github' || form.source?.source === 'gitlab');
  // 編集モードでサーバーから読み込んだ元の値。status など「変更していなければ
  // payload に含めない」判定の基準として保持する（承認待ちタスクの status を
  // 誤って送ってしまい、正当な編集保存が 409 になるのを防ぐため）。
  // `initial` にすでにタイトルが入っている場合（呼び出し元がタスク一覧のキャッシュ
  // から渡すケース）は、下の fetch 用 useEffect がスキップされて originalForm が
  // 設定されないため、ここで `initial` 自体を元の値として使う。
  const [originalForm, setOriginalForm] = useState<TaskFormValue | null>(() =>
    mode === 'edit' && initial?.title
      ? emptyTaskForm({ projectId: projectId ? String(projectId) : '', ...initial })
      : null
  );

  useEffect(() => {
    if (mode !== 'edit' || !taskId || initial?.title) return;
    let cancelled = false;
    setLoadingTask(true);
    api<{ id: number; title: string; description?: string; status: string; unitId: number | null; serverName?: string | null; priority: number; tmuxWindow?: string; baseBranch?: string; targetBranch?: string; skipPr?: boolean; workingDirectory?: string; branch?: string; source?: string; sourceRef?: string; reviewSubagent?: { enabled: boolean; provider: string; model: string } | null; implementSubagent?: { enabled: boolean; provider: string; model: string } | null }>(`/tasks/${taskId}`)
      .then((t) => {
        if (cancelled) return;
        const hasOverride = !!(t.reviewSubagent || t.implementSubagent);
        const loaded = emptyTaskForm({
          projectId: projectId ? String(projectId) : '',
          title: t.title,
          description: t.description || '',
          status: t.status,
          serverName: t.serverName || '',
          unitId: t.unitId ? String(t.unitId) : '',
          priority: String(t.priority),
          tmuxWindow: t.tmuxWindow || '',
          baseBranch: t.baseBranch || '',
          targetBranch: t.targetBranch || '',
          skipPr: t.skipPr ?? false,
          workingDirectory: t.workingDirectory || '',
          workingBranch: t.branch || '',
          overrideSubagents: hasOverride,
          reviewSubagent: t.reviewSubagent ?? null,
          implementSubagent: t.implementSubagent ?? null,
          source: t.source && t.sourceRef ? { source: t.source, sourceRef: t.sourceRef } : null,
        });
        setForm(loaded);
        setOriginalForm(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => { if (!cancelled) setLoadingTask(false); });
    return () => { cancelled = true; };
  }, [mode, taskId, initial?.title, projectId]);

  useEffect(() => {
    if (mode === 'edit' || form.serverName || !projectServers) return;
    if (projectServers.length === 1) {
      const ps = projectServers[0];
      setForm((prev) => ({
        ...prev,
        serverName: ps.serverName,
        workingDirectory: prev.workingDirectory || ps.workingDirectory || '',
      }));
    }
  }, [mode, projectServers, form.serverName]);

  const effectiveProjectId = useMemo(() => parseInt(form.projectId, 10) || projectId, [form.projectId, projectId]);

  // Secret NAMES for the untrusted-import banner below (task/328 follow-up,
  // part A-1) — the same read the approval PANEL uses
  // (GET /api/tasks/:id/execution-approval's `secretNames`, itself
  // `projectSecretRepo.findByProject(...).map(s => s.name).sort()`): this
  // form has no task yet, so it reads the identical underlying project
  // secrets list directly via the existing GET /api/projects/:id/secrets
  // endpoint instead — no new server endpoint, and the same "names only,
  // never values" shape (this endpoint's response never carries a `value`
  // field). Fetched only while the untrusted-import banner is actually
  // shown, not on every form render.
  //
  // FAIL CLOSED (third-party review, task/328 follow-up): a failed fetch
  // used to fall back to an empty array, silently rendering "no secrets"
  // in the banner as if that were confirmed fact — an approval decision
  // made on missing information. `secretsState` now distinguishes
  // 'loading'/'loaded'/'error' so the caller can refuse to pre-approve
  // (see `canPreApprove` below) until secrets actually load, and the
  // banner shows the error with a retry action instead of a false "none".
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretsState, setSecretsState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [secretsFetchNonce, setSecretsFetchNonce] = useState(0);
  const retrySecretFetch = useCallback(() => setSecretsFetchNonce((n) => n + 1), []);
  useEffect(() => {
    if (!isUntrustedImport || !effectiveProjectId) { setSecretNames([]); setSecretsState('idle'); return; }
    let cancelled = false;
    setSecretsState('loading');
    api<{ name: string }[]>(`/projects/${effectiveProjectId}/secrets`)
      .then((rows) => {
        if (cancelled) return;
        setSecretNames(rows.map((r) => r.name).sort());
        setSecretsState('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setSecretNames([]);
        setSecretsState('error');
      });
    return () => { cancelled = true; };
  }, [isUntrustedImport, effectiveProjectId, secretsFetchNonce]);

  // Resolved execution context the banner actually displays (task/328
  // follow-up, part A) — computed ONCE here and used both to render the
  // banner and, after creation, as the "what the human saw" side of
  // compareExecutionApprovalContext(). Best-effort client-side resolution:
  // no task row exists yet, so project_servers/phaseConfig defaults are
  // approximated the same way the rest of this form already approximates
  // them (see the single-server auto-fill effect above) rather than
  // re-implemented from scratch.
  const resolvedServerName = form.serverName || (projectServers?.length === 1 ? projectServers[0].serverName : null);
  const resolvedWorkingDirectory = form.workingDirectory
    || projectServers?.find((s) => s.serverName === resolvedServerName)?.workingDirectory
    || null;
  const { unitTypes } = useUnitTypes();
  const selectedUnit = units.find((u) => u.id === parseInt(form.unitId, 10))
    ?? (defaultUnitId != null ? units.find((u) => u.id === defaultUnitId) : undefined);
  const selectedUnitType = findUnitType(unitTypes, selectedUnit?.unitType);
  const displayedPhases = selectedUnitType ? resolveEnabledPhaseNames(selectedUnit?.phaseConfig, selectedUnitType.phases) : [];
  // Same selection the server's manifest resolver uses (`project?.repositories?.[0]`,
  // see ExecutionManifest.ts) — `repositories` here is already scoped to this
  // project and in the same order (TabContentRenderer passes `project.repositories`
  // straight through), so its first entry is the same repository.
  const displayedRepository = repositories.length > 0
    ? { owner: repositories[0].owner ?? '', repoName: repositories[0].repoName ?? '' }
    : null;
  const buildDisplayedContext = useCallback((): DisplayedExecutionContext => ({
    title: form.title.trim(),
    description: form.description.trim(),
    unitId: selectedUnit?.id ?? null,
    unitName: selectedUnit?.name ?? null,
    serverName: resolvedServerName,
    workingDirectory: resolvedWorkingDirectory,
    branches: {
      base: form.baseBranch.trim(),
      target: form.skipPr ? '' : form.targetBranch.trim(),
      work: form.skipPr ? form.workingBranch.trim() : '',
    },
    phases: displayedPhases,
    repository: displayedRepository,
    secretNames,
  }), [form.title, form.description, selectedUnit, resolvedServerName, resolvedWorkingDirectory, form.baseBranch, form.targetBranch, form.skipPr, form.workingBranch, displayedPhases, displayedRepository, secretNames]);
  // Pre-approval may only be attempted once secrets actually loaded — see
  // `secretsState`'s doc comment above. While 'error', the create button
  // falls back to an ordinary (non-approving) task creation.
  const canPreApprove = isUntrustedImport && secretsState === 'loaded';

  const handleChange = useCallback((next: TaskFormValue) => {
    if (next.serverName !== form.serverName) {
      const ps = projectServers?.find((s) => s.serverName === next.serverName);
      next = {
        ...next,
        workingDirectory: ps?.workingDirectory || '',
      };
    }
    if (next.unitId !== form.unitId) {
      const unit = units.find((u) => u.id === parseInt(next.unitId, 10));
      if (unit) {
        next = {
          ...next,
          selfReviewMax: String(unit.selfReviewMaxAttempts ?? 2),
        };
      }
    }
    setForm(next);
  }, [form.unitId, form.serverName, units, projectServers]);

  const handleSave = useCallback(async () => {
    if (!form.title.trim()) { setError(t('form.titleRequired')); return; }
    if (projectServers && projectServers.length > 1 && !form.serverName.trim()) {
      setError(t('form.serverRequired'));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (mode === 'create') {
        // Captured BEFORE the POST — the exact content the banner rendered
        // for THIS submission, independent of any state change that might
        // happen while the two requests below are in flight.
        const displayedContext = canPreApprove ? buildDisplayedContext() : null;
        const payload = buildTaskPayload(form, 'create');
        const res = await api<{ id: number }>('/tasks', { method: 'POST', body: JSON.stringify(payload) });
        // Creation-time pre-approval (task/328 follow-up, part A-2/A-3) —
        // ONLY when the untrusted-import banner above was actually shown for
        // this submission AND its secret names loaded successfully
        // (canPreApprove — see `secretsState`'s doc comment: a failed
        // secret fetch must fail CLOSED, never silently approve on missing
        // information). Task creation has already succeeded at this point;
        // a failure/mismatch here must not roll it back or block onSaved()
        // below — the task still exists and is fully usable through the
        // normal pending_approval panel on first execute, it just didn't
        // get the create-form shortcut.
        if (displayedContext) {
          try {
            const approval = await api<ExecutionApprovalData>(`/tasks/${res.id}/execution-approval`);
            // The TOCTOU close this whole flow exists for (third-party
            // review, task/328 follow-up): only pre-approve when the
            // server's ACTUALLY resolved manifest matches what the banner
            // displayed, field for field (compareExecutionApprovalContext).
            // A legitimate "form left blank -> server applied a default"
            // difference is exactly what this catches too — the human never
            // saw that resolved value, so it must not be silently approved.
            const actualContext: DisplayedExecutionContext = {
              title: approval.title,
              description: approval.description ?? '',
              unitId: approval.execution.unitId,
              unitName: approval.execution.unitName,
              serverName: approval.execution.serverName,
              workingDirectory: approval.execution.workingDirectory,
              branches: approval.execution.branches,
              phases: approval.execution.phases.map((p) => p.phase),
              repository: approval.execution.repository
                ? { owner: approval.execution.repository.owner ?? '', repoName: approval.execution.repository.repoName ?? '' }
                : null,
              secretNames: approval.secretNames,
            };
            const comparison = compareExecutionApprovalContext(displayedContext, actualContext);
            if (!comparison.matches) {
              showToast(t('untrustedImport.contentMismatchToast', { fields: comparison.mismatches.join(', ') }));
            } else {
              await api(`/tasks/${res.id}/approve-execution`, {
                method: 'POST',
                body: JSON.stringify({ approved: true, fingerprint: approval.fingerprint, origin: 'creation_form' }),
              });
              showToast(t('untrustedImport.preApprovedToast'));
            }
          } catch (approvalErr: unknown) {
            showToast(t('untrustedImport.preApprovalFailedToast', { error: (approvalErr as Error).message }));
          }
        }
        onSaved(res.id, form.title.trim());
      } else {
        const payload = buildTaskPayload(form, 'edit', originalForm ?? undefined);
        await api(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) });
        onSaved(taskId, form.title.trim());
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [form, mode, taskId, onSaved, projectServers, originalForm, canPreApprove, buildDisplayedContext, showToast, t]);

  const githubRepos = repositories.filter((r) => isSupportedProvider(r.provider));
  const [issueModalOpen, setIssueModalOpen] = useState(false);

  const handleSelectIssue = useCallback((issue: RemoteIssue, repo: { provider?: string; owner?: string; repoName?: string }) => {
    setForm((prev) => ({
      ...prev,
      title: issue.title,
      description: issue.body || '',
      source: {
        source: isSupportedProvider(repo.provider) ? repo.provider : 'github',
        sourceRef: `${repo.owner}/${repo.repoName}#${issue.number}`,
      },
    }));
    setIssueModalOpen(false);
  }, []);

  return (
    <FormPage
      title={mode === 'create' ? t('form.newTask') : t('form.editTask')}
      submitLabel={mode === 'create' ? (canPreApprove ? t('form.createTaskApproved') : t('form.createTask')) : t('form.saveChanges')}
      onSubmit={handleSave}
      onCancel={onCancel}
      loading={saving}
      loadingLabel={t('common:actions.saving')}
      error={error}
      backLabel={backLabel}
      onBack={onBack}
    >
      {loadingTask ? <LoadingState /> : (
        <>
          {mode === 'create' && githubRepos.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <button className="btn btn-sm" onClick={() => setIssueModalOpen(true)} style={{ width: '100%', padding: '10px', border: '1px dashed var(--border)', background: 'var(--bg)', color: 'var(--accent)', fontSize: 'var(--font-md)', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}>
                {t('form.importFromGitHub')}
              </button>
              {form.source && (
                <div style={{ marginTop: 6, fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
                  {t('form.source', { ref: form.source.sourceRef })}
                </div>
              )}
            </div>
          )}

          {isUntrustedImport && (
            <UntrustedImportBanner
              title={form.title}
              description={form.description}
              unitName={selectedUnit?.name ?? null}
              serverName={resolvedServerName}
              workingDirectory={resolvedWorkingDirectory}
              baseBranch={form.baseBranch}
              targetBranch={form.skipPr ? '' : form.targetBranch}
              workBranch={form.skipPr ? form.workingBranch : ''}
              phases={displayedPhases}
              repository={displayedRepository}
              secretsState={secretsState}
              secretNames={secretNames}
              onRetrySecrets={retrySecretFetch}
            />
          )}

          <TaskFormFields
            value={form}
            onChange={handleChange}
            mode={mode}
            projects={projects}
            units={units}
            showAdvanced={mode === 'create'}
            projectId={projectId}
            descriptionRows={12}
            projectServers={projectServers}
            defaultUnitId={defaultUnitId}
          />
        </>
      )}

      {effectiveProjectId && (
        <IssueImportModal
          open={issueModalOpen}
          onClose={() => setIssueModalOpen(false)}
          projectId={effectiveProjectId}
          repositories={repositories}
          onSelect={handleSelectIssue}
        />
      )}
    </FormPage>
  );
}

interface UntrustedImportBannerProps {
  title: string;
  description: string;
  unitName: string | null;
  serverName: string | null;
  workingDirectory: string | null;
  baseBranch: string;
  targetBranch: string;
  workBranch: string;
  /** Ordered enabled-phase-name list — see resolveEnabledPhaseNames() (lib/taskPhases.ts). */
  phases: string[];
  repository: { owner: string; repoName: string } | null;
  secretsState: 'idle' | 'loading' | 'loaded' | 'error';
  secretNames: string[];
  onRetrySecrets: () => void;
}

/**
 * The create-form's own "you are about to approve untrusted content"
 * framing (task/328-input-trust-and-exec-gate follow-up, part A-1) —
 * deliberately styled the SAME way TaskPanel's pending_approval panel
 * renders the identical information (dashed border for the untrusted
 * content box, a plain grid for the resolved execution context), so a human
 * who has seen one recognizes the other as the same kind of decision. See
 * TaskPanel.tsx's own "Execution approval gate" block for the panel this
 * mirrors.
 *
 * Renders `title`/`description` as PLAIN TEXT ONLY — same reasoning as the
 * panel: this content can be attacker-authored (an imported GitHub/GitLab
 * issue body), and rendering it as markdown/HTML here would let it forge
 * links or layout that impersonates AZITO's own UI.
 */
function UntrustedImportBanner({ title, description, unitName, serverName, workingDirectory, baseBranch, targetBranch, workBranch, phases, repository, secretsState, secretNames, onRetrySecrets }: UntrustedImportBannerProps) {
  const { t } = useTranslation(['tasks', 'common']);
  return (
    <div
      role="region"
      aria-label={t('untrustedImport.bannerTitle')}
      style={{
        border: '1px solid var(--danger-a35)', borderRadius: 'var(--radius-md)',
        background: 'var(--danger-a08)', padding: '12px 16px', marginBottom: 16,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 'var(--font-md)', color: 'var(--danger)', fontWeight: 600, marginBottom: 4 }}>
          {t('untrustedImport.bannerTitle')}
        </div>
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {t('untrustedImport.bannerBody')}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--danger)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          {t('executionApproval.untrustedContentLabel')}
        </div>
        <div style={{
          border: '1px dashed var(--danger-a35)', borderRadius: 'var(--radius-md)', background: 'var(--bg)',
          padding: '10px 12px', maxHeight: 200, overflowY: 'auto',
        }}>
          <div style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text)', marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {title || t('fields.titlePlaceholder')}
          </div>
          <pre style={{ margin: 0, fontFamily: 'inherit', fontSize: 'var(--font-sm)', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {description || t('executionApproval.noDescription')}
          </pre>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          {t('untrustedImport.contextLabel')}
        </div>
        <div style={{
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg)',
          padding: '10px 12px', display: 'grid', gridTemplateColumns: 'max-content 1fr', rowGap: 6, columnGap: 12,
          fontSize: 'var(--font-sm)',
        }}>
          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.unit')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{unitName ?? t('executionApproval.unresolved')}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.server')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{serverName ?? t('executionApproval.unresolved')}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.workingDirectory')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
            {workingDirectory ?? t('untrustedImport.workingDirectoryDefault')}
          </span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.branches')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
            {t('executionApproval.branchesValue', { base: baseBranch || '—', target: targetBranch || '—', work: workBranch || '—' })}
          </span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.phases')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
            {phases.length > 0 ? phases.join(' → ') : t('executionApproval.unresolved')}
          </span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.repository')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
            {repository ? `${repository.owner}/${repository.repoName}` : t('executionApproval.noRepository')}
          </span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.secrets')}</span>
          {secretsState === 'error' ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--danger)', wordBreak: 'break-word' }}>{t('untrustedImport.secretsLoadError')}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={onRetrySecrets}
                style={{ padding: '2px 8px', fontSize: 'var(--font-xs)' }}
              >
                {t('untrustedImport.secretsRetry')}
              </button>
            </span>
          ) : (
            <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
              {secretsState === 'loading'
                ? t('executionApproval.loading')
                : (secretNames.length > 0 ? secretNames.join(', ') : t('executionApproval.noSecrets'))}
            </span>
          )}
        </div>
      </div>

      {secretsState === 'error' && (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--danger)' }}>
          {t('untrustedImport.secretsUnavailableNote')}
        </div>
      )}
    </div>
  );
}
