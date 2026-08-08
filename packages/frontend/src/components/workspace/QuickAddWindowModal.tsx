import React from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import FormField from '../FormField';
import DirectoryInput from '../DirectoryInput';
import { FormSelect, baseInputStyle, Button } from '../ui';

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
}: QuickAddWindowModalProps) {
  const { t } = useTranslation(['workspace', 'common']);
  return (
    <Modal
      title={t('windows.quickAddTitle', { label: agentLabel, serverName })}
      open={open}
      onClose={onClose}
      maxWidth={400}
      actions={
        <Button variant="primary" onClick={onSubmit} loading={loading} loadingLabel={t('addWindow.adding')}>
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
          <FormSelect value={agentModel} onChange={(e) => onAgentModelChange(e.target.value)}>
            <option value="">{t('common:labels.default')}</option>
            {workerModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </FormSelect>
        </FormField>
      )}
    </Modal>
  );
}
