import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { EmptyState } from './ui';
import { isSupportedProvider, repoDisplayName } from '../lib/gitProvider';
import { Icon } from './ui/Icon';
import { useConfirm } from '../hooks/useConfirm';
import { AddRepositoryModal } from './settings/RepositoryModals';

interface Repository { id: number; url: string; name?: string; provider?: string; owner?: string; repoName?: string; }

export default function RepoSidebar({
  projectId, repositories, selectedRepoId, onSelectRepo, onRefresh,
}: {
  projectId: number;
  repositories: Repository[];
  selectedRepoId: number | null;
  onSelectRepo: (repoId: number) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation(['git', 'common']);
  // 追加フォームはサイドバー内には持たず、共通モーダル（AddRepositoryModal）に委ねる。
  // サイドバーは一覧と選択に専念する。
  const [addOpen, setAddOpen] = useState(false);
  const confirm = useConfirm();

  const handleRemove = useCallback(async (rid: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirm({ title: t('repo.removeConfirmTitle'), message: t('repo.removeConfirmMessage'), danger: true });
    if (!ok) return;
    await api(`/projects/${projectId}/repositories/${rid}`, { method: 'DELETE' });
    onRefresh();
  }, [projectId, onRefresh, confirm, t]);

  const supportedRepos = repositories.filter((r) => !r.provider || isSupportedProvider(r.provider));
  const otherRepos = repositories.filter((r) => r.provider && !isSupportedProvider(r.provider));

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
      <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', padding: '12px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{t('repo.repositories')} <span style={{ fontWeight: 400, fontSize: 'var(--font-2xs)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 'var(--radius-md)' }}>{repositories.length}</span></span>
        <button onClick={() => setAddOpen(true)} title={t('repo.addRepository')} aria-label={t('repo.addRepository')} className="icon-btn" style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '2px 6px', display: 'inline-flex', alignItems: 'center' }}><Icon name="plus" size={16} /></button>
      </div>

      {supportedRepos.map((r) => {
        const isSelected = selectedRepoId === r.id;
        const displayName = r.name || (r.owner && r.repoName ? `${r.owner}/${r.repoName}` : repoDisplayName(r.url) || r.url);
        return (
          <div key={r.id} onClick={() => onSelectRepo(r.id)}
            className={`row-hover${isSelected ? ' row-selected' : ''}`}
            style={{
              padding: '10px 12px', fontSize: 'var(--font-md)', cursor: 'pointer', borderRadius: 'var(--radius-sm)', margin: '1px 8px',
              display: 'flex', alignItems: 'center', gap: 8, minHeight: 40,
              color: isSelected ? 'var(--accent)' : 'inherit',
            }}>
            <span style={{ width: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}><Icon name="repos" size={14} /></span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
            <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={t('repo.viewOnGitHub')}
              className="icon-btn" style={{ color: 'var(--text-dim)', opacity: 0.6, textDecoration: 'none', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><Icon name="external-link" size={14} /></a>
            <button onClick={(e) => handleRemove(r.id, e)} title={t('common:actions.remove')}
              className="icon-btn" style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '2px 4px', opacity: 0.6, display: 'inline-flex', alignItems: 'center' }}><Icon name="close" size={14} /></button>
          </div>
        );
      })}

      {otherRepos.length > 0 && (
        <>
          <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', padding: '12px 12px 4px', textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('repo.otherSection')}</div>
          {otherRepos.map((r) => (
            <div key={r.id} style={{ padding: '8px 12px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', margin: '1px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.url}</span>
              <button onClick={(e) => handleRemove(r.id, e)} title={t('common:actions.remove')}
                className="icon-btn" style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '2px 4px', opacity: 0.6, display: 'inline-flex', alignItems: 'center' }}><Icon name="close" size={14} /></button>
            </div>
          ))}
        </>
      )}

      {repositories.length === 0 && (
        <EmptyState title={t('repo.noRepositories')} />
      )}

      <AddRepositoryModal
        open={addOpen}
        projectId={projectId}
        onAdded={() => { setAddOpen(false); onRefresh(); }}
        onClose={() => setAddOpen(false)}
      />
    </div>
  );
}
