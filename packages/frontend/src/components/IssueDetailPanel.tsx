import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { timeAgo } from '../utils/time';
import MarkdownRenderer, { mdStyles } from './MarkdownRenderer';
import { LoadingState } from './ui';

interface RemoteIssue { number: number; title: string; body: string | null; state: string; labels: { name: string; color: string }[]; user: { login: string; avatarUrl: string }; createdAt: string; updatedAt: string; htmlUrl: string; }

export default function IssueDetailPanel({
  projectId, repoId, owner, repo, issueNumber, onImportAsTask, onBackToList, linkedTask, onOpenTask,
}: {
  projectId: number;
  repoId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  onImportAsTask: (issue: RemoteIssue) => void;
  onBackToList?: () => void;
  linkedTask?: { id: number; title: string } | null;
  onOpenTask?: (taskId: number, title: string) => void;
}) {
  const { t } = useTranslation(['git', 'common']);
  const [issue, setIssue] = useState<RemoteIssue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api<RemoteIssue>(`/projects/${projectId}/remote-issues/${issueNumber}?repo_id=${repoId}`)
      .then(setIssue)
      .catch((err: Error) => {
        setError(err.message);
        setIssue(null);
      })
      .finally(() => setLoading(false));
  }, [projectId, repoId, issueNumber]);

  if (loading) return <LoadingState message={t('issues.loading', { number: issueNumber })} />;
  if (error || !issue) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)', background: 'var(--ws-surface)', height: '100%' }}>Failed to load issue: {error}</div>;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <style>{mdStyles}</style>
      {/* Header */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          {onBackToList && (
            <button onClick={onBackToList} title={t('issues.backToList')}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', cursor: 'pointer', padding: '4px 10px', fontSize: 'var(--font-md)', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              &larr; {t('issues.title')}
            </button>
          )}
          <span style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--text-dim)' }}>#{issue.number}</span>
          <span style={{ fontSize: 'var(--font-lg)', fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
          <span style={{
            padding: '3px 10px', borderRadius: 'var(--radius-lg)', fontSize: 'var(--font-sm)', fontWeight: 500,
            background: issue.state === 'open' ? 'var(--success-a15)' : 'rgba(163,113,247,0.15)',
            color: issue.state === 'open' ? 'var(--success)' : 'var(--purple, #a371f7)',
          }}>{issue.state}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--font-md)', color: 'var(--text-dim)', flexWrap: 'wrap' }}>
          <span>{owner}/{repo}</span>
          <span>{issue.user.login}</span>
          <span>{timeAgo(issue.createdAt)}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <a href={issue.htmlUrl} target="_blank" rel="noopener noreferrer"
              style={{ padding: '4px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', fontSize: 'var(--font-sm)', textDecoration: 'none', cursor: 'pointer' }}>
              {t('issues.openOnGitHub')}
            </a>
            {linkedTask && onOpenTask ? (
              <button onClick={() => onOpenTask(linkedTask.id, linkedTask.title)}
                style={{ padding: '4px 12px', background: 'var(--accent-a15)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', color: 'var(--accent)', fontSize: 'var(--font-sm)', fontWeight: 500, cursor: 'pointer' }}>
                {t('issues.viewTask')}
              </button>
            ) : (
              <button onClick={() => onImportAsTask(issue)}
                style={{ padding: '4px 12px', background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff' /* lint-allow: hex - white text on solid accent fill; no on-color token yet */, fontSize: 'var(--font-sm)', fontWeight: 500, cursor: 'pointer' }}>
                {t('issues.createTaskFull')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Labels */}
      {issue.labels.length > 0 && (
        <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {issue.labels.map((l) => (
            <span key={l.name} style={{ padding: '2px 8px', borderRadius: 'var(--radius-md)', fontSize: 'var(--font-sm)', background: l.color ? `#${l.color}20` : 'var(--bg-card)', color: l.color ? `#${l.color}` : 'var(--text-dim)', border: `1px solid ${l.color ? `#${l.color}40` : 'var(--border)'}` }}>{l.name}</span>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="md-content" style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {issue.body ? (
          <MarkdownRenderer content={issue.body} style={{ maxWidth: 800 }} />
        ) : (
          <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 'var(--font-base)' }}>{t('common:states.noDescription')}</div>
        )}
      </div>
    </div>
  );
}
