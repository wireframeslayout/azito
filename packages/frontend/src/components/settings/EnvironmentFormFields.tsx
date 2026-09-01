import { useTranslation } from 'react-i18next';
import FormField from '../FormField';
import DirectoryInput from '../DirectoryInput';
import { FormInput, FormSelect, baseInputStyle } from '../ui';
import { DocsLink } from '../ui/DocsLink';
import { isDistributeCodeLocked } from '../../lib/distributeCodePolicy';
import type { Server } from '../../pages/workspace/types';

/** 配信対象リポジトリ select が必要とする Repository の部分集合。 */
export interface EnvironmentRepositoryOption {
  id: number;
  url: string;
  name?: string;
}

export interface EnvironmentFormFieldsProps {
  servers: Server[];
  repositories: EnvironmentRepositoryOption[];
  serverName: string;
  onServerNameChange: (value: string) => void;
  workingDirectory: string;
  onWorkingDirectoryChange: (value: string) => void;
  distributeCode: boolean;
  onDistributeCodeChange: (value: boolean) => void;
  distributionRepositoryId: string;
  onDistributionRepositoryIdChange: (value: string) => void;
  branch: string;
  onBranchChange: (value: string) => void;
  tmuxSession: string;
  onTmuxSessionChange: (value: string) => void;
  inputPolicy: 'deny' | 'manual-approval' | 'allow';
  onInputPolicyChange: (value: 'deny' | 'manual-approval' | 'allow') => void;
  /** 配信が実効なのに対象リポジトリが未選択（または選択済みのものが削除済み）。 */
  distributionRepositoryMissing: boolean;
}

/**
 * プロジェクト設定「サーバー環境」の入力欄一式。編集モーダル
 * （EnvironmentModals.tsx の EditEnvironmentModal）から使う。ProjectSettings.tsx
 * のインラインフォームに散らばっていた項目をここ1箇所に集約している。
 */
export default function EnvironmentFormFields({
  servers, repositories,
  serverName, onServerNameChange,
  workingDirectory, onWorkingDirectoryChange,
  distributeCode, onDistributeCodeChange,
  distributionRepositoryId, onDistributionRepositoryIdChange,
  branch, onBranchChange,
  tmuxSession, onTmuxSessionChange,
  inputPolicy, onInputPolicyChange,
  distributionRepositoryMissing,
}: EnvironmentFormFieldsProps) {
  const { t } = useTranslation(['projects', 'common']);
  const targetServer = servers.find((sv) => sv.name === serverName);
  // Issue #87 third-party review, seventh pass, Minor finding 3: an isolated
  // server holds no git credentials of its own, so the backend ALWAYS
  // distributes code to it via `isolationIntent` regardless of this saved
  // flag — toggling it off here would silently do nothing. Lock the toggle
  // on (disabled, checked) and explain why via the hint. Issue #87 review,
  // eighth pass, Important finding 1: `checked` is DERIVED here rather than
  // by forcing the underlying state to `true`, so Save (which omits the
  // field for a locked server) never persists a phantom opt-in that
  // outlives isolation being turned back off.
  const isolated = isDistributeCodeLocked(targetServer);
  const distributeEffective = isolated || distributeCode;

  return (
    <>
      <FormField label={t('settings.servers.server')}>
        <FormSelect value={serverName} onChange={(e) => onServerNameChange(e.target.value)}>
          {servers.map((sv) => <option key={sv.name} value={sv.name}>{sv.name}</option>)}
        </FormSelect>
      </FormField>
      <FormField label={t('settings.servers.workingDirectory')}>
        <DirectoryInput
          value={workingDirectory}
          onChange={onWorkingDirectoryChange}
          serverName={serverName}
          placeholder={t('settings.servers.workingDirectoryPlaceholder')}
          style={baseInputStyle}
        />
      </FormField>
      {/* Issue #87 Phase 2: meaningless for `local` (that server IS the hub,
          so "distributing" to it has no effect) — hidden rather than
          disabled, since the reason is structural, not a transient state a
          user could resolve from this form. */}
      {targetServer?.type !== 'local' && (
        <>
          <FormField
            label={t('settings.servers.distributeCodeLabel')}
            hint={isolated ? t('settings.servers.distributeCodeIsolatedHint') : t('settings.servers.distributeCodeHint')}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: isolated ? 'default' : 'pointer' }}>
              {/* CSS-only wrapper for the `.toggle`/`.toggle-slider` sibling
                  selector — deliberately a <span>, not a nested <label>. */}
              <span className="toggle">
                <input
                  type="checkbox"
                  checked={distributeEffective}
                  disabled={isolated}
                  onChange={(e) => onDistributeCodeChange(e.target.checked)}
                />
                <span className="toggle-slider" />
              </span>
              <span style={{ fontSize: 'var(--font-md)', color: 'var(--text)' }}>{t('settings.servers.distributeCode')}</span>
            </label>
          </FormField>
          {/* Shown only while distribution is effectively on for this server —
              hidden (not merely disabled) when off, matching the toggle
              itself being hidden entirely for `local`. Fail Fast: no implicit
              fallback even when the project has exactly one repository. */}
          {distributeEffective && (
            <FormField
              label={t('settings.servers.distributionRepository')}
              hint={`${t('settings.servers.distributionRepositoryHint')} ${t('settings.servers.distributionRepositoryOriginHint')}`}
              error={distributionRepositoryMissing ? t('settings.servers.distributionRepositoryRequired') : undefined}
            >
              <FormSelect
                value={distributionRepositoryId}
                onChange={(e) => onDistributionRepositoryIdChange(e.target.value)}
              >
                <option value="">{t('settings.servers.distributionRepositoryPlaceholder')}</option>
                {repositories.map((r) => (
                  <option key={r.id} value={String(r.id)}>{r.name || r.url}</option>
                ))}
              </FormSelect>
            </FormField>
          )}
        </>
      )}
      <FormField label={t('settings.servers.branch')}>
        <FormInput value={branch} onChange={(e) => onBranchChange(e.target.value)} placeholder={t('settings.servers.branchPlaceholder')} />
      </FormField>
      <FormField label={t('settings.servers.tmuxSession')} hint={t('settings.servers.tmuxSessionHint')}>
        <FormInput value={tmuxSession} onChange={(e) => onTmuxSessionChange(e.target.value)} placeholder={t('settings.servers.tmuxSessionPlaceholder')} />
      </FormField>
      <FormField label={t('settings.servers.inputPolicy')} hint={t('settings.servers.inputPolicyHint')}>
        <FormSelect
          value={inputPolicy}
          onChange={(e) => {
            const v = e.target.value;
            onInputPolicyChange(v === 'deny' || v === 'allow' ? v : 'manual-approval');
          }}
        >
          <option value="manual-approval">{t('settings.servers.inputPolicyManualApproval')}</option>
          <option value="deny">{t('settings.servers.inputPolicyDeny')}</option>
          {/* Issue #29 Step 3a: client-side hint only — selectable ONLY for a
              row whose target server has declared isolation intent. The real
              enforcement is server-side: PUT rejects 'allow' for a
              non-isolated server (400), and the run-time gate additionally
              requires a current doctor verification + scoped auth before
              'allow' is ever actually effective. */}
          <option value="allow" disabled={!targetServer?.isolationIntent}>
            {t('settings.servers.inputPolicyAllow')}
          </option>
        </FormSelect>
      </FormField>
      {inputPolicy === 'allow' && (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: -8, marginBottom: 12 }}>
          {t('settings.servers.inputPolicyAllowHint')} <DocsLink page="isolated-execution" />
        </div>
      )}
    </>
  );
}
