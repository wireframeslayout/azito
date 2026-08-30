import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Chip, FormInput, InstallSteps, Spinner, baseInputStyle, type InstallStep } from './ui';
import FormField from './FormField';
import DirectoryInput from './DirectoryInput';
import RepositoryCandidateInput from './RepositoryCandidateInput';
import type { RepositoryCandidate } from './repositoryCandidateInputLogic';
import { stepIndex, isAbsoluteWizardPath, type WizardStepId, type CodeMode, type ReusableRepoCandidate } from '../lib/projectWizardLogic';

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

const NUMERIC_FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace";

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
      <div style={{ padding: '8px var(--space-4)', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)' }}>
        <span style={{ fontFamily: NUMERIC_FONT }}>{t('wizard.stepOf', { current: idx + 1, total: visibleSteps.length })}</span>
        {' · '}
        {t(`wizard.steps.${currentStep}`)}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', padding: '10px var(--space-4)', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', overflowX: 'auto' }}>
      {visibleSteps.map((step, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
        return (
          <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22,
              borderRadius: 'var(--radius-full)', fontSize: 'var(--font-2xs)', fontWeight: 600,
              background: state === 'done' ? 'var(--success-a08)' : state === 'current' ? 'var(--accent)' : 'var(--input-bg)',
              color: state === 'done' ? 'var(--success)' : state === 'current' ? 'var(--surface-base)' : 'var(--text-dim)',
              boxShadow: state === 'done' ? 'inset 0 0 0 1px var(--success-a35)' : 'none',
            }}>
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span style={{ fontSize: 'var(--font-sm)', color: state === 'current' ? 'var(--text)' : 'var(--text-dim)', fontWeight: state === 'current' ? 600 : 400, whiteSpace: 'nowrap' }}>
              {t(`wizard.steps.${step}`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const hiddenRadioStyle: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
};

/**
 * Radio-button "option card" — the mockup's `.opt` pattern. A native
 * `<input type="radio">` is kept in the DOM (visually hidden via the
 * standard clip-rect technique, not `display:none`) so the option remains
 * keyboard-focusable/operable and participates in the browser's native
 * radio-group arrow-key navigation; the label wraps the whole card so a
 * click anywhere on it toggles the input. The selected-state ring (inline
 * `box-shadow`) and the keyboard-focus indicator (`.wizard-option-card`
 * CSS `outline`, see global.css) use different box-model layers so they
 * never fight over specificity, and the outline only appears for
 * `:focus-visible` (keyboard), not on mouse click.
 */
function OptionCard({ id, name, checked, onChange, disabled, title, description }: {
  id: string; name: string; checked: boolean; onChange: () => void; disabled?: boolean;
  title: ReactNode; description?: ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className="wizard-option-card"
      style={{
        display: 'grid', gridTemplateColumns: '18px 1fr', gap: 'var(--space-3)', alignItems: 'start',
        padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', marginBottom: 8,
        background: checked ? 'var(--selected-bg)' : 'var(--bg-card)',
        boxShadow: checked ? 'inset 0 0 0 1px var(--accent-a35)' : 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input
        type="radio"
        id={id}
        name={name}
        checked={checked}
        onChange={disabled ? undefined : onChange}
        disabled={disabled}
        style={hiddenRadioStyle}
      />
      <span aria-hidden="true" style={{
        display: 'block', width: 16, height: 16, borderRadius: 'var(--radius-full)', marginTop: 2, flexShrink: 0,
        boxShadow: checked ? 'inset 0 0 0 5px var(--accent)' : 'inset 0 0 0 1px var(--text-dim)',
      }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--font-base)', color: 'var(--text)' }}>
          {title}
        </div>
        {description && (
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', lineHeight: 1.55, marginTop: 2 }}>{description}</div>
        )}
      </div>
    </label>
  );
}

/** The mockup's isolation chip: a purple pill with a leading solid dot (never a left border) marking a server with no stored credentials. */
function IsolationChip({ t }: { t: TFunc }) {
  return (
    <Chip tone="purple" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 'var(--radius-full)', background: 'currentColor', flexShrink: 0 }} />
      {t('wizard.environment.isolatedBadge')}
    </Chip>
  );
}

function serverTypeDescription(t: TFunc, type: string): string {
  if (type === 'local') return t('wizard.environment.serverTypeLocal');
  if (type === 'ssh') return t('wizard.environment.serverTypeSsh');
  if (type === 'agent') return t('wizard.environment.serverTypeAgent');
  return type;
}

export function EnvironmentStep({ t, serverList, selectedServer, setSelectedServer, existingServerNames, showValidation, noServersAvailable }: {
  t: TFunc; serverList: ServerListItem[]; selectedServer: string; setSelectedServer: (v: string) => void;
  existingServerNames?: string[]; showValidation: boolean; noServersAvailable?: boolean;
}) {
  // No server left to add (every one is already configured for this
  // project) — the operator cannot complete this step at all, so say so
  // instead of showing a select with nothing valid in it (Issue #87
  // review, Important finding 2).
  if (noServersAvailable) {
    return (
      <>
        <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginTop: 0 }}>{t('wizard.environment.description')}</p>
        <div role="alert" style={{
          padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--danger-a15)',
          border: '1px solid var(--danger-a35)', color: 'var(--danger)', fontSize: 'var(--font-md)',
        }}>
          {t('wizard.environment.noServersAvailable')}
        </div>
      </>
    );
  }
  return (
    <>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginTop: 0 }}>{t('wizard.environment.description')}</p>
      <FormField label={t('wizard.environment.serverLabel')} error={showValidation ? t('wizard.environment.serverRequired') : undefined}>
        <div role="radiogroup" aria-label={t('wizard.environment.serverLabel')}>
          {serverList.map((sv) => {
            const already = existingServerNames?.includes(sv.name);
            const description = [
              serverTypeDescription(t, sv.type),
              sv.isolationIntent ? t('wizard.environment.isolatedHint') : '',
            ].filter(Boolean).join(' ');
            return (
              <OptionCard
                key={sv.name}
                id={`wizard-env-server-${sv.name}`}
                name="wizard-env-server"
                checked={selectedServer === sv.name}
                onChange={() => setSelectedServer(sv.name)}
                disabled={already}
                title={(
                  <>
                    <span>{sv.name}</span>
                    {sv.isolationIntent && <IsolationChip t={t} />}
                    {already && <Badge tone="neutral">{t('wizard.environment.alreadyAdded')}</Badge>}
                  </>
                )}
                description={description}
              />
            );
          })}
        </div>
      </FormField>
    </>
  );
}

export function CodeStep({
  t, codeMode, setCodeMode, selectedServer, selectedServerType, existingPath, onExistingPathChange, discovery,
  selectedRemoteUrls, toggleRemoteSelected, cloneUrl, setCloneUrl, onSelectRepoCandidate, cloneDirectory, setCloneDirectory, cloneBranch, setCloneBranch,
  cloneToken, setCloneToken, reusableRepo,
  showValidation,
}: {
  t: TFunc; codeMode: CodeMode; setCodeMode: (m: CodeMode) => void; selectedServer: string; selectedServerType?: string;
  existingPath: string; onExistingPathChange: (v: string) => void; discovery: DiscoveryStatus;
  selectedRemoteUrls: Set<string>; toggleRemoteSelected: (url: string) => void;
  cloneUrl: string; setCloneUrl: (v: string) => void; onSelectRepoCandidate: (candidate: RepositoryCandidate) => void;
  cloneDirectory: string; setCloneDirectory: (v: string) => void;
  cloneBranch: string; setCloneBranch: (v: string) => void;
  cloneToken: string; setCloneToken: (v: string) => void; reusableRepo: ReusableRepoCandidate | null;
  showValidation: boolean;
}) {
  // 'local' clones directly (right here, on the hub's own filesystem);
  // every other server type instead gets the repository via the existing
  // hub-代行配信 path, which only runs once a task actually executes there
  // (Issue #87 review, Important finding 4 — the UI must say which one
  // actually happens, not a generic "provisioned later" note for both).
  const clonesNow = selectedServerType === 'local';
  const parsedClone = cloneUrl.trim() ? parseCloneUrlForRegistration(cloneUrl.trim()) : null;
  // Non-local delivery goes through the hub's 代行配信 path, which refuses a
  // repository with no credential outright — a token is required unless an
  // already-registered repository for this URL already carries one (Issue
  // #87 review, Important finding 3).
  const needsToken = !clonesNow && reusableRepo === null;
  const codeModeOptions: { value: CodeMode; label: string; description: string }[] = [
    { value: 'existing', label: t('wizard.code.modeExisting'), description: t('wizard.code.modeExistingDescription') },
    { value: 'clone', label: t('wizard.code.modeClone'), description: t('wizard.code.modeCloneDescription') },
    { value: 'later', label: t('wizard.code.modeLater'), description: t('wizard.code.modeLaterDescription') },
  ];
  return (
    <>
      <FormField label="">
        <div role="radiogroup" aria-label={t('wizard.steps.code')}>
          {codeModeOptions.map((opt) => (
            <OptionCard
              key={opt.value}
              id={`wizard-code-mode-${opt.value}`}
              name="wizard-code-mode"
              checked={codeMode === opt.value}
              onChange={() => setCodeMode(opt.value)}
              title={<span>{opt.label}</span>}
              description={opt.description}
            />
          ))}
        </div>
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
            <RepositoryCandidateInput
              value={cloneUrl}
              onChange={setCloneUrl}
              onSelectCandidate={onSelectRepoCandidate}
              placeholder={t('wizard.code.cloneUrlPlaceholder')}
              ariaLabel={t('wizard.code.cloneUrlLabel')}
            />
            {parsedClone && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Badge tone={parsedClone.provider === 'github' ? 'accent' : parsedClone.provider === 'gitlab' ? 'orange' : 'neutral'}>{parsedClone.provider}</Badge>
                {parsedClone.owner && parsedClone.repoName && (
                  <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{parsedClone.owner}/{parsedClone.repoName}</span>
                )}
              </div>
            )}
          </FormField>
          <FormField
            label={t('wizard.code.cloneDirectoryLabel')}
            error={showValidation && cloneDirectory.trim() && !isAbsoluteWizardPath(cloneDirectory)
              ? t('wizard.code.cloneDirectoryMustBeAbsolute')
              : showValidation && !cloneDirectory.trim() ? t('wizard.code.cloneDirectoryRequired') : undefined}
          >
            <DirectoryInput value={cloneDirectory} onChange={setCloneDirectory} serverName={selectedServer} placeholder={t('wizard.code.cloneDirectoryPlaceholder')} style={baseInputStyle} />
          </FormField>
          <FormField label={t('wizard.code.cloneBranchLabel')}>
            <FormInput value={cloneBranch} onChange={(e) => setCloneBranch(e.target.value)} placeholder="main" />
          </FormField>
          <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
            {clonesNow ? t('wizard.code.cloneNoteLocal') : t('wizard.code.cloneNote')}
          </p>
          {!clonesNow && reusableRepo && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--accent-a08)' }}>
              <Badge tone="accent">{t('wizard.code.repoReusedBadge')}</Badge>
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('wizard.code.repoReusedHint')}</span>
            </div>
          )}
          {!clonesNow && !reusableRepo && (
            <FormField
              label={t('wizard.code.cloneTokenLabel')}
              hint={t('wizard.code.cloneTokenHint')}
              error={showValidation && needsToken && !cloneToken.trim() ? t('wizard.code.cloneTokenRequired') : undefined}
            >
              <FormInput type="password" autoComplete="off" value={cloneToken} onChange={(e) => setCloneToken(e.target.value)} placeholder={t('wizard.code.cloneTokenPlaceholder')} />
            </FormField>
          )}
        </>
      )}

      {codeMode === 'later' && (
        <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>{t('wizard.code.laterNote')}</p>
      )}
    </>
  );
}

function ProbeStatus({ chip, title, sub }: { chip: ReactNode; title: ReactNode; sub?: ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)', marginTop: 6,
      padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', fontSize: 'var(--font-sm)',
    }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>{chip}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, color: 'var(--text)' }}>{title}</div>
        {sub && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function DiscoveryResult({ t, discovery, selectedRemoteUrls, toggleRemoteSelected }: {
  t: TFunc; discovery: DiscoveryStatus; selectedRemoteUrls: Set<string>; toggleRemoteSelected: (url: string) => void;
}) {
  if (discovery === 'idle') return null;
  if (discovery === 'checking') {
    return <ProbeStatus chip={<Spinner size={13} trackColor="var(--accent-a35)" />} title={t('wizard.code.checking')} />;
  }
  if (discovery === 'error') {
    return <ProbeStatus chip={<Chip tone="red">!</Chip>} title={t('wizard.code.pathCheckFailed')} />;
  }
  if (!discovery.exists) {
    return <ProbeStatus chip={<Chip tone="accent">+</Chip>} title={t('wizard.code.pathWillBeCreated')} />;
  }
  const remotes = discovery.repos.flatMap((r) => r.remotes.map((remote) => ({ repo: r, remote })));
  if (remotes.length === 0) {
    return (
      <ProbeStatus
        chip={<Chip tone="default">–</Chip>}
        title={[discovery.isGitRepository ? t('wizard.code.pathIsGitRepo') : '', t('wizard.code.pathNoRepo')].filter(Boolean).join(' ')}
      />
    );
  }
  const multi = discovery.repos.length > 1;
  return (
    <>
      <ProbeStatus
        chip={<Chip tone={multi ? 'accent' : 'green'}>{discovery.repos.length}</Chip>}
        title={discovery.repos.length === 1 && discovery.repos[0].relativePath === '.'
          ? t('wizard.code.pathIsGitRepo')
          : t('wizard.code.pathMultipleRepos', { count: discovery.repos.length })}
        sub={t('wizard.code.selectRepos')}
      />
      <div style={{
        marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto',
        padding: 4, borderRadius: 'var(--radius-md)', background: 'var(--bg-card)',
      }}>
        {remotes.map(({ repo, remote }) => (
          <label
            key={`${repo.absolutePath}:${remote.name}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 'var(--font-sm)', cursor: 'pointer',
              borderRadius: 'var(--radius-sm)', background: 'var(--bg)',
            }}
          >
            <input type="checkbox" checked={selectedRemoteUrls.has(remote.url)} onChange={() => toggleRemoteSelected(remote.url)} style={{ margin: 0 }} />
            <Badge tone={remote.provider === 'github' ? 'accent' : remote.provider === 'gitlab' ? 'orange' : 'neutral'} style={{ fontSize: 'var(--font-2xs)' }}>{remote.provider}</Badge>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {repo.relativePath === '.' ? (remote.owner && remote.repoName ? `${remote.owner}/${remote.repoName}` : remote.url) : `${repo.relativePath} · ${remote.owner && remote.repoName ? `${remote.owner}/${remote.repoName}` : remote.url}`}
            </span>
          </label>
        ))}
      </div>
    </>
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
      {mode === 'create' && <SummaryRow label={t('wizard.confirm.projectLabel')} value={name} />}
      {showEnvironmentStep && <SummaryRow label={t('wizard.confirm.environmentLabel')} value={selectedServer} />}
      <SummaryRow
        label={t('wizard.confirm.codeLabel')}
        value={
          codeMode === 'existing' ? t('wizard.confirm.codeExisting', { path: existingPath })
            : codeMode === 'clone' ? t('wizard.confirm.codeClone', { url: cloneUrl, dir: cloneDirectory })
              : t('wizard.confirm.codeLater')
        }
      />
      {alreadyCreated && (steps.some((s) => s.status === 'error')) && (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 8 }}>{t('wizard.confirm.alreadyCreatedNotice')}</div>
      )}
      {(running || steps.length > 0) && <InstallSteps steps={steps} />}
    </>
  );
}

/** The mockup's `.sum-r` confirm-step summary row: a fixed label column next to a wrapping value column, collapsing to one column under ~30rem. */
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      className="wizard-sum-row"
      style={{ display: 'grid', gridTemplateColumns: '6rem 1fr', gap: 'var(--space-3)', alignItems: 'start', marginBottom: 10 }}
    >
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-md)', wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}
