import { useState, useEffect, useCallback } from 'react';
import { MetadataField, Button, SecretNamesValue } from '../ui';
import type { SecretNamesState } from '../ui';
import { buildIssueUrl, parseSourceRef } from '../../lib/issueRef';
import { isSupportedProvider } from '../../lib/gitProvider';
import { Icon } from '../ui/Icon';
import { api } from '../../api/client';
import Modal from '../Modal';
import IssueImportModal from '../IssueImportModal';
import type { RemoteIssue, IssueImportRepository } from '../IssueImportModal';
import type { Task, Repository } from '../../pages/workspace/types';
import { useToast } from '../../hooks/useToast';
import { useTranslation } from 'react-i18next';

interface TaskGitTabProps {
  task: Task;
  projectId: number;
  onSwitchToDiff?: (file?: string) => void;
  onRefresh: () => void;
}

export default function TaskGitTab({ task, projectId, onSwitchToDiff, onRefresh }: TaskGitTabProps) {
  const { t } = useTranslation(['tasks', 'git']);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    api<{ repositories?: Repository[] }>(`/projects/${projectId}`)
      .then((res) => { if (!cancelled) setRepositories(res.repositories ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  // Issue #28 Phase D-3: "which secrets will this task's agent receive"
  // shown unconditionally for the task's project — GET /api/projects/:id/secrets
  // returns names only (no `value` field), same endpoint/shape TaskFormView's
  // untrusted-import banner already reads. Not gated behind isLinked/hasUnit
  // etc.: every task in this project runs with the same secret set regardless
  // of git-linkage state.
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretsState, setSecretsState] = useState<SecretNamesState>('loading');
  const [secretsFetchNonce, setSecretsFetchNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSecretsState('loading');
    api<{ name: string }[]>(`/projects/${projectId}/secrets`)
      .then((rows) => {
        if (cancelled) return;
        setSecretNames(rows.map((r) => r.name).sort());
        setSecretsState('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setSecretsState('error');
      });
    return () => { cancelled = true; };
  }, [projectId, secretsFetchNonce]);

  const hasChangedFiles = !!task.changedFiles;
  let files: { status: string; file: string }[] = [];
  if (hasChangedFiles) {
    try { files = JSON.parse(task.changedFiles!) as { status: string; file: string }[]; }
    catch { /* ignore parse error */ }
  }

  const isLinked = !!(task.source && task.source !== 'local' && task.sourceRef);
  const githubRepos = repositories.filter((r) => isSupportedProvider(r.provider));

  const [modalOpen, setModalOpen] = useState(false);
  const [confirmIssue, setConfirmIssue] = useState<{ issue: RemoteIssue; repo: IssueImportRepository } | null>(null);
  const [linking, setLinking] = useState(false);

  const handleSelectIssue = useCallback((issue: RemoteIssue, repo: IssueImportRepository) => {
    setModalOpen(false);
    setConfirmIssue({ issue, repo });
  }, []);

  const handleConfirmLink = useCallback(async (overwrite: boolean) => {
    if (!confirmIssue) return;
    setLinking(true);
    const { issue, repo } = confirmIssue;
    const sourceRef = `${repo.owner}/${repo.repoName}#${issue.number}`;
    const source = isSupportedProvider(repo.provider) ? repo.provider : 'github';
    try {
      const payload: Record<string, unknown> = { source, source_ref: sourceRef };
      if (overwrite) {
        payload.title = issue.title;
        payload.description = issue.body || '';
      }
      await api(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      setConfirmIssue(null);
      onRefresh();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setLinking(false);
    }
  }, [confirmIssue, task.id, onRefresh, showToast]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 'var(--font-md)' }}>
      <MetadataField label={t('tasks:executionApproval.fields.secrets')}>
        <SecretNamesValue names={secretNames} state={secretsState} onRetry={() => setSecretsFetchNonce((n) => n + 1)} />
      </MetadataField>
      {isLinked && (() => {
        const parsed = parseSourceRef(task.sourceRef!);
        const matchedRepo = parsed
          ? repositories.find((r) => r.owner === parsed.owner && r.repoName === parsed.repo)
          : undefined;
        const issueUrl = buildIssueUrl(task.source!, task.sourceRef!, matchedRepo?.url);
        return (
          <MetadataField label={t('git.linkedIssue')}>
            <div>{issueUrl
              ? <a href={issueUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{task.sourceRef} <Icon name="external-link" size={14} /></a>
              : <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text)' }}>{task.sourceRef}</span>
            }</div>
          </MetadataField>
        );
      })()}
      {!isLinked && githubRepos.length > 0 && (
        <button
          onClick={() => setModalOpen(true)}
          style={{
            padding: '8px 12px', fontSize: 'var(--font-sm)', cursor: 'pointer', borderRadius: 'var(--radius-sm)',
            border: '1px dashed var(--border)', background: 'var(--bg)',
            color: 'var(--accent)', width: '100%', textAlign: 'center',
          }}
        >
          {t('tasks:form.importFromGitHub')}
        </button>
      )}
      {(task.worktreeBranch || task.branch) && (
        <MetadataField label={t('git.branch')}>
          {task.baseBranch && task.worktreeBranch ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <code style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>{task.baseBranch}</code>
              <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>&rarr;</span>
              <code style={{ color: 'var(--accent)', fontSize: 'var(--font-sm)' }}>{task.worktreeBranch}</code>
            </div>
          ) : (
            <div><code style={{ color: 'var(--accent)' }}>{task.branch}</code></div>
          )}
        </MetadataField>
      )}
      {task.worktreePath && (
        <MetadataField label={t('git.worktree')}>
          <div style={{ fontSize: 'var(--font-xs)', fontFamily: 'monospace', color: 'var(--text-dim)', wordBreak: 'break-all' }}>{task.worktreePath}</div>
        </MetadataField>
      )}
      {task.prUrl && (
        <MetadataField label={t('git.pullRequest')}>
          <div><a href={task.prUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{t('git.viewPr')} <Icon name="external-link" size={14} /></a></div>
        </MetadataField>
      )}
      {files.length > 0 && (
        <MetadataField
          label={t('git.changedFiles', { count: files.length })}
          action={onSwitchToDiff ? (
            <button
              onClick={() => onSwitchToDiff()}
              style={{ fontSize: 'var(--font-xs)', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
            >
              {t('git.viewAll')}
            </button>
          ) : undefined}
        >
          <div style={{ fontSize: 'var(--font-sm)', maxHeight: 300, overflowY: 'auto' }}>
            {files.map((f, i) => (
              <div
                key={i}
                onClick={() => onSwitchToDiff?.(f.file)}
                className={onSwitchToDiff ? 'row-hover' : undefined}
                style={{
                  padding: '3px 0', display: 'flex', gap: 8,
                  cursor: onSwitchToDiff ? 'pointer' : 'default',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <span style={{
                  color: f.status === 'A' ? 'var(--success)'
                    : f.status === 'D' ? 'var(--danger)'
                    : 'var(--accent)',
                  fontWeight: 600, width: 14, textAlign: 'center', flexShrink: 0,
                }}>{f.status}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 'var(--font-xs)', wordBreak: 'break-all' }}>{f.file}</span>
              </div>
            ))}
          </div>
        </MetadataField>
      )}
      {!isLinked && !task.worktreeBranch && !task.branch && !task.prUrl && files.length === 0 && githubRepos.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', padding: '20px 0', textAlign: 'center' }}>
          {t('git.noGitInfo')}
        </div>
      )}

      <IssueImportModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        projectId={projectId}
        repositories={repositories}
        onSelect={handleSelectIssue}
      />

      {confirmIssue && (
        <Modal title={t('git.linkIssue')} open onClose={() => setConfirmIssue(null)}>
          <div style={{ fontSize: 'var(--font-md)', marginBottom: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontWeight: 600, color: 'var(--accent)' }}>#{confirmIssue.issue.number}</span>{' '}
              {confirmIssue.issue.title}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
              {confirmIssue.repo.owner}/{confirmIssue.repo.repoName}
            </div>
          </div>
          <div style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 16 }}>
            {t('git.linkConfirm')}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => handleConfirmLink(false)} loading={linking} loadingLabel="...">
              {t('git.linkOnly')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => handleConfirmLink(true)} loading={linking} loadingLabel="...">
              {t('git.linkAndOverwrite')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
