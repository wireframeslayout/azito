import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui';
import ProjectWizard from '../ProjectWizard';
import EnvironmentFormFields, { type EnvironmentFormFieldsProps } from './EnvironmentFormFields';

/**
 * プロジェクト設定「サーバー環境」の追加/編集モーダル。
 *
 * 先行例は components/workspace/ServerModals.tsx（AddServerModal /
 * EditServerModal）。一覧は常に一覧のまま保ち、フォームはモーダルで開く。
 */

interface AddEnvironmentModalProps {
  open: boolean;
  projectId: number;
  existingServerNames: string[];
  /** 追加が完了したとき。呼び出し側が一覧を再取得してモーダルを閉じる。 */
  onDone: () => void;
  onClose: () => void;
}

/**
 * 既存の追加ウィザード（ProjectWizard の 'addEnvironment' モード）を
 * そのままモーダルに載せる。ウィザードの中身・ステップ・ロジックは変更しない。
 * `open` が false のときは Modal 自体が null を返すのでウィザードはアンマウント
 * され、次回開いたときに入力状態がリセットされる。
 */
export function AddEnvironmentModal({ open, projectId, existingServerNames, onDone, onClose }: AddEnvironmentModalProps) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <Modal title={t('wizard.addEnvironment.title')} open={open} onClose={onClose} maxWidth={640}>
      <ProjectWizard
        mode="addEnvironment"
        projectId={projectId}
        existingServerNames={existingServerNames}
        onDone={onDone}
        onCancel={onClose}
      />
    </Modal>
  );
}

interface EditEnvironmentModalProps extends EnvironmentFormFieldsProps {
  open: boolean;
  onClose: () => void;
  onSubmit: () => void;
  saving?: boolean;
}

export function EditEnvironmentModal({ open, onClose, onSubmit, saving, ...fields }: EditEnvironmentModalProps) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <Modal
      title={t('settings.servers.editTitle', { name: fields.serverName })}
      open={open}
      onClose={onClose}
      maxWidth={560}
      actions={(
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={fields.distributionRepositoryMissing}
          loading={saving}
          loadingLabel={t('common:actions.saving')}
        >
          {t('common:actions.save')}
        </Button>
      )}
    >
      <EnvironmentFormFields {...fields} />
    </Modal>
  );
}
