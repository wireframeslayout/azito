import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import FormField from './FormField';
import { FormInput, FormSelect, Button, LoadingState } from './ui';
import { api } from '../api/client';
import { isSupportedProvider } from '../lib/gitProvider';
import { useToast } from '../hooks/useToast';

export interface IssueImportRepository {
  id: number;
  name?: string;
  provider?: string;
  owner?: string;
  repoName?: string;
}

export interface RemoteIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string; color: string }[];
  user: { login: string; avatarUrl: string };
}

interface IssueImportModalProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  repositories: IssueImportRepository[];
  onSelect: (issue: RemoteIssue, repo: IssueImportRepository) => void;
}

export default function IssueImportModal({ open, onClose, projectId, repositories, onSelect }: IssueImportModalProps) {
  const { t } = useTranslation(['git', 'common']);
  const githubRepos = repositories.filter((r) => isSupportedProvider(r.provider));
  const [repoId, setRepoId] = useState(() => githubRepos.length > 0 ? String(githubRepos[0].id) : '');
  const [search, setSearch] = useState('');
  const [issues, setIssues] = useState<RemoteIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [initialized, setInitialized] = useState(false);
  const { showToast } = useToast();

  const loadIssues = useCallback(async (rid: string, p: number) => {
    if (!rid || !projectId) return;
    setLoading(true);
    try {
      const res = await api<{ issues: RemoteIssue[]; hasMore: boolean }>(`/projects/${projectId}/remote-issues?repo_id=${rid}&page=${p}&per_page=20`);
      setIssues((prev) => p === 1 ? res.issues : [...prev, ...res.issues]);
      setHasMore(res.hasMore);
      setPage(p);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, showToast]);

  const searchIssues = useCallback(async (rid: string, q: string) => {
    if (!rid || !q.trim() || !projectId) return;
    setLoading(true);
    try {
      const res = await api<{ issues: RemoteIssue[] }>(`/projects/${projectId}/remote-issues/search?repo_id=${rid}&q=${encodeURIComponent(q.trim())}`);
      setIssues(res.issues);
      setHasMore(false);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, showToast]);

  const handleRepoChange = useCallback((rid: string) => {
    setRepoId(rid);
    setSearch('');
    setIssues([]);
    loadIssues(rid, 1);
  }, [loadIssues]);

  const handleSearchSubmit = useCallback(() => {
    if (search.trim()) searchIssues(repoId, search);
    else loadIssues(repoId, 1);
  }, [repoId, search, searchIssues, loadIssues]);

  const handleSelect = useCallback((issue: RemoteIssue) => {
    const repo = githubRepos.find((r) => r.id === parseInt(repoId, 10));
    if (repo) onSelect(issue, repo);
  }, [repoId, githubRepos, onSelect]);

  if (open && !initialized) {
    setInitialized(true);
    const firstId = githubRepos.length > 0 ? String(githubRepos[0].id) : '';
    setRepoId(firstId);
    setSearch('');
    setIssues([]);
    setHasMore(false);
    setPage(1);
    if (firstId) loadIssues(firstId, 1);
  }
  if (!open && initialized) {
    setInitialized(false);
  }

  return (
    <Modal title={t('issues.import.title')} open={open} onClose={onClose}>
      {githubRepos.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <FormField label={t('issues.import.repository')}>
            <FormSelect value={repoId} onChange={(e) => handleRepoChange(e.target.value)}>
              {githubRepos.map((r) => <option key={r.id} value={r.id}>{r.name || `${r.owner}/${r.repoName}`}</option>)}
            </FormSelect>
          </FormField>
        </div>
      )}
      {githubRepos.length === 1 && (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
          {githubRepos[0].name || `${githubRepos[0].owner}/${githubRepos[0].repoName}`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <FormInput
          value={search} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearchSubmit(); }}
          placeholder={t('issues.import.searchPlaceholder')}
          style={{ flex: 1 }}
        />
        <Button size="sm" onClick={handleSearchSubmit} style={{ flexShrink: 0 }}>{t('common:actions.search')}</Button>
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
        {issues.length === 0 && !loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>
            {repoId ? t('issues.import.noIssues') : t('issues.import.selectRepository')}
          </div>
        )}
        {issues.map((issue) => (
          <div
            key={issue.number}
            onClick={() => handleSelect(issue)}
            className="row-hover"
            style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: 'var(--font-md)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 600, color: 'var(--accent)' }}>#{issue.number}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {issue.labels.map((l) => (
                <span key={l.name} style={{ fontSize: 'var(--font-2xs)', padding: '1px 6px', borderRadius: 'var(--radius-md)', background: l.color ? `#${l.color}20` : 'var(--bg)', color: l.color ? `#${l.color}` : 'var(--text-dim)', border: `1px solid ${l.color ? `#${l.color}40` : 'var(--border)'}` }}>{l.name}</span>
              ))}
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginLeft: 'auto' }}>{issue.user.login}</span>
            </div>
          </div>
        ))}
        {loading && <LoadingState />}
        {hasMore && !loading && (
          <button onClick={() => loadIssues(repoId, page + 1)} style={{ width: '100%', padding: 10, background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--font-md)', cursor: 'pointer' }}>{t('issues.import.loadMore')}</button>
        )}
      </div>
    </Modal>
  );
}
