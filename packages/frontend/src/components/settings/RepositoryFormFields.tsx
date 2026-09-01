import { useTranslation } from 'react-i18next';
import FormField from '../FormField';
import RepositoryCandidateInput from '../RepositoryCandidateInput';
import { Badge, FormInput } from '../ui';
import {
  applyRepositoryCandidate, applyRepositoryUrlChange, resolveRepositoryProvider,
  type RepositoryFormValues,
} from '../../lib/repositoryForm';

export interface RepositoryFormFieldsProps {
  values: RepositoryFormValues;
  onChange: (next: RepositoryFormValues) => void;
  /** URL 欄のバリデーションエラー（未入力）。 */
  urlError?: string;
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
export default function RepositoryFormFields({ values, onChange, urlError, disabled }: RepositoryFormFieldsProps) {
  const { t } = useTranslation(['git', 'common']);
  const provider = values.url.trim() ? resolveRepositoryProvider(values.url.trim()) : null;
  const providerTone = provider === 'github' ? 'accent' : provider === 'gitlab' ? 'orange' : 'neutral';

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
        {provider && (
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Badge tone={providerTone}>{t(`repo.${provider}`)}</Badge>
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{t('repo.providerDetected')}</span>
          </div>
        )}
      </FormField>

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
