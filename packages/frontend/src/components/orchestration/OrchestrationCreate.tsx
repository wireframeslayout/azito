import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAddWindowModal } from '../../hooks/useAddWindowModal';
import { useServerStatuses } from '../../hooks/useServerStatuses';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useToast } from '../../hooks/useToast';
import { paths } from '../../paths';
import Modal from '../Modal';
import FormField from '../FormField';
import DirectoryInput from '../DirectoryInput';
import ResourceWarningDialog from '../ResourceWarningDialog';
import { Button, FormSelect } from '../ui';

export function OrchestrationCreate({ showButton }: { showButton: boolean }) {
  const { t } = useTranslation('workspace');
  const { servers } = useServerStatuses();
  const { refresh, windows } = useOrchestrators();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const { showToast } = useToast();
  const navigate = useNavigate();
  const modal = useAddWindowModal(undefined, null, servers, [], refresh, undefined, (ref) => {
    if (typeof ref !== 'string' && ref.kind === 'windowId') { setPendingId(ref.windowId); refresh(); }
  }, undefined, 'orchestrator');
  useEffect(() => {
    if (pendingId !== null && windows.some((window) => window.id === pendingId)) {
      setPendingId(null);
      navigate(paths.orchestration(pendingId));
    }
  }, [pendingId, windows, navigate]);
  const submit = (): void => {
    if (!modal.awServer || !modal.awWorkDir.trim()) { showToast(t('orchestration.fieldsRequired')); return; }
    void modal.handleAddWindow().catch(() => showToast(t('orchestration.createError')));
  };
  return <>
    {showButton && <Button variant="primary" onClick={() => { void modal.openAddWindow(); }}>{t('orchestration.create')}</Button>}
    <Modal title={t('orchestration.create')} open={modal.addWindowOpen} onClose={() => modal.setAddWindowOpen(false)} actions={<Button variant="primary" onClick={submit} loading={modal.addWindowLoading}>{t('orchestration.create')}</Button>}>
      <FormField label={t('addWindow.server')} htmlFor="orchestration-server"><FormSelect id="orchestration-server" value={modal.awServer} onChange={(e) => modal.setAwServer(e.target.value)}>{servers.map((server) => <option key={server.name} value={server.name}>{server.name}</option>)}</FormSelect></FormField>
      <FormField label={t('orchestration.agent')} htmlFor="orchestration-agent"><FormSelect id="orchestration-agent" value={modal.awAgent} onChange={(e) => { void modal.handleAgentChange(e.target.value); }}><option value="claude">Claude</option><option value="codex">Codex</option></FormSelect></FormField>
      <FormField label={t('orchestration.directory')} htmlFor="orchestration-directory"><DirectoryInput id="orchestration-directory" serverName={modal.awServer} value={modal.awWorkDir} onChange={modal.setAwWorkDir} /></FormField>
    </Modal>
    <ResourceWarningDialog open={modal.awResourceWarning !== null} title={t('addWindow.title')} resources={modal.awResourceWarning?.resources ?? null} actionLabel={t('addWindow.createAndAdd')} onCancel={() => modal.setAwResourceWarning(null)} onForce={() => modal.awResourceWarning?.retry()} />
  </>;
}
