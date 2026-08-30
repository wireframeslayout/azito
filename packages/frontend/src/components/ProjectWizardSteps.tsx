import { useTranslation } from 'react-i18next';
import { Badge, FormInput, FormSelect, InstallSteps, baseInputStyle, SegmentedToggle, type InstallStep } from './ui';
import FormField from './FormField';
import DirectoryInput from './DirectoryInput';
import { stepIndex, type WizardStepId, type CodeMode } from '../lib/projectWizardLogic';

// Presentational step bodies for ProjectWizard.tsx, split out to keep that
// file focused on state/orchestration (this codebase's ~300-line-per-file
// guideline). Every component here is a pure function of props — all state
// lives in ProjectWizard.

export interface ServerListItem {
  name: string;
  type: string;
  isolationIntent?: boolean;
}

export interface DiscoveredRemote {
  name: string;
  url: string;
  provider: 'github' | 'gitlab' | 'other';
  owner: string | null;
  repoName: string | null;
  alreadyRegistered: boolean;
}
export interface DiscoveredRepo {
  relativePath: string;
  absolutePath: string;
  remotes: DiscoveredRemote[];
}

export type DiscoveryStatus = 'idle' | 'checking' | 'error' | { repos: DiscoveredRepo[]; exists: boolean; isGitRepository: boolean };

export type TFunc = ReturnType<typeof useTranslation>['t'];

/** Local mirror of the frontend's `parseRepoUrl` (lib/gitProvider.ts) shaped for the repository-registration payload — that helper only recognizes github/gitlab and returns a stricter shape; this always returns a provider (falling back to 'other') so an unrecognized clone URL can still be registered. */
export function parseCloneUrlForRegistration(url: string): { provider: 'github' | 'gitlab' | 'other'; owner: string | null; repoName: string | null } {
  const ghMatch = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (ghMatch) return { provider: 'github', owner: ghMatch[1], repoName: ghMatch[2] };
  const glMatch = url.match(/gitlab[^/]*[/:]([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/);
  if (glMatch) return { provider: 'gitlab', owner: glMatch[1], repoName: glMatch[2] };
  return { provider: 'other', owner: null, repoName: null };
}

export function StepIndicator({ visibleSteps, currentStep, isMobile, t }: { visibleSteps: WizardStepId[]; currentStep: WizardStepId; isMobile: boolean; t: TFunc }) {
  const idx = stepIndex(visibleSteps, currentStep);
  if (isMobile) {
    return (
      <div style={{ padding: '8px var(--space-4)', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}>
        {t('wizard.stepOf', { current: idx + 1, total: visibleSteps.length })} · {t(`wizard.steps.${currentStep}`)}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px var(--space-4)', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
      {visibleSteps.map((step, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
        return (
          <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20,
              borderRadius: 'var(--radius-full)', fontSize: 'var(--font-2xs)', fontWeight: 600,
              background: state === 'upcoming' ? 'var(--bg-hover)' : 'var(--accent)',
              color: state === 'upcoming' ? 'var(--text-dim)' : '#fff' /* lint-allow: hex - on-color text over solid accent fill */,
            }}>
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span style={{ fontSize: 'var(--font-sm)', color: state === 'current' ? 'var(--text)' : 'var(--text-dim)', fontWeight: state === 'current' ? 600 : 400, whiteSpace: 'nowrap' }}>
              {t(`wizard.steps.${step}`)}
            </span>
            {i < visibleSteps.length - 1 && <span style={{ width: 20, height: 1, background: 'var(--border)' }} />}
          </div>
        );
      })}
    </div>
  );
}

export function EnvironmentStep({ t, serverList, selectedServer, setSelectedServer, existingServerNames, showValidation }: {
  t: TFunc; serverList: ServerListItem[]; selectedServer: string; setSelectedServer: (v: string) => void;
  existingServerNames?: string[]; showValidation: boolean;
}) {
  const selected = serverList.find((sv) => sv.name === selectedServer);
  return (
    <>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginTop: 0 }}>{t('wizard.environment.description')}</p>
      <FormField label={t('wizard.environment.serverLabel')} error={showValidation ? t('wizard.environment.serverRequired') : undefined}>
        <FormSelect value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)}>
          {serverList.map((sv) => {
            const already = existingServerNames?.includes(sv.name);
            return (
              <option key={sv.name} value={sv.name} disabled={already}>
                {sv.name}{sv.isolationIntent ? ` · ${t('wizard.environment.isolatedBadge')}` : ''}{already ? ` (${t('wizard.environment.alreadyAdded')})` : ''}
              </option>
            );
          })}
        </FormSelect>
      </FormField>
      {selected?.isolationIntent && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--accent-a08)' }}>
          <Badge tone="accent">{t('wizard.environment.isolatedBadge')}</Badge>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('wizard.environment.isolatedHint')}</span>
        </div>
      )}
    </>
  );
}

export function CodeStep({
  t, codeMode, setCodeMode, selectedServer, existingPath, onExistingPathChange, discovery,
  selectedRemoteUrls, toggleRemoteSelected, cloneUrl, setCloneUrl, cloneDirectory, setCloneDirectory, cloneBranch, setCloneBranch,
  showValidation,
}: {
  t: TFunc; codeMode: CodeMode; setCodeMode: (m: CodeMode) => void; selectedServer: string;
  existingPath: string; onExistingPathChange: (v: string) => void; discovery: DiscoveryStatus;
  selectedRemoteUrls: Set<string>; toggleRemoteSelected: (url: string) => void;
  cloneUrl: string; setCloneUrl: (v: string) => void; cloneDirectory: string; setCloneDirectory: (v: string) => void;
  cloneBranch: string; setCloneBranch: (v: string) => void; showValidation: boolean;
}) {
  const parsedClone = cloneUrl.trim() ? parseCloneUrlForRegistration(cloneUrl.trim()) : null;
  return (
    <>
      <FormField label="">
        <SegmentedToggle
          size="md"
          value={codeMode}
          onChange={setCodeMode}
          options={[
            { value: 'existing', label: t('wizard.code.modeExisting') },
            { value: 'clone', label: t('wizard.code.modeClone') },
            { value: 'later', label: t('wizard.code.modeLater') },
          ]}
        />
      </FormField>

      {codeMode === 'existing' && (
        <FormField label={t('wizard.code.pathLabel')} error={showValidation ? t('wizard.code.pathRequired') : undefined}>
          <DirectoryInput value={existingPath} onChange={onExistingPathChange} serverName={selectedServer} placeholder={t('wizard.code.pathPlaceholder')} style={baseInputStyle} />
          <DiscoveryResult t={t} discovery={discovery} selectedRemoteUrls={selectedRemoteUrls} toggleRemoteSelected={toggleRemoteSelected} />
        </FormField>
      )}

      {codeMode === 'clone' && (
        <>
          <FormField label={t('wizard.code.cloneUrlLabel')} error={showValidation && !cloneUrl.trim() ? t('wizard.code.cloneUrlRequired') : undefined}>
            <FormInput value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} placeholder={t('wizard.code.cloneUrlPlaceholder')} />
            {parsedClone && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Badge tone={parsedClone.provider === 'github' ? 'accent' : parsedClone.provider === 'gitlab' ? 'orange' : 'neutral'}>{parsedClone.provider}</Badge>
                {parsedClone.owner && parsedClone.repoName && (
                  <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{parsedClone.owner}/{parsedClone.repoName}</span>
                )}
              </div>
            )}
          </FormField>
          <FormField label={t('wizard.code.cloneDirectoryLabel')} error={showValidation && !cloneDirectory.trim() ? t('wizard.code.cloneDirectoryRequired') : undefined}>
            <FormInput value={cloneDirectory} onChange={(e) => setCloneDirectory(e.target.value)} />
          </FormField>
          <FormField label={t('wizard.code.cloneBranchLabel')}>
            <FormInput value={cloneBranch} onChange={(e) => setCloneBranch(e.target.value)} placeholder="main" />
          </FormField>
          <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('wizard.code.cloneNote')}</p>
        </>
      )}

      {codeMode === 'later' && (
        <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>{t('wizard.code.laterNote')}</p>
      )}
    </>
  );
}

function DiscoveryResult({ t, discovery, selectedRemoteUrls, toggleRemoteSelected }: {
  t: TFunc; discovery: DiscoveryStatus; selectedRemoteUrls: Set<string>; toggleRemoteSelected: (url: string) => void;
}) {
  if (discovery === 'idle') return null;
  if (discovery === 'checking') {
    return <div style={{ marginTop: 6, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('wizard.code.checking')}</div>;
  }
  if (discovery === 'error') {
    return <div style={{ marginTop: 6, fontSize: 'var(--font-sm)', color: 'var(--danger)' }}>{t('wizard.code.pathCheckFailed')}</div>;
  }
  if (!discovery.exists) {
    return <div style={{ marginTop: 6, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('wizard.code.pathWillBeCreated')}</div>;
  }
  const remotes = discovery.repos.flatMap((r) => r.remotes.map((remote) => ({ repo: r, remote })));
  if (remotes.length === 0) {
    return (
      <div style={{ marginTop: 6, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
        {discovery.isGitRepository ? t('wizard.code.pathIsGitRepo') : ''} {t('wizard.code.pathNoRepo')}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 6 }}>
        {discovery.repos.length === 1 && discovery.repos[0].relativePath === '.'
          ? t('wizard.code.pathIsGitRepo')
          : t('wizard.code.pathMultipleRepos', { count: discovery.repos.length })}
        {' — '}{t('wizard.code.selectRepos')}
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', maxHeight: 260, overflowY: 'auto' }}>
        {remotes.map(({ repo, remote }) => (
          <label key={`${repo.absolutePath}:${remote.name}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 'var(--font-sm)', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <input type="checkbox" checked={selectedRemoteUrls.has(remote.url)} onChange={() => toggleRemoteSelected(remote.url)} style={{ margin: 0 }} />
            <Badge tone={remote.provider === 'github' ? 'accent' : remote.provider === 'gitlab' ? 'orange' : 'neutral'} style={{ fontSize: 'var(--font-2xs)' }}>{remote.provider}</Badge>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {repo.relativePath === '.' ? (remote.owner && remote.repoName ? `${remote.owner}/${remote.repoName}` : remote.url) : `${repo.relativePath} · ${remote.owner && remote.repoName ? `${remote.owner}/${remote.repoName}` : remote.url}`}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function ConfirmStep({
  t, mode, name, selectedServer, showEnvironmentStep, codeMode, existingPath, cloneUrl, cloneDirectory, steps, running, alreadyCreated,
}: {
  t: TFunc; mode: 'create' | 'addEnvironment'; name: string; selectedServer: string; showEnvironmentStep: boolean;
  codeMode: CodeMode; existingPath: string; cloneUrl: string; cloneDirectory: string;
  steps: InstallStep[]; running: boolean; alreadyCreated: boolean;
}) {
  return (
    <>
      {mode === 'create' && (
        <FormField label={t('wizard.confirm.projectLabel')}>
          <div style={{ fontSize: 'var(--font-md)' }}>{name}</div>
        </FormField>
      )}
      {showEnvironmentStep && (
        <FormField label={t('wizard.confirm.environmentLabel')}>
          <div style={{ fontSize: 'var(--font-md)' }}>{selectedServer}</div>
        </FormField>
      )}
      <FormField label={t('wizard.confirm.codeLabel')}>
        <div style={{ fontSize: 'var(--font-md)' }}>
          {codeMode === 'existing' && t('wizard.confirm.codeExisting', { path: existingPath })}
          {codeMode === 'clone' && t('wizard.confirm.codeClone', { url: cloneUrl, dir: cloneDirectory })}
          {codeMode === 'later' && t('wizard.confirm.codeLater')}
        </div>
      </FormField>
      {alreadyCreated && (steps.some((s) => s.status === 'error')) && (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 8 }}>{t('wizard.confirm.alreadyCreatedNotice')}</div>
      )}
      {(running || steps.length > 0) && <InstallSteps steps={steps} />}
    </>
  );
}
