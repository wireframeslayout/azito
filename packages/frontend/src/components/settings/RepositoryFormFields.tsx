import { useTranslation } from 'react-i18next';
import FormField from '../FormField';
import RepositoryCandidateInput from '../RepositoryCandidateInput';
import { Badge, FormInput, FormSelect } from '../ui';
import {
  applyRepositoryCandidate, applyRepositoryUrlChange, detectRepositoryProvider,
  type RepositoryFormProvider, type RepositoryFormValues,
} from '../../lib/repositoryForm';

export interface RepositoryFormFieldsProps {
  values: RepositoryFormValues;
  onChange: (next: RepositoryFormValues) => void;
  /** URL 欄のバリデーションエラー（未入力）。 */
  urlError?: string;
  /** プロバイダ欄のバリデーションエラー（自動判定できず未選択）。 */
  providerError?: string;
  /** 入力を止める（送信中）。 */
  disabled?: boolean;
}

/**
 * リポジトリ登録フォームの入力欄一式。プロジェクト設定「リポジトリ」と
 * ワークスペースのリポジトリサイドバーが同じモーダル
 * （RepositoryModals.tsx の AddRepositoryModal）越しに共有する。
 *
 * 先行例は settings/EnvironmentFormFields.tsx（入力欄はここ、モーダルの外枠と
 * 送信はモーダル側）。プロバイダは手動選択をやめ、URL からの自動判定を
 * Badge で表示するだけにしている。
 */
export default function RepositoryFormFields({ values, onChange, urlError, providerError, disabled }: RepositoryFormFieldsProps) {
  const { t } = useTranslation(['git', 'common']);
  const url = values.url.trim();
  // 自動判定できた URL ではプロバイダを訊かない。判定できない URL
  // （GitHub Enterprise Server や、ホスト名に 'gitlab' を含まない自己ホスト
  // GitLab など）だけ手動選択欄を出す。
  const detected = url ? detectRepositoryProvider(url) : null;
  const detectedTone = detected === 'github' ? 'accent' : 'orange';

  return (
    <>
      <FormField label={t('repo.repositoryUrl')} required error={urlError}>
        <RepositoryCandidateInput
          value={values.url}
          onChange={(url) => onChange(applyRepositoryUrlChange(values, url))}
          onSelectCandidate={(candidate) => onChange(applyRepositoryCandidate(values, candidate))}
          placeholder={t('repo.repositoryUrlPlaceholder')}
          ariaLabel={t('repo.repositoryUrl')}
        />
        {detected && (
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Badge tone={detectedTone}>{t(`repo.${detected}`)}</Badge>
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{t('repo.providerDetected')}</span>
          </div>
        )}
      </FormField>

      {url && !detected && (
        <FormField label={t('repo.provider')} hint={t('repo.providerSelfHostedHint')} required error={providerError}>
          <FormSelect
            value={values.provider}
            onChange={(e) => onChange({ ...values, provider: e.target.value as RepositoryFormProvider | '' })}
            disabled={disabled}
          >
            <option value="">{t('repo.providerPlaceholder')}</option>
            <option value="github">{t('repo.github')}</option>
            <option value="gitlab">{t('repo.gitlab')}</option>
            <option value="other">{t('repo.other')}</option>
          </FormSelect>
        </FormField>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <FormField label={t('repo.owner')}>
            <FormInput
              value={values.owner}
              onChange={(e) => onChange({ ...values, owner: e.target.value })}
              placeholder={t('repo.ownerPlaceholder')}
              disabled={disabled}
            />
          </FormField>
        </div>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <FormField label={t('repo.repoName')}>
            <FormInput
              value={values.repoName}
              onChange={(e) => onChange({ ...values, repoName: e.target.value })}
              placeholder={t('repo.repoNamePlaceholder')}
              disabled={disabled}
            />
          </FormField>
        </div>
      </div>

      <FormField label={t('repo.displayName')}>
        <FormInput
          value={values.displayName}
          onChange={(e) => onChange({ ...values, displayName: e.target.value })}
          placeholder={t('repo.displayNamePlaceholder')}
          disabled={disabled}
        />
      </FormField>

      <FormField label={t('repo.token')} hint={t('repo.tokenHint')}>
        <FormInput
          value={values.token}
          onChange={(e) => onChange({ ...values, token: e.target.value })}
          placeholder={t('repo.tokenPlaceholder')}
          type="password"
          autoComplete="off"
          disabled={disabled}
        />
      </FormField>
    </>
  );
}
