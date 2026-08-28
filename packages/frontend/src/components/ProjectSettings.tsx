import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Icon } from './ui/Icon';
import { DocsLink } from './ui/DocsLink';
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
import { isDistributeCodeLocked, resolveDistributeCodeForSave, resolveDistributeCodeToggleOnProjectServersChange, shouldShowDistributeCodeBadge } from '../lib/distributeCodePolicy';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';

interface Repository { id: number; url: string; name?: string; provider?: string; owner?: string; repoName?: string; }
interface ProjectServer {
  projectId: number; serverName: string; workingDirectory?: string; branch?: string; tmuxSession: string;
  /** Issue #29 Step 3a: 'allow' is now selectable, but only ever effective for a verified-isolated server — the server degrades it to 'manual-approval' at run time otherwise (see routes.ts's PUT validation and ProjectServer.resolveEffectiveInputPolicy). */
  inputPolicy?: 'deny' | 'manual-approval' | 'allow';
  /** Issue #87 Phase 2: whether the hub distributes this project's code to this server. Meaningless for `local`. Default off. */
  distributeCode?: boolean;
  /** Issue #87: which of the project's repositories distribution pulls onto this server. Required whenever distribution actually runs (distributeCode on, or an isolated server). `null`/`undefined` means unset. */
  distributionRepositoryId?: number | null;
}
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
  // Default 'manual-approval' — matches the server's own fallback when no
  // project_servers row exists yet (see routes.ts PUT handler and
  // ProjectServer.inputPolicy's doc comment). 'allow' is selectable (Issue
  // #29 Step 3a) but the select below only enables it for a row whose
  // target server has declared isolation intent — the server additionally
  // enforces this at save time (400 `input_policy_allow_requires_isolation`)
  // and, more importantly, re-derives the actually-effective policy at RUN
  // TIME from live verification/scoped-auth state, degrading back to
  // 'manual-approval' whenever any of that isn't currently true.
  const [psInputPolicy, setPsInputPolicy] = useState<'deny' | 'manual-approval' | 'allow'>('manual-approval');
  // Issue #87 Phase 2: opt-in hub-代行 code distribution to this server, on
  // the hub's own git credentials — generalizes the isolated-server-only
  // distribution path (mandatory there, since an isolated server holds no
  // credentials of its own) to any agent/ssh server, for instant dev
  // environment provisioning. Default off, meaningless for `local` (the hub
  // itself) — the form hides the toggle entirely for that server (see
  // isPsServerLocal below).
  const [psDistributeCode, setPsDistributeCode] = useState(false);
  // Issue #87 explicit-target follow-up: which of the project's repositories
  // distribution pulls onto this server — required whenever distribution
  // actually runs (see `ProjectServer.distributionRepositoryId`'s doc
  // comment). Stored as a string ('' = unset) to match `FormSelect`'s
  // string-only value contract; converted to `number | null` only at the
  // request boundary (`handleSaveServer`).
  const [psDistributionRepositoryId, setPsDistributionRepositoryId] = useState('');

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

  // Issue #87 review finding (Minor 3): `handleOpenServerForm` already
  // re-derives `psDistributeCode` whenever it's called, but the server
  // `<select>`'s own onChange is the only call site that re-invokes it —
  // if `psServer` ever changes any other way, the toggle's underlying
  // state would keep whatever value it last held even after switching to
  // (or landing on) a `local` server, where the toggle is hidden but the
  // value is still sent on Save. Re-deriving here on every `psServer`
  // change, independent of how it changed, and forcing `false` outright
  // for a `local` target (`distribute_code` is structurally meaningless
  // there — see the toggle's hidden-for-local condition below) closes that
  // gap without relying on a single call site staying in sync.
  //
  // `projectServers` is a real dependency (Issue #87 third-party review,
  // 10th round, Minor finding 3): the `[project]` effect below fetches it
  // asynchronously, so opening this form before that fetch resolves used to
  // read an empty `projectServers` here, initialize the toggle to `false`,
  // and never correct it once the real rows arrived — because this effect
  // was previously keyed only on `[psServer, servers]`, it never re-ran
  // when `projectServers` changed out from under it. A save made in that
  // window would then silently overwrite an existing `distribute_code:
  // true` row with `false`. Including `projectServers` here means the
  // effect re-derives the toggle the moment the fetch lands, matching
  // whatever server is currently selected in the form.
  //
  // Issue #87 third-party review, 11th round, Minor finding 3: that same
  // `projectServers` dependency also means ANY later refetch (e.g. this
  // same async request landing late — dependent on network timing, not
  // just "before the form ever opened" — or a refetch triggered by an
  // unrelated save/remove elsewhere in this component while this form is
  // still open) re-runs this effect and clobbers a toggle the user has
  // since edited by hand. `psDistributeCodeTouchedRef` tracks whether the
  // user has touched the toggle since the form was last (re)opened for the
  // current `psServer` (reset in `handleOpenServerForm`, matching how every
  // other field in this form is (re)initialized only there); once touched,
  // this effect stops overwriting it until the next open. This mirrors the
  // "user edit wins over a late server response" contract the other form
  // fields already get for free by only ever being set from
  // `handleOpenServerForm`.
  const psDistributeCodeTouchedRef = useRef(false);
  useEffect(() => {
    const targetServer = (servers || []).find((sv) => sv.name === psServer);
    // Issue #87 review, eighth pass, Important finding 1: an isolated
    // server's toggle is always shown checked/disabled in the JSX below
    // (via `isDistributeCodeLocked` at the render call site) — that's a
    // pure display derivation, not something this state needs to carry.
    // Forcing `psDistributeCode` itself to `true` here used to get
    // persisted verbatim by `handleSaveServer` (see its own `locked` guard
    // now omitting the field), which meant opting a server INTO isolation
    // silently wrote a `distribute_code: true` row that outlived isolation
    // being turned back off. Keep this state equal to the actual saved
    // value regardless of lock status, so Save never has anything to send
    // beyond what the user actually chose.
    //
    // `resolveDistributeCodeToggleOnProjectServersChange` (distributeCodePolicy.ts)
    // is the single tested place encoding the "touched user edit wins over a
    // late server response" rule described above — functional `setState` so
    // it sees the current value without adding `psDistributeCode` itself as
    // an effect dependency (which would re-run this on every toggle, not just
    // on a real `projectServers`/`servers`/`psServer` change).
    setPsDistributeCode((prev) => resolveDistributeCodeToggleOnProjectServersChange(
      prev, psDistributeCodeTouchedRef.current, targetServer?.type, projectServers, psServer,
    ));
  }, [psServer, servers, projectServers]);

  // Wraps the raw `setPsDistributeCode` state setter for the toggle's own
  // `onChange` (the only manual-edit call site) so a user interaction marks
  // the field dirty — see `psDistributeCodeTouchedRef`'s doc comment above.
  const handleSetPsDistributeCode = useCallback((value: boolean) => {
    psDistributeCodeTouchedRef.current = true;
    setPsDistributeCode(value);
  }, []);

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
    const targetServer = (servers || []).find((sv) => sv.name === psServer);
    // Issue #87 review, eighth pass, Important finding 1: for a locked
    // (isolated) server, `resolveDistributeCodeForSave` returns `undefined`
    // so the key is omitted below — the PUT handler's "key absent ->
    // preserve existing value" semantics (routes.ts) then keep whatever was
    // actually saved before, instead of persisting a forced/display value.
    const resolvedDistributeCode = resolveDistributeCodeForSave(targetServer, psDistributeCode);
    const body: Record<string, unknown> = {
      working_directory: psWorkDir.trim() || null,
      branch: psBranch.trim() || null,
      tmux_session: psTmuxSession.trim() || null,
      input_policy: psInputPolicy,
      distribution_repository_id: psDistributionRepositoryId ? parseInt(psDistributionRepositoryId, 10) : null,
    };
    if (resolvedDistributeCode !== undefined) {
      body.distribute_code = resolvedDistributeCode;
    }
    await api(`/projects/${projectId}/servers/${psServer}`, { method: 'PUT', body: JSON.stringify(body) });
    setAddPsOpen(false); setPsWorkDir(''); setPsBranch(''); setPsTmuxSession(''); setPsInputPolicy('manual-approval'); setPsDistributeCode(false); setPsDistributionRepositoryId('');
    api<ProjectServer[]>(`/projects/${projectId}/servers`).then((res) => setProjectServers(Array.isArray(res) ? res : [])).catch(() => {});
  }, [projectId, psServer, psWorkDir, psBranch, psTmuxSession, psInputPolicy, psDistributeCode, psDistributionRepositoryId, servers]);

  // Opens the add/edit form for `serverName`, pre-filled from its existing
  // project_servers row when one exists (Issue #51 review note: this form's
  // Save always sends every field, so opening it BLANK against an already-
  // configured server would silently wipe workingDirectory/branch/
  // inputPolicy on save — the same field this project's PUT handler
  // otherwise carefully preserves when a key is omitted).
  const handleOpenServerForm = useCallback((serverName: string) => {
    const existing = projectServers.find((ps) => ps.serverName === serverName);
    setPsServer(serverName);
    setPsWorkDir(existing?.workingDirectory ?? '');
    setPsBranch(existing?.branch ?? '');
    setPsTmuxSession(existing?.tmuxSession ?? '');
    setPsInputPolicy(existing?.inputPolicy === 'deny' || existing?.inputPolicy === 'allow' ? existing.inputPolicy : 'manual-approval');
    setPsDistributeCode(existing?.distributeCode ?? false);
    setPsDistributionRepositoryId(existing?.distributionRepositoryId != null ? String(existing.distributionRepositoryId) : '');
    // (Re)opening the form for `serverName` — the toggle's derivation effect
    // is free to overwrite `psDistributeCode` again until the user touches
    // it, same as every other field here being freshly initialized from
    // `existing`. See `psDistributeCodeTouchedRef`'s doc comment above.
    psDistributeCodeTouchedRef.current = false;
    setAddPsOpen(true);
  }, [projectServers]);

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
    // Windows
    handleRemoveWindow,
    // Servers
    projectServers, addPsOpen, setAddPsOpen, psServer, setPsServer,
    psWorkDir, setPsWorkDir, psBranch, setPsBranch, psTmuxSession, setPsTmuxSession,
    psInputPolicy, setPsInputPolicy, psDistributeCode, setPsDistributeCode: handleSetPsDistributeCode,
    psDistributionRepositoryId, setPsDistributionRepositoryId,
    handleSaveServer, handleRemoveServer, handleOpenServerForm,
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
  return (
    <>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12, padding: '8px 12px', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)' }}>
        {t('settings.repositories.tip')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>{t('settings.repositories.count', { count: s.project.repositories.length })}</span>
        <Button size="sm" onClick={() => s.setAddRepoOpen(!s.addRepoOpen)}>+ {t('common:actions.add')}</Button>
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
  const repositories = s.project?.repositories ?? [];
  // Issue #87 explicit-target follow-up: distribution actually runs for the
  // form's currently-selected server whenever the toggle is effectively on
  // (locked-on for an isolated server, or the user's own choice otherwise —
  // same derivation the toggle's own `checked` prop below uses) — a target
  // repository is then required (Fail Fast, never inferred), so Save must
  // be blocked until one is picked.
  const formIsolated = isDistributeCodeLocked((s.servers || []).find((sv) => sv.name === s.psServer));
  const formDistributeEffective = formIsolated || s.psDistributeCode;
  const formDistributionRepoMissing = formDistributeEffective && !s.psDistributionRepositoryId;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>{t('settings.servers.count', { count: s.projectServers.length })}</span>
        <Button
          size="sm"
          onClick={() => {
            if (s.addPsOpen) { s.setAddPsOpen(false); return; }
            s.handleOpenServerForm(s.servers?.length ? s.servers[0].name : '');
          }}
        >+ {t('common:actions.add')}</Button>
      </div>
      {s.addPsOpen && (
        <div style={{ marginBottom: 16, padding: 16, background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
          <FormField label={t('settings.servers.server')}>
            <FormSelect value={s.psServer} onChange={(e) => s.handleOpenServerForm(e.target.value)}>
              {(s.servers || []).map((sv) => <option key={sv.name} value={sv.name}>{sv.name}</option>)}
            </FormSelect>
          </FormField>
          <FormField label={t('settings.servers.workingDirectory')}>
            <DirectoryInput value={s.psWorkDir} onChange={s.setPsWorkDir} serverName={s.psServer} placeholder={t('settings.servers.workingDirectoryPlaceholder')} style={baseInputStyle} />
          </FormField>
          {/* Issue #87 Phase 2: meaningless for `local` (that server IS the
              hub, so "distributing" to it has no effect) — hidden rather than
              disabled, since the reason is structural, not a transient state
              a user could resolve from this form. */}
          {(s.servers || []).find((sv) => sv.name === s.psServer)?.type !== 'local' && (() => {
            // Issue #87 third-party review, seventh pass, Minor finding 3:
            // an isolated server holds no git credentials of its own, so the
            // backend ALWAYS distributes code to it via `isolationIntent`
            // (see `distributeCode` docs) regardless of this saved flag —
            // toggling it off here would silently do nothing, and the list
            // badge below would then wrongly claim "not distributed". Lock
            // the toggle on (disabled, checked) and explain why via the
            // hint, instead of letting the operator believe they can turn
            // it off. Issue #87 review, eighth pass, Important finding 1:
            // `checked` is derived here (`isolated || psDistributeCode`)
            // rather than by forcing `psDistributeCode` itself to `true` —
            // the underlying state stays equal to the actual saved value,
            // so Save (see `handleSaveServer`, which omits the field for a
            // locked server) never persists a phantom opt-in that outlives
            // isolation being turned back off.
            const isolated = isDistributeCodeLocked((s.servers || []).find((sv) => sv.name === s.psServer));
            const distributeEffective = isolated || s.psDistributeCode;
            return (
              <>
                <FormField
                  label=""
                  hint={isolated ? t('settings.servers.distributeCodeIsolatedHint') : t('settings.servers.distributeCodeHint')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: isolated ? 'default' : 'pointer' }}>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={distributeEffective}
                        disabled={isolated}
                        onChange={(e) => s.setPsDistributeCode(e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                    <span style={{ fontSize: 'var(--font-md)', color: 'var(--text)' }}>{t('settings.servers.distributeCode')}</span>
                  </span>
                </FormField>
                {/* Issue #87 explicit-target follow-up: shown only while
                    distribution is effectively on for this server — hidden
                    (not merely disabled) when off, matching the toggle
                    itself being hidden entirely for `local`. Fail Fast: no
                    implicit fallback even when the project has exactly one
                    repository — see `ProjectServer.distributionRepositoryId`'s
                    doc comment for why. */}
                {distributeEffective && (
                  <FormField
                    label={t('settings.servers.distributionRepository')}
                    hint={t('settings.servers.distributionRepositoryHint')}
                    error={formDistributionRepoMissing ? t('settings.servers.distributionRepositoryRequired') : undefined}
                  >
                    <FormSelect
                      value={s.psDistributionRepositoryId}
                      onChange={(e) => s.setPsDistributionRepositoryId(e.target.value)}
                    >
                      <option value="">{t('settings.servers.distributionRepositoryPlaceholder')}</option>
                      {repositories.map((r) => (
                        <option key={r.id} value={String(r.id)}>{r.name || r.url}</option>
                      ))}
                    </FormSelect>
                  </FormField>
                )}
              </>
            );
          })()}
          <FormField label={t('settings.servers.branch')}>
            <FormInput value={s.psBranch} onChange={(e) => s.setPsBranch(e.target.value)} placeholder={t('settings.servers.branchPlaceholder')} />
          </FormField>
          <FormField label={t('settings.servers.tmuxSession')} hint={t('settings.servers.tmuxSessionHint')}>
            <FormInput value={s.psTmuxSession} onChange={(e) => s.setPsTmuxSession(e.target.value)} placeholder={t('settings.servers.tmuxSessionPlaceholder')} />
          </FormField>
          <FormField label={t('settings.servers.inputPolicy')} hint={t('settings.servers.inputPolicyHint')}>
            <FormSelect
              value={s.psInputPolicy}
              onChange={(e) => {
                const v = e.target.value;
                s.setPsInputPolicy(v === 'deny' || v === 'allow' ? v : 'manual-approval');
              }}
            >
              <option value="manual-approval">{t('settings.servers.inputPolicyManualApproval')}</option>
              <option value="deny">{t('settings.servers.inputPolicyDeny')}</option>
              {/* Issue #29 Step 3a: client-side hint only — selectable ONLY for
                  a row whose target server has declared isolation intent. The
                  real enforcement is server-side: PUT rejects 'allow' for a
                  non-isolated server (400), and the run-time gate additionally
                  requires a current doctor verification + scoped auth before
                  'allow' is ever actually effective. */}
              <option value="allow" disabled={!(s.servers || []).find((sv) => sv.name === s.psServer)?.isolationIntent}>
                {t('settings.servers.inputPolicyAllow')}
              </option>
            </FormSelect>
          </FormField>
          {s.psInputPolicy === 'allow' && (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: -8, marginBottom: 12 }}>
              {t('settings.servers.inputPolicyAllowHint')} <DocsLink page="isolated-execution" />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => s.setAddPsOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={s.handleSaveServer} disabled={formDistributionRepoMissing}>{t('common:actions.save')}</Button>
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
              <span style={{ color: ps.inputPolicy === 'deny' ? 'var(--danger)' : ps.inputPolicy === 'allow' ? 'var(--accent)' : 'var(--text-dim)', marginLeft: 8 }}>
                {ps.inputPolicy === 'deny' ? t('settings.servers.inputPolicyDeny') : ps.inputPolicy === 'allow' ? t('settings.servers.inputPolicyAllow') : t('settings.servers.inputPolicyManualApproval')}
              </span>
              {/* Issue #87 third-party review, seventh pass, Minor finding 3:
                  an isolated server distributes ALWAYS (`isolationIntent`),
                  regardless of what `ps.distributeCode` was last saved as —
                  showing the badge only on `distributeCode` let an operator
                  who turned the (now-locked, always-on) toggle off in an
                  earlier session see a list that wrongly implies nothing is
                  being distributed. */}
              {shouldShowDistributeCodeBadge((s.servers || []).find((sv) => sv.name === ps.serverName), ps.distributeCode) ? (
                <span style={{ color: 'var(--accent)', marginLeft: 8 }}>
                  {t('settings.servers.distributeCodeBadge')}
                  {ps.distributionRepositoryId != null && (() => {
                    const repo = repositories.find((r) => r.id === ps.distributionRepositoryId);
                    return repo ? <span style={{ color: 'var(--text-dim)' }}> ({repo.name || repo.url})</span> : null;
                  })()}
                </span>
              ) : null}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" onClick={() => s.handleOpenServerForm(ps.serverName)}>{t('common:actions.edit')}</Button>
              <Button size="sm" onClick={() => s.handleRemoveServer(ps.serverName)}>{t('common:actions.remove')}</Button>
            </span>
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
