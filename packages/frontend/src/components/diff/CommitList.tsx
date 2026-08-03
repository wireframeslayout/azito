import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { formatRelativeTime } from '../../utils/time';
import { LoadingState, EmptyState } from '../ui';

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

interface CommitListProps {
  serverName: string;
  path: string;
  baseBranch?: string;
  selectedHash: string | null;
  onSelectCommit: (hash: string) => void;
}

export default function CommitList({ serverName, path, baseBranch, selectedHash, onSelectCommit }: CommitListProps) {
  const { t } = useTranslation('git');
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setCommits([]);

    const params = new URLSearchParams({ path });
    if (baseBranch) params.set('base', baseBranch);

    api<GitCommit[] & { error?: string }>(`/servers/${serverName}/git/commits?${params.toString()}`)
      .then((res) => {
        if (!Array.isArray(res)) throw new Error((res as { error?: string }).error || t('diff.errors.invalidCommitResponse'));
        setCommits(res);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('diff.errors.loadCommitsFailed')))
      .finally(() => setLoading(false));
  }, [serverName, path, baseBranch]);

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--ws-surface)' }}>
        <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--font-md)', padding: 24 }}>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('diff.errors.loadCommitsTitle')}</div>
          <div style={{ color: 'var(--text-dim)' }}>{error}</div>
        </div>
      </div>
    );
  }

  if (commits.length === 0) {
    return <EmptyState title={t('commits.noCommits')} description={t('commits.noCommitsDescription')} />;
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg)' }} role="list" aria-label={t('commits.commitList')}>
      {commits.map((c) => {
        const isSelected = c.hash === selectedHash;
        return (
          <button
            key={c.hash}
            role="listitem"
            onClick={() => onSelectCommit(c.hash)}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              padding: '8px 16px',
              width: '100%',
              border: 'none',
              borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
              background: isSelected ? 'var(--bg-hover)' : 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 'var(--font-md)',
              lineHeight: 1.4,
              color: 'var(--text)',
              borderBottom: '1px solid var(--border)',
              outline: 'none',
              transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => {
              if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)';
            }}
            onMouseLeave={(e) => {
              if (!isSelected) e.currentTarget.style.background = 'transparent';
            }}
            onFocus={(e) => {
              e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent) inset';
            }}
            onBlur={(e) => {
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <code style={{ fontSize: 'var(--font-sm)', color: 'var(--accent)', fontFamily: 'var(--font-mono, monospace)', flexShrink: 0 }}>
              {c.shortHash}
            </code>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.subject}
            </span>
            <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {c.author}
            </span>
            <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {formatRelativeTime(c.date)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
