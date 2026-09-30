import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import FormField from '../FormField';
import DirectoryInput from '../DirectoryInput';
import { baseInputStyle, Button, ModelSelect } from '../ui';

interface QuickAddWindowModalProps {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  onSubmit: () => void;
  serverName: string;
  agentLabel: string;
  showModel: boolean;
  workDir: string;
  onWorkDirChange: (dir: string) => void;
  agentModel: string;
  onAgentModelChange: (model: string) => void;
  workerModels: { id: string; label: string }[];
  workerType?: string;
}

/**
 * ObjectsSidebar の claude/codex/terminal クイック追加アイコン用の最小限モーダル。
 * サーバー・エージェント種別は呼び出し時点で確定しているため、モデル選択と作業ディレクトリのみ入力させる。
 * 送信処理は useAddWindowModal の handleAddWindow ('new' モード) をそのまま利用する。
 */
export default function QuickAddWindowModal({
  open, onClose, loading, onSubmit,
  serverName, agentLabel, showModel,
  workDir, onWorkDirChange,
  agentModel, onAgentModelChange, workerModels,
  workerType,
}: QuickAddWindowModalProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const [modelInvalid, setModelInvalid] = useState(false);
  const handleModelValidityChange = useCallback((valid: boolean) => setModelInvalid(!valid), []);

  return (
    <Modal
      title={t('windows.quickAddTitle', { label: agentLabel, serverName })}
      open={open}
      onClose={onClose}
      maxWidth={400}
      actions={
        <Button variant="primary" onClick={onSubmit} loading={loading} disabled={modelInvalid} loadingLabel={t('addWindow.adding')}>
          {t('addWindow.createAndAdd')}
        </Button>
      }
    >
      <FormField label={t('addWindow.workingDir')}>
        <DirectoryInput
          value={workDir}
          onChange={onWorkDirChange}
          serverName={serverName}
          placeholder={t('addWindow.workingDirPlaceholder')}
          style={baseInputStyle}
        />
      </FormField>
      {showModel && (
        <FormField label={t('addWindow.model')}>
          <ModelSelect
            models={workerModels}
            value={agentModel}
            onChange={onAgentModelChange}
            onValidityChange={handleModelValidityChange}
            placeholder={t('common:labels.default')}
            note={workerType === 'codex' ? t('common:modelSelect.codexVersionNote') : undefined}
          />
        </FormField>
      )}
    </Modal>
  );
}
