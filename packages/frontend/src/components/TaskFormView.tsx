import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { emptyTaskForm, buildTaskPayload } from '../lib/taskForm';
import type { TaskFormValue } from '../lib/taskForm';
import TaskFormFields from './TaskFormFields';
import IssueImportModal from './IssueImportModal';
import type { RemoteIssue } from './IssueImportModal';
import { LoadingState, FormPage } from './ui';
import { isSupportedProvider } from '../lib/gitProvider';
import { useToast } from '../hooks/useToast';

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
  const [secretNames, setSecretNames] = useState<string[]>([]);
  useEffect(() => {
    if (!isUntrustedImport || !effectiveProjectId) { setSecretNames([]); return; }
    let cancelled = false;
    api<{ name: string }[]>(`/projects/${effectiveProjectId}/secrets`)
      .then((rows) => { if (!cancelled) setSecretNames(rows.map((r) => r.name).sort()); })
      .catch(() => { if (!cancelled) setSecretNames([]); });
    return () => { cancelled = true; };
  }, [isUntrustedImport, effectiveProjectId]);

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
        const payload = buildTaskPayload(form, 'create');
        const res = await api<{ id: number }>('/tasks', { method: 'POST', body: JSON.stringify(payload) });
        // Creation-time pre-approval (task/328 follow-up, part A-2) — ONLY
        // when the untrusted-import banner above was actually shown for
        // this submission (isUntrustedImport, computed from the exact same
        // condition the banner renders under). Task creation has already
        // succeeded at this point; a failure here must not roll it back or
        // block onSaved() below — the task still exists and is fully usable
        // through the normal pending_approval panel on first execute, it
        // just didn't get the create-form shortcut.
        if (isUntrustedImport) {
          try {
            const approval = await api<{ fingerprint: string }>(`/tasks/${res.id}/execution-approval`);
            await api(`/tasks/${res.id}/approve-execution`, {
              method: 'POST',
              body: JSON.stringify({ approved: true, fingerprint: approval.fingerprint, origin: 'creation_form' }),
            });
            showToast(t('form.untrustedImport.preApprovedToast'));
          } catch (approvalErr: unknown) {
            showToast(t('form.untrustedImport.preApprovalFailedToast', { error: (approvalErr as Error).message }));
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
  }, [form, mode, taskId, onSaved, projectServers, originalForm, isUntrustedImport, showToast, t]);

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
      submitLabel={mode === 'create' ? (isUntrustedImport ? t('form.createTaskApproved') : t('form.createTask')) : t('form.saveChanges')}
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
              unitName={units.find((u) => u.id === parseInt(form.unitId, 10))?.name
                ?? (defaultUnitId != null ? units.find((u) => u.id === defaultUnitId)?.name : undefined)
                ?? null}
              serverName={form.serverName || (projectServers?.length === 1 ? projectServers[0].serverName : null)}
              workingDirectory={form.workingDirectory || null}
              baseBranch={form.baseBranch}
              targetBranch={form.skipPr ? '' : form.targetBranch}
              workBranch={form.skipPr ? form.workingBranch : ''}
              secretNames={secretNames}
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
  secretNames: string[];
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
function UntrustedImportBanner({ title, description, unitName, serverName, workingDirectory, baseBranch, targetBranch, workBranch, secretNames }: UntrustedImportBannerProps) {
  const { t } = useTranslation(['tasks', 'common']);
  return (
    <div
      role="region"
      aria-label={t('form.untrustedImport.bannerTitle')}
      style={{
        border: '1px solid var(--danger-a35)', borderRadius: 'var(--radius-md)',
        background: 'var(--danger-a08)', padding: '12px 16px', marginBottom: 16,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 'var(--font-md)', color: 'var(--danger)', fontWeight: 600, marginBottom: 4 }}>
          {t('form.untrustedImport.bannerTitle')}
        </div>
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {t('form.untrustedImport.bannerBody')}
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
          {t('form.untrustedImport.contextLabel')}
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
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{workingDirectory ?? t('executionApproval.unresolved')}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.branches')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
            {t('executionApproval.branchesValue', { base: baseBranch || '—', target: targetBranch || '—', work: workBranch || '—' })}
          </span>

          <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.secrets')}</span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
            {secretNames.length > 0 ? secretNames.join(', ') : t('executionApproval.noSecrets')}
          </span>
        </div>
      </div>
    </div>
  );
}
