import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import Modal from '../Modal';
import { Button } from '../ui';
import { useToast } from '../../hooks/useToast';
import RepositoryFormFields from './RepositoryFormFields';
import { buildRepositoryCreatePayload, EMPTY_REPOSITORY_FORM, type RepositoryFormValues } from '../../lib/repositoryForm';

interface AddRepositoryModalProps {
  open: boolean;
  projectId: number;
  /** 登録が完了したとき。呼び出し側が一覧を再取得する。モーダルはここで自分を閉じる。 */
  onAdded: () => void;
  onClose: () => void;
}

/**
 * リポジトリ登録モーダル。プロジェクト設定「リポジトリ」とワークスペースの
 * リポジトリサイドバーの両方がこれを開く（それぞれにあったインラインフォームを
 * 置き換えたもの）。先行例は settings/EnvironmentModals.tsx。
 *
 * 入力状態と POST はモーダルが持つ（呼び出し側 2 箇所で同じ state を二重に
 * 持たないため）。`open` が false の間は Modal が null を返してアンマウント
 * されるので、閉じれば入力は破棄される。
 */
export function AddRepositoryModal({ open, projectId, onAdded, onClose }: AddRepositoryModalProps) {
  const { t } = useTranslation(['git', 'common']);
  const { showToast } = useToast();
  const [values, setValues] = useState<RepositoryFormValues>(EMPTY_REPOSITORY_FORM);
  const [saving, setSaving] = useState(false);
  const [urlError, setUrlError] = useState<string | undefined>(undefined);

  const handleClose = useCallback(() => {
    setValues(EMPTY_REPOSITORY_FORM);
    setUrlError(undefined);
    onClose();
  }, [onClose]);

  const handleChange = useCallback((next: RepositoryFormValues) => {
    setValues(next);
    if (next.url.trim()) setUrlError(undefined);
  }, []);

  const handleSubmit = useCallback(async () => {
    const payload = buildRepositoryCreatePayload(values);
    if (!payload) {
      setUrlError(t('repo.urlRequired'));
      return;
    }
    setSaving(true);
    try {
      await api(`/projects/${projectId}/repositories`, { method: 'POST', body: JSON.stringify(payload) });
      setValues(EMPTY_REPOSITORY_FORM);
      setUrlError(undefined);
      onAdded();
    } catch (err) {
      showToast((err as Error).message || t('repo.addFailed'));
    } finally {
      setSaving(false);
    }
  }, [values, projectId, onAdded, showToast, t]);

  return (
    <Modal
      title={t('repo.addRepository')}
      open={open}
      onClose={handleClose}
      maxWidth={560}
      actions={(
        <Button
          variant="primary"
          onClick={handleSubmit}
          loading={saving}
          loadingLabel={t('common:actions.saving')}
        >
          {t('common:actions.add')}
        </Button>
      )}
    >
      <RepositoryFormFields values={values} onChange={handleChange} urlError={urlError} disabled={saving} />
    </Modal>
  );
}
