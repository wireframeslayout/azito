import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import FormField from '../FormField';
import DirectoryInput from '../DirectoryInput';
import { baseInputStyle, BlockedActionButton, ModelSelect } from '../ui';
import type { MuxDriverKind } from '@azito/shared';
import type { MuxKindSelectModel } from '../../lib/muxKindChoice';
import MuxKindField from './MuxKindField';
import { useHostFeatureBlock } from '../../hooks/useHostFeatureBlock';
import { workerLaunchBlock } from '../../lib/workerLaunch';

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
  muxKind: MuxKindSelectModel | null;
  onMuxKindChange: (kind: MuxDriverKind) => void;
}

const QUICK_ADD_BLOCKED_ID = 'quick-add-worker-blocked-reason';

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
  muxKind, onMuxKindChange,
}: QuickAddWindowModalProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const [modelInvalid, setModelInvalid] = useState(false);
  const handleModelValidityChange = useCallback((valid: boolean) => setModelInvalid(!valid), []);
  // The agent this quick add starts (undefined / 'terminal': the terminal button, a plain shell). A Windows pane takes no pane command yet.
  const hostFeatureBlock = useHostFeatureBlock();
  const workerBlockReason = workerLaunchBlock({ mode: 'new', serverName, agent: workerType === undefined || workerType === 'terminal' ? 'none' : workerType }, hostFeatureBlock);

  return (
    <Modal
      title={t('windows.quickAddTitle', { label: agentLabel, serverName })}
      open={open}
      onClose={onClose}
      maxWidth={400}
      actions={
        <BlockedActionButton variant="primary" onClick={onSubmit} loading={loading} disabled={modelInvalid} blockedReason={workerBlockReason} reasonId={QUICK_ADD_BLOCKED_ID} loadingLabel={t('addWindow.adding')}>
          {t('addWindow.createAndAdd')}
        </BlockedActionButton>
      }
    >
      {workerBlockReason && (
        <div id={QUICK_ADD_BLOCKED_ID} role="status" style={{ marginBottom: 12, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {workerBlockReason}
        </div>
      )}
      <MuxKindField model={muxKind} onChange={onMuxKindChange} disabled={loading} />
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
