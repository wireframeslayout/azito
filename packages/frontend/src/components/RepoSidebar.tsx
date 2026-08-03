import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import FormField from './FormField';
import { FormInput, FormSelect, Button, EmptyState } from './ui';
import { parseRepoUrl as parseGitRepoUrl, isSupportedProvider, repoDisplayName } from '../lib/gitProvider';
import { Icon } from './ui/Icon';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';

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
  const [addOpen, setAddOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoProvider, setRepoProvider] = useState('github');
  const [repoOwner, setRepoOwner] = useState('');
  const [repoRepoName, setRepoRepoName] = useState('');
  const [repoToken, setRepoToken] = useState('');
  const { showToast } = useToast();
  const confirm = useConfirm();

  const parseRepoUrl = useCallback((url: string) => {
    const parsed = parseGitRepoUrl(url);
    if (!parsed) return;
    setRepoOwner(parsed.owner); setRepoRepoName(parsed.repo); setRepoProvider(parsed.provider);
  }, []);

  const handleAdd = useCallback(async () => {
    if (!repoUrl.trim()) return showToast(t('repo.urlRequired'));
    await api(`/projects/${projectId}/repositories`, {
      method: 'POST', body: JSON.stringify({
        url: repoUrl.trim(), name: repoName.trim() || undefined, provider: repoProvider,
        owner: repoOwner.trim() || undefined, repo_name: repoRepoName.trim() || undefined,
        token: repoToken.trim() || undefined,
      }),
    });
    setRepoUrl(''); setRepoName(''); setRepoProvider('github'); setRepoOwner(''); setRepoRepoName(''); setRepoToken('');
    setAddOpen(false); onRefresh();
  }, [projectId, repoUrl, repoName, repoProvider, repoOwner, repoRepoName, repoToken, onRefresh, showToast]);

  const handleRemove = useCallback(async (rid: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirm({ title: t('repo.removeConfirmTitle'), message: t('repo.removeConfirmMessage'), danger: true });
    if (!ok) return;
    await api(`/projects/${projectId}/repositories/${rid}`, { method: 'DELETE' });
    onRefresh();
  }, [projectId, onRefresh, confirm]);

  const resetForm = useCallback(() => {
    setAddOpen(false); setRepoUrl(''); setRepoName(''); setRepoProvider('github');
    setRepoOwner(''); setRepoRepoName(''); setRepoToken('');
  }, []);

  const supportedRepos = repositories.filter((r) => !r.provider || isSupportedProvider(r.provider));
  const otherRepos = repositories.filter((r) => r.provider && !isSupportedProvider(r.provider));

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
      <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', padding: '12px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{t('repo.repositories')} <span style={{ fontWeight: 400, fontSize: 'var(--font-2xs)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 'var(--radius-md)' }}>{repositories.length}</span></span>
        <button onClick={() => setAddOpen(!addOpen)} title={t('repo.addRepository')} className="icon-btn" style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '2px 6px', display: 'inline-flex', alignItems: 'center' }}><Icon name="plus" size={16} /></button>
      </div>

      {addOpen && (
        <div style={{ margin: '4px 8px 8px', padding: 10, background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: 'var(--font-md)' }}>
          <FormField label={t('repo.provider')}>
            <FormSelect value={repoProvider} onChange={(e) => setRepoProvider(e.target.value)} style={{ fontSize: 'var(--font-md)' }}>
              <option value="github">{t('repo.github')}</option>
              <option value="gitlab">{t('repo.gitlab')}</option>
              <option value="other">{t('repo.other')}</option>
            </FormSelect>
          </FormField>
          <FormField label={t('repo.repositoryUrl')}>
            <FormInput value={repoUrl} onChange={(e) => { setRepoUrl(e.target.value); parseRepoUrl(e.target.value); }} placeholder={t('repo.repositoryUrlPlaceholder')} style={{ fontSize: 'var(--font-md)' }} />
          </FormField>
          <div style={{ display: 'flex', gap: 6 }}>
            <FormField label={t('repo.owner')}>
              <FormInput value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder={t('repo.ownerPlaceholder')} style={{ fontSize: 'var(--font-md)' }} />
            </FormField>
            <FormField label={t('repo.repoName')}>
              <FormInput value={repoRepoName} onChange={(e) => setRepoRepoName(e.target.value)} placeholder={t('repo.repoNamePlaceholder')} style={{ fontSize: 'var(--font-md)' }} />
            </FormField>
          </div>
          <FormField label={t('repo.displayName')}>
            <FormInput value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder={t('repo.displayNamePlaceholder')} style={{ fontSize: 'var(--font-md)' }} />
          </FormField>
          <FormField label={t('repo.token')} hint={t('repo.tokenHint')}>
            <FormInput value={repoToken} onChange={(e) => setRepoToken(e.target.value)} placeholder={t('repo.tokenPlaceholder')} type="password" autoComplete="off" style={{ fontSize: 'var(--font-md)' }} />
          </FormField>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
            <Button size="sm" onClick={resetForm}>{t('common:actions.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={handleAdd}>{t('common:actions.add')}</Button>
          </div>
        </div>
      )}

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

      {repositories.length === 0 && !addOpen && (
        <EmptyState title={t('repo.noRepositories')} />
      )}
    </div>
  );
}
