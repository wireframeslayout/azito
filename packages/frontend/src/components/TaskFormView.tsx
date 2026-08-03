import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { emptyTaskForm, buildTaskPayload } from '../lib/taskForm';
import type { TaskFormValue } from '../lib/taskForm';
import TaskFormFields from './TaskFormFields';
import IssueImportModal from './IssueImportModal';
import type { RemoteIssue } from './IssueImportModal';
import { LoadingState, FormPage } from './ui';
import { isSupportedProvider } from '../lib/gitProvider';

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
  const [form, setForm] = useState<TaskFormValue>(() => emptyTaskForm({
    projectId: projectId ? String(projectId) : '',
    unitId: mode === 'create' && defaultUnitId ? String(defaultUnitId) : '',
    ...initial,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);

  useEffect(() => {
    if (mode !== 'edit' || !taskId || initial?.title) return;
    let cancelled = false;
    setLoadingTask(true);
    api<{ id: number; title: string; description?: string; status: string; unitId: number | null; serverName?: string | null; priority: number; tmuxWindow?: string; baseBranch?: string; targetBranch?: string; skipPr?: boolean; workingDirectory?: string; branch?: string; source?: string; sourceRef?: string; reviewSubagent?: { enabled: boolean; provider: string; model: string } | null; implementSubagent?: { enabled: boolean; provider: string; model: string } | null }>(`/tasks/${taskId}`)
      .then((t) => {
        if (cancelled) return;
        const hasOverride = !!(t.reviewSubagent || t.implementSubagent);
        setForm(emptyTaskForm({
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
        }));
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
        onSaved(res.id, form.title.trim());
      } else {
        const payload = buildTaskPayload(form, 'edit');
        await api(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) });
        onSaved(taskId, form.title.trim());
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [form, mode, taskId, onSaved, projectServers]);

  const githubRepos = repositories.filter((r) => isSupportedProvider(r.provider));
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const effectiveProjectId = parseInt(form.projectId, 10) || projectId;

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
      submitLabel={mode === 'create' ? t('form.createTask') : t('form.saveChanges')}
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
