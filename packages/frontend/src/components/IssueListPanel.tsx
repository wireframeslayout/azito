import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { timeAgo } from '../utils/time';
import { Chip, LoadingState, EmptyState } from './ui';
import type { ChipTone } from './ui';
import { Icon } from './ui/Icon';
import { useToast } from '../hooks/useToast';

interface Repository { id: number; url: string; name?: string; provider?: string; owner?: string; repoName?: string; }
interface RemoteIssue { number: number; title: string; body: string | null; state: string; labels: { name: string; color: string }[]; user: { login: string; avatarUrl: string }; createdAt: string; htmlUrl: string; }
interface RemotePullRequest { number: number; title: string; body: string | null; state: 'open' | 'closed' | 'merged'; user: { login: string; avatarUrl: string | null }; labels: { name: string; color: string }[]; htmlUrl: string; headBranch: string; baseBranch: string; draft: boolean; createdAt: string; updatedAt: string; }

type TabMode = 'issues' | 'pulls';

export default function IssueListPanel({
  projectId, repository, onOpenIssue, onImportIssue, linkedTasksByRef, onOpenTask,
}: {
  projectId: number;
  repository: Repository;
  onOpenIssue: (issue: RemoteIssue) => void;
  onImportIssue: (issue: RemoteIssue) => void;
  linkedTasksByRef?: Map<string, { id: number; title: string }>;
  onOpenTask?: (taskId: number, title: string) => void;
}) {
  const { t } = useTranslation(['git', 'common']);
  const [tabMode, setTabMode] = useState<TabMode>('issues');
  const [issues, setIssues] = useState<RemoteIssue[]>([]);
  const [pullRequests, setPullRequests] = useState<RemotePullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [search, setSearch] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const { showToast } = useToast();

  const loadIssues = useCallback(async (p: number, s: string, fresh = false) => {
    setLoading(true);
    try {
      const freshParam = fresh ? '&fresh=1' : '';
      const res = await api<{ issues: RemoteIssue[]; hasMore: boolean }>(`/projects/${projectId}/remote-issues?repo_id=${repository.id}&state=${s}&page=${p}&per_page=20${freshParam}`);
      const items = res.issues || [];
      setIssues((prev) => p === 1 ? items : [...prev, ...items]);
      setHasMore(res.hasMore ?? false);
      setPage(p);
      setIsSearchMode(false);
    } catch (err: unknown) {
      showToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, repository.id, showToast]);

  const loadPullRequests = useCallback(async (p: number, s: string, fresh = false) => {
    setLoading(true);
    try {
      const freshParam = fresh ? '&fresh=1' : '';
      const res = await api<{ pullRequests: RemotePullRequest[]; hasMore: boolean }>(`/projects/${projectId}/remote-pulls?repo_id=${repository.id}&state=${s}&page=${p}&per_page=20${freshParam}`);
      const items = res.pullRequests || [];
      setPullRequests((prev) => p === 1 ? items : [...prev, ...items]);
      setHasMore(res.hasMore ?? false);
      setPage(p);
      setIsSearchMode(false);
    } catch (err: unknown) {
      showToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, repository.id, showToast]);

  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) { loadIssues(1, state); return; }
    setLoading(true);
    try {
      const res = await api<{ issues: RemoteIssue[] }>(`/projects/${projectId}/remote-issues/search?repo_id=${repository.id}&q=${encodeURIComponent(query.trim())}`);
      setIssues(res.issues || []);
      setHasMore(false);
      setIsSearchMode(true);
    } catch (err: unknown) {
      showToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, repository.id, loadIssues, state, showToast]);

  useEffect(() => {
    setIssues([]);
    setPullRequests([]);
    setSearch('');
    setPage(1);
    setIsSearchMode(false);
    if (tabMode === 'issues') {
      loadIssues(1, state);
    } else {
      loadPullRequests(1, state);
    }
  }, [repository.id, state, tabMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchSubmit = useCallback(() => {
    if (tabMode === 'issues') {
      if (search.trim()) doSearch(search);
      else loadIssues(1, state);
    }
    // PR search not supported by GitHub REST API (no dedicated endpoint), so ignore for pulls
  }, [search, doSearch, loadIssues, state, tabMode]);

  const handleLoadMore = useCallback(() => {
    if (tabMode === 'issues') {
      loadIssues(page + 1, state);
    } else {
      loadPullRequests(page + 1, state);
    }
  }, [tabMode, page, state, loadIssues, loadPullRequests]);

  const handleRefresh = useCallback(() => {
    setSearch('');
    if (tabMode === 'issues') {
      loadIssues(1, state, true);
    } else {
      loadPullRequests(1, state, true);
    }
  }, [tabMode, state, loadIssues, loadPullRequests]);

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px',
    background: active ? 'var(--accent, #58a6ff)' : 'var(--bg)',
    color: active ? '#fff' : 'var(--text-dim)', // lint-allow: hex - white text on solid accent fill; no on-color token yet
    border: `1px solid ${active ? 'var(--accent, #58a6ff)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--font-md)',
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  });

  const prStateBadge = (prState: string, draft: boolean) => {
    let tone: ChipTone, label: string;
    if (draft) {
      tone = 'default';
      label = t('issues.prStatus.draft');
    } else if (prState === 'merged') {
      tone = 'purple';
      label = t('issues.prStatus.merged');
    } else if (prState === 'closed') {
      tone = 'red';
      label = t('issues.prStatus.closed');
    } else {
      tone = 'green';
      label = t('issues.prStatus.open');
    }
    return <Chip tone={tone}>{label}</Chip>;
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', flexShrink: 0 }}>
        <div style={{ fontSize: 'var(--font-lg)', fontWeight: 600, marginBottom: 10 }}>
          {repository.owner}/{repository.repoName}
        </div>
        {/* Tab toggle */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button onClick={() => setTabMode('issues')} style={tabStyle(tabMode === 'issues')}>{t('issues.title')}</button>
          <button onClick={() => setTabMode('pulls')} style={tabStyle(tabMode === 'pulls')}>{t('issues.pullRequests')}</button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={state} onChange={(e) => setState(e.target.value as 'open' | 'closed' | 'all')}
            style={{ padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', outline: 'none' }}>
            <option value="open">{t('issues.open')}</option>
            <option value="closed">{t('issues.closed')}</option>
            <option value="all">{t('issues.all')}</option>
          </select>
          <button onClick={handleRefresh} disabled={loading} title={t('issues.refresh')} aria-label={t('issues.refresh')}
            className="icon-btn"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              color: 'var(--text-dim)', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1,
            }}>
            <Icon name="refresh" size={14} />
          </button>
          {tabMode === 'issues' && (
            <div style={{ flex: 1, display: 'flex', gap: 6 }}>
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSearchSubmit(); }}
                placeholder={t('issues.searchPlaceholder')}
                style={{ flex: 1, padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', outline: 'none', minWidth: 0 }} />
              <button onClick={handleSearchSubmit}
                style={{ padding: '6px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', fontSize: 'var(--font-md)', cursor: 'pointer' }}>{t('common:actions.search')}</button>
            </div>
          )}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tabMode === 'issues' ? (
          <>
            {issues.length === 0 && !loading && (
              <EmptyState title={isSearchMode ? t('issues.noMatching') : t('issues.noIssues')} />
            )}
            {issues.map((issue) => (
              <div key={issue.number}
                className="row-hover"
                style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 12 }}
                onClick={() => onOpenIssue(issue)}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: issue.state === 'open' ? 'var(--success, #3fb950)' : 'var(--purple, #a371f7)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--font-base)', fontWeight: 500, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>#{issue.number}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--font-sm)' }}>
                    {issue.labels.map((l) => (
                      <span key={l.name} style={{ padding: '1px 7px', borderRadius: 'var(--radius-md)', fontSize: 'var(--font-xs)', background: l.color ? `#${l.color}20` : 'var(--bg-card)', color: l.color ? `#${l.color}` : 'var(--text-dim)', border: `1px solid ${l.color ? `#${l.color}40` : 'var(--border)'}` }}>{l.name}</span>
                    ))}
                    <span style={{ color: 'var(--text-dim)', marginLeft: 'auto', flexShrink: 0 }}>{issue.user.login} &middot; {timeAgo(issue.createdAt)}</span>
                  </div>
                </div>
                {(() => {
                  const ref = `${repository.owner}/${repository.repoName}#${issue.number}`;
                  const linked = linkedTasksByRef?.get(ref);
                  if (linked && onOpenTask) {
                    return (
                      <button onClick={(e) => { e.stopPropagation(); onOpenTask(linked.id, linked.title); }} title={t('issues.viewTaskLink')}
                        style={{ padding: '4px 10px', background: 'var(--accent-a08)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', color: 'var(--accent)', fontSize: 'var(--font-sm)', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap', fontWeight: 500 }}>
                        {t('issues.viewTask')}
                      </button>
                    );
                  }
                  return (
                    <button onClick={(e) => { e.stopPropagation(); onImportIssue(issue); }} title={t('issues.createTaskFromIssue')}
                      style={{ padding: '4px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--accent)', fontSize: 'var(--font-sm)', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {t('issues.createTask')}
                    </button>
                  );
                })()}
              </div>
            ))}
          </>
        ) : (
          <>
            {pullRequests.length === 0 && !loading && (
              <EmptyState title={t('issues.noPullRequests')} />
            )}
            {pullRequests.map((pr) => (
              <div key={pr.number}
                className="row-hover"
                style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 12 }}
                onClick={() => window.open(pr.htmlUrl, '_blank')}>
                {pr.user.avatarUrl ? (
                  <img src={pr.user.avatarUrl} alt="" style={{ width: 24, height: 24, borderRadius: '50%', marginTop: 2, flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 24, height: 24, borderRadius: '50%', marginTop: 2, flexShrink: 0, background: 'var(--bg-card)', border: '1px solid var(--border)' }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--font-base)', fontWeight: 500, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>#{pr.number}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr.title}</span>
                    {prStateBadge(pr.state, pr.draft)}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--font-sm)' }}>
                    <span style={{ padding: '1px 7px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-xs)', background: 'var(--bg-card)', color: 'var(--text-dim)', border: '1px solid var(--border)', fontFamily: 'monospace' }}>
                      {pr.headBranch}
                    </span>
                    <span style={{ color: 'var(--text-dim)' }}>&rarr;</span>
                    <span style={{ padding: '1px 7px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-xs)', background: 'var(--bg-card)', color: 'var(--text-dim)', border: '1px solid var(--border)', fontFamily: 'monospace' }}>
                      {pr.baseBranch}
                    </span>
                    {pr.labels.map((l) => (
                      <span key={l.name} style={{ padding: '1px 7px', borderRadius: 'var(--radius-md)', fontSize: 'var(--font-xs)', background: l.color ? `#${l.color}20` : 'var(--bg-card)', color: l.color ? `#${l.color}` : 'var(--text-dim)', border: `1px solid ${l.color ? `#${l.color}40` : 'var(--border)'}` }}>{l.name}</span>
                    ))}
                    <span style={{ color: 'var(--text-dim)', marginLeft: 'auto', flexShrink: 0 }}>{pr.user.login} &middot; {timeAgo(pr.createdAt)}</span>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
        {loading && <LoadingState />}
        {hasMore && !loading && (
          <button onClick={handleLoadMore}
            style={{ width: '100%', padding: 14, background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--font-md)', cursor: 'pointer' }}>{t('issues.loadMore')}</button>
        )}
      </div>
    </div>
  );
}
