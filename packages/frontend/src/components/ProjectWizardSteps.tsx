import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Chip, FormInput, FormSelect, InstallSteps, Notice, Spinner, baseInputStyle, type InstallStep } from './ui';
import FormField from './FormField';
import DirectoryInput from './DirectoryInput';
import RepositoryCandidateInput from './RepositoryCandidateInput';
import type { RepositoryCandidate } from './repositoryCandidateInputLogic';
import {
  stepIndex, isAbsoluteWizardPath, codeModeOptionsForVariant, effectiveCodeMode,
  type WizardStepId, type CodeMode, type ReusableRepoCandidate, type CodeStepVariant,
  type EnvironmentInputPolicy, type DistributionSummary,
} from '../lib/projectWizardLogic';
import { resolveRepositoryRegistration } from '../lib/repositoryForm';

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
  t, codeMode, setCodeMode, selectedServer, variant, existingPath, onExistingPathChange, discovery,
  selectedRemoteUrls, toggleRemoteSelected, cloneUrl, setCloneUrl, onSelectRepoCandidate, cloneDirectory, setCloneDirectory, cloneBranch, setCloneBranch,
  cloneToken, setCloneToken, reusableRepo,
  showValidation,
}: {
  t: TFunc; codeMode: CodeMode; setCodeMode: (m: CodeMode) => void; selectedServer: string; variant: CodeStepVariant;
  existingPath: string; onExistingPathChange: (v: string) => void; discovery: DiscoveryStatus;
  selectedRemoteUrls: Set<string>; toggleRemoteSelected: (url: string) => void;
  cloneUrl: string; setCloneUrl: (v: string) => void; onSelectRepoCandidate: (candidate: RepositoryCandidate) => void;
  cloneDirectory: string; setCloneDirectory: (v: string) => void;
  cloneBranch: string; setCloneBranch: (v: string) => void;
  cloneToken: string; setCloneToken: (v: string) => void; reusableRepo: ReusableRepoCandidate | null;
  showValidation: boolean;
}) {
  // `local` IS the hub: it clones right here, right now, on the hub's own
  // filesystem. Every other server type gets its code through the hub's
  // 代行配信 path instead, which only runs once a task actually executes
  // there — and for an isolated server that path is not optional at all
  // (`DistributionHelper`), so the step drops the choice entirely and asks
  // only for what delivery needs.
  const clonesNow = variant === 'local';
  const isolated = variant === 'isolated';
  const mode = effectiveCodeMode(variant, codeMode);
  const modeOptions = codeModeOptionsForVariant(variant);
  const parsedClone = cloneUrl.trim() ? resolveRepositoryRegistration(cloneUrl.trim()) : null;
  // Delivery through the hub refuses a repository with no credential
  // outright — a token is required unless an already-registered repository
  // for this URL already carries one (Issue #87 review, Important finding 3).
  const needsToken = !clonesNow && reusableRepo === null;
  const optionText: Record<CodeMode, { label: string; description: string }> = {
    existing: { label: t('wizard.code.modeExisting'), description: t('wizard.code.modeExistingDescription') },
    // Only `local` performs a real clone; for any other server the same
    // option actually means "配信する", and saying "クローン" there is what
    // let the confirm screen stay silent about distribution.
    clone: clonesNow
      ? { label: t('wizard.code.modeClone'), description: t('wizard.code.modeCloneDescription') }
      : { label: t('wizard.code.modeDistribute'), description: t('wizard.code.modeDistributeDescription') },
    later: { label: t('wizard.code.modeLater'), description: t('wizard.code.modeLaterDescription') },
  };
  return (
    <>
      {isolated && (
        <Notice
          tone="info"
          sub={(
            <>
              <div>{t('wizard.code.isolatedNoCredentials')}</div>
              <div>{t('wizard.code.isolatedOriginReplaced')}</div>
            </>
          )}
          style={{ marginBottom: 14 }}
        >
          <strong style={{ fontWeight: 600 }}>{t('wizard.code.isolatedTitle')}</strong>
          <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>{t('wizard.code.isolatedBundle')}</div>
        </Notice>
      )}

      {modeOptions.length > 0 && (
        <FormField label="">
          <div role="radiogroup" aria-label={t('wizard.steps.code')}>
            {modeOptions.map((value) => (
              <OptionCard
                key={value}
                id={`wizard-code-mode-${value}`}
                name="wizard-code-mode"
                checked={mode === value}
                onChange={() => setCodeMode(value)}
                title={<span>{optionText[value].label}</span>}
                description={optionText[value].description}
              />
            ))}
          </div>
        </FormField>
      )}

      {mode === 'existing' && (
        <FormField label={t('wizard.code.pathLabel')} error={showValidation ? t('wizard.code.pathRequired') : undefined}>
          <DirectoryInput value={existingPath} onChange={onExistingPathChange} serverName={selectedServer} placeholder={t('wizard.code.pathPlaceholder')} style={baseInputStyle} />
          <DiscoveryResult t={t} discovery={discovery} selectedRemoteUrls={selectedRemoteUrls} toggleRemoteSelected={toggleRemoteSelected} />
        </FormField>
      )}

      {mode === 'clone' && (
        <>
          <FormField
            label={clonesNow ? t('wizard.code.cloneUrlLabel') : t('wizard.code.distributionRepoLabel')}
            error={showValidation && !cloneUrl.trim()
              ? (clonesNow ? t('wizard.code.cloneUrlRequired') : t('wizard.code.distributionRepoRequired'))
              : undefined}
          >
            <RepositoryCandidateInput
              value={cloneUrl}
              onChange={setCloneUrl}
              onSelectCandidate={onSelectRepoCandidate}
              placeholder={t('wizard.code.cloneUrlPlaceholder')}
              ariaLabel={clonesNow ? t('wizard.code.cloneUrlLabel') : t('wizard.code.distributionRepoLabel')}
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
          {!clonesNow && reusableRepo && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--accent-a08)', marginBottom: 14 }}>
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
          <FormField
            label={clonesNow ? t('wizard.code.cloneDirectoryLabel') : t('wizard.code.distributionDirectoryLabel')}
            hint={clonesNow ? undefined : t('wizard.code.distributionDirectoryHint')}
            error={showValidation && cloneDirectory.trim() && !isAbsoluteWizardPath(cloneDirectory)
              ? t('wizard.code.cloneDirectoryMustBeAbsolute')
              : showValidation && !cloneDirectory.trim() ? t('wizard.code.cloneDirectoryRequired') : undefined}
          >
            <DirectoryInput value={cloneDirectory} onChange={setCloneDirectory} serverName={selectedServer} placeholder={t('wizard.code.cloneDirectoryPlaceholder')} style={baseInputStyle} />
          </FormField>
          <FormField label={t('wizard.code.cloneBranchLabel')}>
            <FormInput value={cloneBranch} onChange={(e) => setCloneBranch(e.target.value)} placeholder="main" />
          </FormField>
          {!isolated && (
            <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
              {clonesNow ? t('wizard.code.cloneNoteLocal') : t('wizard.code.cloneNote')}
            </p>
          )}
        </>
      )}

      {mode === 'later' && (
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
  t, mode, name, selectedServer, showEnvironmentStep, codeMode, existingPath, cloneUrl, cloneDirectory,
  distribution, tmuxSession, setTmuxSession, inputPolicy, setInputPolicy, allowPolicyAvailable,
  steps, running, alreadyCreated,
}: {
  t: TFunc; mode: 'create' | 'addEnvironment'; name: string; selectedServer: string; showEnvironmentStep: boolean;
  codeMode: CodeMode; existingPath: string; cloneUrl: string; cloneDirectory: string;
  distribution: DistributionSummary;
  tmuxSession: string; setTmuxSession: (v: string) => void;
  inputPolicy: EnvironmentInputPolicy; setInputPolicy: (v: EnvironmentInputPolicy) => void;
  /** `allow` is only accepted for an isolated server (PUT rejects it otherwise) — mirrors ProjectSettings's own gate. */
  allowPolicyAvailable: boolean;
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
            : codeMode === 'clone'
              ? (distribution.distributed
                ? t('wizard.confirm.codeDistribute', { url: cloneUrl, dir: cloneDirectory })
                : t('wizard.confirm.codeClone', { url: cloneUrl, dir: cloneDirectory }))
              : t('wizard.confirm.codeLater')
        }
      />
      {/* Distribution used to be switched on as a silent side effect of
          picking "クローン" on a non-local server and never appeared here —
          state it outright, naming the 配信元 repository. */}
      <SummaryRow
        label={t('wizard.confirm.distributionLabel')}
        value={distribution.distributed
          ? (distribution.repositoryName
            ? t('wizard.confirm.distributionOn', { repo: distribution.repositoryName })
            : t('wizard.confirm.distributionOnNoRepo'))
          : t('wizard.confirm.distributionOff')}
      />

      <details style={{ marginTop: 4, marginBottom: 14 }}>
        <summary style={{ cursor: 'pointer', userSelect: 'none', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', padding: '6px 0' }}>
          {t('wizard.confirm.advancedToggle')}
        </summary>
        <div style={{ marginTop: 10, padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', boxShadow: 'inset 0 1px 0 var(--edge-hi)' }}>
          <FormField label={t('wizard.confirm.tmuxSessionLabel')} hint={t('wizard.confirm.tmuxSessionHint')}>
            <FormInput value={tmuxSession} onChange={(e) => setTmuxSession(e.target.value)} placeholder={t('wizard.confirm.tmuxSessionPlaceholder')} />
          </FormField>
          <FormField
            label={t('wizard.confirm.inputPolicyLabel')}
            hint={allowPolicyAvailable ? t('wizard.confirm.inputPolicyHint') : t('wizard.confirm.inputPolicyAllowIsolatedOnly')}
          >
            <FormSelect
              value={inputPolicy}
              onChange={(e) => {
                const v = e.target.value;
                setInputPolicy(v === 'deny' || v === 'allow' ? v : 'manual-approval');
              }}
            >
              <option value="manual-approval">{t('wizard.confirm.inputPolicyManualApproval')}</option>
              <option value="deny">{t('wizard.confirm.inputPolicyDeny')}</option>
              {/* Client-side hint only; the real enforcement is server-side
                  (PUT rejects 'allow' for a non-isolated server with 400). */}
              <option value="allow" disabled={!allowPolicyAvailable}>{t('wizard.confirm.inputPolicyAllow')}</option>
            </FormSelect>
          </FormField>
        </div>
      </details>

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
