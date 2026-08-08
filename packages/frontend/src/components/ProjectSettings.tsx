import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Icon } from './ui/Icon';
import { useApi } from '../hooks/useApi';
import { useAddWindowModal } from '../hooks/useAddWindowModal';
import { useIsMobile } from '../hooks/useIsMobile';
import type { PersistedTab } from '../hooks/useTabPersistence';
import FormField from './FormField';
import ProjectGeneralFields from './ProjectGeneralFields';
import DirectoryInput from './DirectoryInput';
import AddWindowModal from './workspace/AddWindowModal';
import ResourceWarningDialog from './ResourceWarningDialog';
import { FormInput, FormSelect, LoadingState, baseInputStyle, Button } from './ui';
import type { Window, Unit, Server } from '../pages/workspace/types';
import { parseRepoUrl as parseGitRepoUrl } from '../lib/gitProvider';
import { notifyProjectsChanged } from '../lib/projectsChanged';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import RepoDiscoveryDialog from './RepoDiscoveryDialog';

interface Repository { id: number; url: string; name?: string; provider?: string; owner?: string; repoName?: string; }
interface ProjectServer { projectId: number; serverName: string; workingDirectory?: string; branch?: string; tmuxSession: string; }
interface Project {
  id: number; name: string; slug: string; description?: string;
  repositoryUrl?: string; defaultBranch?: string; sidekickPrompt?: string;
  defaultUnitId?: number | null; workingDirectory?: string;
  windows: Window[]; repositories: Repository[];
}
interface TmuxWindow { index: number; name: string; panes: { index: number }[]; }
interface Session { name: string; windows: TmuxWindow[]; }

export type SettingsSection = 'general' | 'repositories' | 'servers' | 'secrets' | 'danger';

export function useProjectSettings(
  projectId: number,
  tabs: PersistedTab[],
  closeTab: (id: string) => void,
) {
  const navigate = useNavigate();
  const { data: project, refresh } = useApi<Project>(`/projects/${projectId}`);
  const { data: servers } = useApi<Server[]>('/servers');
  const { data: unitsData } = useApi<Unit[]>('/units');
  const units = unitsData || [];

  const [section, setSection] = useState<SettingsSection>('general');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [projectRepoUrl, setProjectRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [sidekickPrompt, setSidekickPrompt] = useState('');
  const [defaultUnitId, setDefaultUnitId] = useState('');
  const [saving, setSaving] = useState(false);

  const [projectServers, setProjectServers] = useState<ProjectServer[]>([]);
  const [addPsOpen, setAddPsOpen] = useState(false);
  const [psServer, setPsServer] = useState('');
  const [psWorkDir, setPsWorkDir] = useState('');
  const [psBranch, setPsBranch] = useState('');
  const [psTmuxSession, setPsTmuxSession] = useState('');

  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoProvider, setRepoProvider] = useState('github');
  const [repoOwner, setRepoOwner] = useState('');
  const [repoRepoName, setRepoRepoName] = useState('');
  const [repoToken, setRepoToken] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation(['projects', 'common']);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverSuggestion, setDiscoverSuggestion] = useState<{ serverName: string; count: number } | null>(null);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setSlug(project.slug || '');
      setDescription(project.description || '');
      setProjectRepoUrl(project.repositoryUrl || '');
      setDefaultBranch(project.defaultBranch || 'main');
      setSidekickPrompt(project.sidekickPrompt || '');
      setIcon((project as any).icon || '');
      setColor((project as any).color || '');
      setDefaultUnitId(project.defaultUnitId ? String(project.defaultUnitId) : '');
      api<ProjectServer[]>(`/projects/${project.id}/servers`).then((res) => setProjectServers(Array.isArray(res) ? res : [])).catch(() => setProjectServers([]));
    }
  }, [project]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) return showToast(t('common:validation.nameRequired'));
    setSaving(true);
    try {
      await api(`/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({
        name: name.trim(), slug: slug.trim(),
        description: description.trim(),
        repository_url: projectRepoUrl.trim() || null,
        default_branch: defaultBranch.trim() || 'main',
        sidekick_prompt: sidekickPrompt.trim(),
        icon: icon.trim() || null,
        color: color.trim() || null,
        default_unit_id: defaultUnitId ? parseInt(defaultUnitId, 10) : null,
      }) });
      notifyProjectsChanged();
      refresh();
    } finally {
      setSaving(false);
    }
  }, [projectId, name, slug, description, projectRepoUrl, defaultBranch, sidekickPrompt, icon, color, defaultUnitId, refresh, showToast, t]);

  const handleDelete = useCallback(async () => {
    const ok = await confirm({ title: t('settings.danger.deleteConfirm'), message: t('settings.danger.deleteConfirmMessage'), danger: true });
    if (!ok) return;
    await api(`/projects/${projectId}`, { method: 'DELETE' });
    notifyProjectsChanged();
    navigate('/', { replace: true });
  }, [projectId, navigate, confirm, t]);

  const parseRepoUrl = useCallback((url: string) => {
    const parsed = parseGitRepoUrl(url);
    if (!parsed) return;
    setRepoOwner(parsed.owner); setRepoRepoName(parsed.repo); setRepoProvider(parsed.provider);
  }, []);

  const handleAddRepo = useCallback(async () => {
    if (!repoUrl.trim()) return showToast(t('common:validation.urlRequired'));
    await api(`/projects/${projectId}/repositories`, {
      method: 'POST', body: JSON.stringify({
        url: repoUrl.trim(), name: repoName.trim() || undefined, provider: repoProvider,
        owner: repoOwner.trim() || undefined, repo_name: repoRepoName.trim() || undefined,
        token: repoToken.trim() || undefined,
      }),
    });
    setRepoUrl(''); setRepoName(''); setRepoProvider('github'); setRepoOwner(''); setRepoRepoName(''); setRepoToken('');
    setAddRepoOpen(false); refresh();
  }, [projectId, repoUrl, repoName, repoProvider, repoOwner, repoRepoName, repoToken, refresh, showToast, t]);

  const handleRemoveRepo = useCallback(async (rid: number) => {
    await api(`/projects/${projectId}/repositories/${rid}`, { method: 'DELETE' }); refresh();
  }, [projectId, refresh]);

  const handleRemoveWindow = useCallback(async (wid: number) => {
    const win = project?.windows.find((w) => w.id === wid);
    await api(`/windows/${wid}`, { method: 'DELETE' });
    if (win) {
      tabs
        .filter((t) => t.id.startsWith(`terminal:${win.serverName}/${win.tmuxTarget}.`))
        .forEach((t) => closeTab(t.id));
    }
    refresh();
  }, [projectId, project, tabs, closeTab, refresh]);

  const handleSaveServer = useCallback(async () => {
    await api(`/projects/${projectId}/servers/${psServer}`, {
      method: 'PUT', body: JSON.stringify({
        working_directory: psWorkDir.trim() || null,
        branch: psBranch.trim() || null,
        tmux_session: psTmuxSession.trim() || null,
      }),
    });
    const savedServer = psServer;
    const savedWorkDir = psWorkDir.trim();
    setAddPsOpen(false); setPsWorkDir(''); setPsBranch(''); setPsTmuxSession('');
    api<ProjectServer[]>(`/projects/${projectId}/servers`).then((res) => setProjectServers(Array.isArray(res) ? res : [])).catch(() => {});
    if (savedWorkDir) {
      api<{ repositories: Array<{ remotes: Array<{ alreadyRegistered: boolean }> }> }>(
        `/projects/${projectId}/servers/${savedServer}/discover-repositories`,
      ).then((res) => {
        const unregistered = res.repositories.reduce(
          (n, r) => n + r.remotes.filter((rm) => !rm.alreadyRegistered).length, 0,
        );
        if (unregistered > 0) {
          setDiscoverSuggestion({ serverName: savedServer, count: unregistered });
        }
      }).catch((e: unknown) => console.warn('discover-repositories:', e));
    }
  }, [projectId, psServer, psWorkDir, psBranch, psTmuxSession]);

  const handleRemoveServer = useCallback(async (serverName: string) => {
    await api(`/projects/${projectId}/servers/${serverName}`, { method: 'DELETE' });
    api<ProjectServer[]>(`/projects/${projectId}/servers`).then((res) => setProjectServers(Array.isArray(res) ? res : [])).catch(() => {});
  }, [projectId]);

  return {
    project, servers, refresh, section, setSection, saving,
    // General
    name, setName, slug, setSlug, description, setDescription, projectRepoUrl, setProjectRepoUrl,
    defaultBranch, setDefaultBranch, sidekickPrompt, setSidekickPrompt,
    icon, setIcon, color, setColor, handleSave,
    defaultUnitId, setDefaultUnitId, units,
    // Repositories
    addRepoOpen, setAddRepoOpen, repoUrl, setRepoUrl, repoName, setRepoName,
    repoProvider, setRepoProvider, repoOwner, setRepoOwner, repoRepoName, setRepoRepoName,
    repoToken, setRepoToken, parseRepoUrl, handleAddRepo, handleRemoveRepo,
    discoverOpen, setDiscoverOpen, discoverSuggestion, setDiscoverSuggestion,
    // Windows
    handleRemoveWindow,
    // Servers
    projectServers, addPsOpen, setAddPsOpen, psServer, setPsServer,
    psWorkDir, setPsWorkDir, psBranch, setPsBranch, psTmuxSession, setPsTmuxSession, handleSaveServer, handleRemoveServer,
    // Danger
    handleDelete,
  };
}

const SECTIONS: { id: SettingsSection; labelKey: string; icon: React.ReactNode }[] = [
  { id: 'general', labelKey: 'settings.sections.general', icon: <Icon name="edit" size={16} /> },
  { id: 'repositories', labelKey: 'settings.sections.repositories', icon: <Icon name="repos" size={16} /> },
  { id: 'servers', labelKey: 'settings.sections.serverEnvironments', icon: <Icon name="servers" size={16} /> },
  { id: 'secrets', labelKey: 'settings.sections.secrets', icon: <Icon name="settings" size={16} /> },
  { id: 'danger', labelKey: 'settings.sections.dangerZone', icon: <Icon name="warning" size={16} /> },
];

export function SettingsSidebar({ section, setSection }: { section: SettingsSection; setSection: (s: SettingsSection) => void }) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
      <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', padding: '12px 12px 8px' }}>
        {t('settings.title')}
      </div>
      {SECTIONS.map((s) => (
        <div key={s.id} onClick={() => setSection(s.id)}
          style={{
            padding: '10px 12px', fontSize: 'var(--font-md)', cursor: 'pointer', borderRadius: 'var(--radius-sm)', margin: '1px 8px',
            display: 'flex', alignItems: 'center', gap: 8, minHeight: 40,
            background: section === s.id ? 'var(--accent-a15)' : 'transparent',
            color: section === s.id ? 'var(--accent)' : 'inherit',
          }}>
          <span style={{ fontSize: 'var(--font-base)', width: 20, textAlign: 'center' }}>{s.icon}</span>
          <span>{t(s.labelKey)}</span>
        </div>
      ))}
    </div>
  );
}

export function SettingsContent({ settings }: { settings: ReturnType<typeof useProjectSettings> }) {
  const s = settings;
  const { t } = useTranslation(['projects', 'common']);
  const isMobile = useIsMobile();
  const projectId = s.project?.id ? String(s.project.id) : undefined;
  const addWindowModal = useAddWindowModal(
    projectId,
    s.project,
    (s.servers || []) as Server[],
    s.projectServers,
    s.refresh,
  );

  if (!s.project) return <LoadingState />;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, flexShrink: 0 }}>
        <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 600, margin: 0 }}>
          {t(SECTIONS.find((sec) => sec.id === s.section)?.labelKey ?? 'settings.title')}
        </h2>
        {s.section === 'general' && (
          <Button variant="primary" size="sm" onClick={s.handleSave} loading={s.saving} loadingLabel={t('common:actions.saving')}>
            {t('common:actions.save')}
          </Button>
        )}
      </div>

      {isMobile && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          <select
            value={s.section}
            onChange={(e) => s.setSection(e.target.value as SettingsSection)}
            aria-label={t('settings.title')}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 12px',
              fontSize: 'var(--font-base)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
              color: 'var(--text)',
            }}
          >
            {SECTIONS.map((sec) => (
              <option key={sec.id} value={sec.id}>{t(sec.labelKey)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 700 }}>
          {s.section === 'general' && <GeneralSection settings={s} />}
          {s.section === 'repositories' && <RepositoriesSection settings={s} addWindowModal={addWindowModal} />}
          {s.section === 'servers' && <ServersSection settings={s} />}
          {s.section === 'secrets' && s.project && <SecretsSection projectId={s.project.id} />}
          {s.section === 'danger' && <DangerSection settings={s} />}
        </div>
      </div>

      <AddWindowModal
        open={addWindowModal.addWindowOpen}
        onClose={() => addWindowModal.setAddWindowOpen(false)}
        loading={addWindowModal.addWindowLoading}
        onSubmit={() => addWindowModal.handleAddWindow()}
        awMode={addWindowModal.awMode}
        setAwMode={addWindowModal.setAwMode}
        awServer={addWindowModal.awServer}
        setAwServer={addWindowModal.setAwServer}
        awTarget={addWindowModal.awTarget}
        setAwTarget={addWindowModal.setAwTarget}
        awLabel={addWindowModal.awLabel}
        setAwLabel={addWindowModal.setAwLabel}
        awSessionData={addWindowModal.awSessionData}
        setAwSessionData={addWindowModal.setAwSessionData}
        awSelectedSession={addWindowModal.awSelectedSession}
        setAwSelectedSession={addWindowModal.setAwSelectedSession}
        awNewSession={addWindowModal.awNewSession}
        awNewWindowName={addWindowModal.awNewWindowName}
        setAwNewWindowName={addWindowModal.setAwNewWindowName}
        awNewCommand={addWindowModal.awNewCommand}
        setAwNewCommand={addWindowModal.setAwNewCommand}
        awWorkDir={addWindowModal.awWorkDir}
        setAwWorkDir={addWindowModal.setAwWorkDir}
        awAgent={addWindowModal.awAgent}
        onAgentChange={addWindowModal.handleAgentChange}
        awAgentModel={addWindowModal.awAgentModel}
        setAwAgentModel={addWindowModal.setAwAgentModel}
        awWorkerModels={addWindowModal.awWorkerModels}
        agentPresets={addWindowModal.agentPresets}
        agentPresetsLoading={addWindowModal.agentPresetsLoading}
        agentPresetsError={addWindowModal.agentPresetsError}
        servers={(s.servers || []) as Server[]}
        projectServers={s.projectServers}
        project={s.project}
      />
      <ResourceWarningDialog
        open={addWindowModal.awResourceWarning !== null}
        title={t('settings.resourceWarning.title')}
        resources={addWindowModal.awResourceWarning?.resources ?? null}
        actionLabel={t('settings.resourceWarning.actionLabel')}
        onCancel={() => addWindowModal.setAwResourceWarning(null)}
        onForce={() => addWindowModal.awResourceWarning?.retry()}
      />
    </div>
  );
}

function GeneralSection({ settings: s }: { settings: ReturnType<typeof useProjectSettings> }) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <>
      <ProjectGeneralFields
        name={s.name} setName={s.setName}
        slug={s.slug} setSlug={s.setSlug}
        slugManuallyEdited
        description={s.description} setDescription={s.setDescription}
        icon={s.icon} setIcon={s.setIcon}
        color={s.color} setColor={s.setColor}
        projectRepoUrl={s.projectRepoUrl} setProjectRepoUrl={s.setProjectRepoUrl}
        defaultBranch={s.defaultBranch} setDefaultBranch={s.setDefaultBranch}
        sidekickPrompt={s.sidekickPrompt} setSidekickPrompt={s.setSidekickPrompt}
      />
      <FormField label={t('settings.general.defaultUnit')} hint={t('settings.general.defaultUnitHint')}>
        <FormSelect value={s.defaultUnitId} onChange={(e) => s.setDefaultUnitId(e.target.value)}>
          <option value="">{t('settings.general.defaultUnitNone')}</option>
          {s.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </FormSelect>
      </FormField>
    </>
  );
}

function RepositoriesSection({ settings: s, addWindowModal }: { settings: ReturnType<typeof useProjectSettings>; addWindowModal: ReturnType<typeof useAddWindowModal> }) {
  const { t } = useTranslation(['projects', 'common']);
  if (!s.project) return null;
  const hasServerWithWorkDir = s.projectServers.some((ps) => ps.workingDirectory);
  return (
    <>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12, padding: '8px 12px', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)' }}>
        {t('settings.repositories.tip')}
      </div>

      {s.discoverSuggestion && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          marginBottom: 12, padding: '10px 14px', borderRadius: 8,
          background: 'var(--accent-a08)', border: '1px solid var(--accent-a35)',
          fontSize: 13,
        }}>
          <span style={{ color: 'var(--accent)' }}>
            {s.discoverSuggestion.count} unregistered {s.discoverSuggestion.count === 1 ? 'repository' : 'repositories'} found
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant="primary" onClick={() => {
              s.setDiscoverOpen(true);
              s.setDiscoverSuggestion(null);
            }}>Review</Button>
            <button
              onClick={() => s.setDiscoverSuggestion(null)}
              aria-label="Dismiss"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-dim)', fontSize: 14 }}
            >&times;</button>
          </span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>{t('settings.repositories.count', { count: s.project.repositories.length })}</span>
        <span style={{ display: 'flex', gap: 6 }}>
          {hasServerWithWorkDir && (
            <Button size="sm" onClick={() => s.setDiscoverOpen(true)}>Discover</Button>
          )}
          <Button size="sm" onClick={() => s.setAddRepoOpen(!s.addRepoOpen)}>+ {t('common:actions.add')}</Button>
        </span>
      </div>
      {s.addRepoOpen && (
        <div style={{ marginBottom: 16, padding: 16, background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
          <FormField label={t('settings.repositories.provider')}>
            <FormSelect value={s.repoProvider} onChange={(e) => s.setRepoProvider(e.target.value)}>
              <option value="github">{t('settings.repositories.github')}</option>
              <option value="gitlab">{t('settings.repositories.gitlab')}</option>
              <option value="other">{t('settings.repositories.other')}</option>
            </FormSelect>
          </FormField>
          <FormField label={t('settings.repositories.repositoryUrl')}>
            <FormInput value={s.repoUrl} onChange={(e) => { s.setRepoUrl(e.target.value); s.parseRepoUrl(e.target.value); }} placeholder={t('settings.repositories.repositoryUrlPlaceholder')} />
          </FormField>
          <div style={{ display: 'flex', gap: 8 }}>
            <FormField label={t('settings.repositories.owner')}>
              <FormInput value={s.repoOwner} onChange={(e) => s.setRepoOwner(e.target.value)} placeholder={t('settings.repositories.ownerPlaceholder')} />
            </FormField>
            <FormField label={t('settings.repositories.repoName')}>
              <FormInput value={s.repoRepoName} onChange={(e) => s.setRepoRepoName(e.target.value)} placeholder={t('settings.repositories.repoNamePlaceholder')} />
            </FormField>
          </div>
          <FormField label={t('settings.repositories.displayName')}>
            <FormInput value={s.repoName} onChange={(e) => s.setRepoName(e.target.value)} placeholder={t('settings.repositories.displayNamePlaceholder')} />
          </FormField>
          <FormField label={t('settings.repositories.token')} hint={t('settings.repositories.tokenHint')}>
            <FormInput value={s.repoToken} onChange={(e) => s.setRepoToken(e.target.value)} placeholder={t('settings.repositories.tokenPlaceholder')} type="password" autoComplete="off" />
          </FormField>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => { s.setAddRepoOpen(false); s.setRepoUrl(''); s.setRepoName(''); s.setRepoProvider('github'); s.setRepoOwner(''); s.setRepoRepoName(''); s.setRepoToken(''); }}>{t('common:actions.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={s.handleAddRepo}>{t('settings.repositories.addRepository')}</Button>
          </div>
        </div>
      )}
      {s.project.repositories.length === 0 && !s.addRepoOpen ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('settings.repositories.noRepositories')}</div>
      ) : (
        s.project.repositories.map((r) => (
          <div key={r.id} style={{ padding: '10px 0', fontSize: 'var(--font-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 'var(--font-2xs)', fontWeight: 600, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', flexShrink: 0 }}>{r.provider || 'github'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name ? `${r.name} — ${r.owner}/${r.repoName || ''}` : r.url}</span>
            </span>
            <Button size="sm" style={{ flexShrink: 0 }} onClick={() => s.handleRemoveRepo(r.id)}>{t('common:actions.remove')}</Button>
          </div>
        ))
      )}

      {s.project && (() => {
        const discoverServer = s.discoverSuggestion?.serverName
          || s.projectServers.find((ps) => ps.workingDirectory)?.serverName;
        return discoverServer ? (
          <RepoDiscoveryDialog
            open={s.discoverOpen}
            onClose={() => s.setDiscoverOpen(false)}
            projectId={s.project.id}
            serverName={discoverServer}
            onRegistered={s.refresh}
          />
        ) : null;
      })()}

      {/* Windows sub-section */}
      <div style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('settings.windows.title')}</span>
          <Button size="sm" onClick={() => addWindowModal.openAddWindow()}>+ {t('common:actions.add')}</Button>
        </div>
        {s.project.windows.length === 0 ? (
          <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('settings.windows.noWindows')}</div>
        ) : (
          s.project.windows.map((w) => (
            <div key={w.id} style={{ padding: '8px 0', fontSize: 'var(--font-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
              <span>
                <code>{w.label || `${w.serverName} / ${w.tmuxTarget}`}</code>
                {w.label && <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>({w.serverName}:{w.tmuxTarget})</span>}
              </span>
              <Button size="sm" onClick={() => s.handleRemoveWindow(w.id)}>{t('common:actions.remove')}</Button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function ServersSection({ settings: s }: { settings: ReturnType<typeof useProjectSettings> }) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>{t('settings.servers.count', { count: s.projectServers.length })}</span>
        <Button size="sm" onClick={() => { s.setAddPsOpen(!s.addPsOpen); if (s.servers?.length) s.setPsServer(s.servers[0].name); }}>+ {t('common:actions.add')}</Button>
      </div>
      {s.addPsOpen && (
        <div style={{ marginBottom: 16, padding: 16, background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
          <FormField label={t('settings.servers.server')}>
            <FormSelect value={s.psServer} onChange={(e) => s.setPsServer(e.target.value)}>
              {(s.servers || []).map((sv) => <option key={sv.name} value={sv.name}>{sv.name}</option>)}
            </FormSelect>
          </FormField>
          <FormField label={t('settings.servers.workingDirectory')}>
            <DirectoryInput value={s.psWorkDir} onChange={s.setPsWorkDir} serverName={s.psServer} placeholder={t('settings.servers.workingDirectoryPlaceholder')} style={baseInputStyle} />
          </FormField>
          <FormField label={t('settings.servers.branch')}>
            <FormInput value={s.psBranch} onChange={(e) => s.setPsBranch(e.target.value)} placeholder={t('settings.servers.branchPlaceholder')} />
          </FormField>
          <FormField label={t('settings.servers.tmuxSession')} hint={t('settings.servers.tmuxSessionHint')}>
            <FormInput value={s.psTmuxSession} onChange={(e) => s.setPsTmuxSession(e.target.value)} placeholder={t('settings.servers.tmuxSessionPlaceholder')} />
          </FormField>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => s.setAddPsOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={s.handleSaveServer}>{t('common:actions.save')}</Button>
          </div>
        </div>
      )}
      {s.projectServers.length === 0 && !s.addPsOpen ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('settings.servers.noServers')}</div>
      ) : (
        s.projectServers.map((ps) => (
          <div key={ps.serverName} style={{ padding: '10px 0', fontSize: 'var(--font-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
            <span>
              <strong>{ps.serverName}</strong>
              {ps.workingDirectory && <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>{ps.workingDirectory}</span>}
              {ps.branch && <span style={{ color: 'var(--accent)', marginLeft: 8 }}>{ps.branch}</span>}
              <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>{t('settings.servers.session', { name: ps.tmuxSession })}</span>
            </span>
            <Button size="sm" onClick={() => s.handleRemoveServer(ps.serverName)}>{t('common:actions.remove')}</Button>
          </div>
        ))
      )}
    </>
  );
}

function DangerSection({ settings: s }: { settings: ReturnType<typeof useProjectSettings> }) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <div>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 16, lineHeight: 1.5 }}>
        {t('settings.danger.description')}
      </p>
      <Button variant="danger" onClick={s.handleDelete}>{t('settings.danger.deleteProject')}</Button>
    </div>
  );
}

function SecretsSection({ projectId }: { projectId: number }) {
  const { data: secrets, refresh } = useApi<{ name: string; createdAt: string }[]>(`/projects/${projectId}/secrets`);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const { t } = useTranslation(['projects', 'common']);

  const handleAdd = async () => {
    setError('');
    if (!/^[A-Z0-9_]{1,64}$/.test(name)) {
      setError(t('settings.secrets.nameValidation'));
      return;
    }
    if (!value || value.length > 4096) {
      setError(t('settings.secrets.valueValidation'));
      return;
    }
    setSaving(true);
    try {
      await api(`/projects/${projectId}/secrets`, {
        method: 'POST',
        body: JSON.stringify({ name, value }),
      });
      setName('');
      setValue('');
      refresh();
    } catch {
      setError(t('settings.secrets.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (secretName: string) => {
    const ok = await confirm({ title: t('settings.secrets.deleteConfirm'), message: t('settings.secrets.deleteConfirmMessage', { name: secretName }), danger: true });
    if (!ok) return;
    try {
      await api(`/projects/${projectId}/secrets/${secretName}`, { method: 'DELETE' });
      refresh();
    } catch {
      setError(t('settings.secrets.deleteFailed'));
    }
  };

  return (
    <div>
      <div style={{
        padding: '12px 16px',
        marginBottom: 20,
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-hover)',
        border: '1px solid var(--border)',
        fontSize: 'var(--font-md)',
        lineHeight: 1.5,
        color: 'var(--text-dim)',
      }}>
        <strong style={{ color: 'var(--text)' }}>{t('settings.secrets.noteLabel')}</strong> {t('settings.secrets.note')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 150 }}>
          <label style={{ display: 'block', fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 4, color: 'var(--text-dim)' }}>{t('common:labels.name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            placeholder={t('settings.secrets.namePlaceholder')}
            maxLength={64}
            style={{ ...baseInputStyle, width: '100%', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ flex: '2 1 250px', minWidth: 200 }}>
          <label style={{ display: 'block', fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 4, color: 'var(--text-dim)' }}>{t('settings.secrets.valueLabel')}</label>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('settings.secrets.valuePlaceholder')}
            maxLength={4096}
            style={{ ...baseInputStyle, width: '100%', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button variant="primary" size="sm" onClick={handleAdd} loading={saving} disabled={!name || !value}>
            {t('common:actions.add')}
          </Button>
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--rose)', fontSize: 'var(--font-md)', marginBottom: 12 }}>{error}</div>
      )}

      {!secrets ? (
        <LoadingState />
      ) : secrets.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('settings.secrets.noSecrets')}</div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {secrets.map((s, i) => (
            <div
              key={s.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 16px',
                borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                fontSize: 'var(--font-md)',
              }}
            >
              <div>
                <div style={{ fontWeight: 500, fontFamily: 'monospace' }}>AZITO_SECRET_{s.name}</div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
                  {t('settings.secrets.added', { date: new Date(s.createdAt).toLocaleDateString() })}
                </div>
              </div>
              <button
                onClick={() => handleDelete(s.name)}
                title={t('settings.secrets.deleteSecret')}
                aria-label={t('settings.secrets.deleteSecretLabel', { name: s.name })}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 6,
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-dim)',
                  fontSize: 'var(--font-base)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--rose)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-dim)')}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
