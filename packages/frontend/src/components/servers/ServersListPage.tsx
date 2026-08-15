import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerManagement } from '../../hooks/useServerManagement';
import { useServerStatuses } from '../../hooks/useServerStatuses';
import { Chip, Button, LoadingState, EmptyState } from '../ui';
import { AddServerModal, EditServerModal } from '../workspace/ServerModals';
import TopologyView from './TopologyView';
import ServerCardList from './ServerCardList';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Icon } from '../ui/Icon';

export default function ServersListPage() {
  const { t } = useTranslation('servers');
  const isMobile = useIsMobile();

  const dummyTabs: never[] = [];
  const dummyCloseTab = useCallback(() => {}, []);
  const mgmt = useServerManagement({ tabs: dummyTabs, closeTab: dummyCloseTab });
  const { servers, statuses: serverStatuses } = useServerStatuses();
  const { refreshAll } = mgmt;

  const [recheckLoading, setRecheckLoading] = useState(false);

  const handleRecheck = useCallback(async () => {
    setRecheckLoading(true);
    await refreshAll();
    setRecheckLoading(false);
  }, [refreshAll]);

  const counts = useMemo(() => {
    let online = 0;
    let offline = 0;
    let outdated = 0;
    for (const srv of servers) {
      const st = serverStatuses[srv.name];
      if (!st || st.status === 'checking') continue;
      if (st.status === 'online') {
        online++;
        if (st.versionMatch === false) outdated++;
      } else {
        offline++;
      }
    }
    return { online, offline, outdated };
  }, [servers, serverStatuses]);

  const loading = servers.length === 0 && Object.keys(serverStatuses).length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
          {counts.online > 0 && <Chip tone="green">{t('list.onlineCount', { count: counts.online })}</Chip>}
          {counts.offline > 0 && <Chip tone="default">{t('list.offlineCount', { count: counts.offline })}</Chip>}
          {counts.outdated > 0 && <Chip tone="orange">{t('list.outdatedCount', { count: counts.outdated })}</Chip>}
        </div>
        <div style={{ flex: 1 }} />
        <Button onClick={handleRecheck} disabled={recheckLoading}>
          {recheckLoading ? t('list.rechecking') : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="refresh" size={14} /> {t('list.recheckAll')}
            </span>
          )}
        </Button>
        <Button variant="primary" onClick={() => mgmt.setAddServerModal(true)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="plus" size={16} /> {t('list.addServer')}
          </span>
        </Button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <LoadingState message={t('list.loadingServers')} />
        ) : servers.length === 0 ? (
          <EmptyState title={t('list.noServers')} />
        ) : isMobile ? (
          <ServerCardList servers={servers} statuses={serverStatuses} />
        ) : (
          <TopologyView servers={servers} statuses={serverStatuses} />
        )}
      </div>

      <AddServerModal
        open={mgmt.addServerModal}
        onClose={() => mgmt.setAddServerModal(false)}
        onSubmit={mgmt.handleAddServer}
        loading={mgmt.addLoading}
        name={mgmt.addName}
        onNameChange={mgmt.setAddName}
        autoInstall={mgmt.addAutoInstall}
        onAutoInstallChange={mgmt.setAddAutoInstall}
        type={mgmt.addType}
        onTypeChange={mgmt.setAddType}
        host={mgmt.addHost}
        onHostChange={mgmt.setAddHost}
        port={mgmt.addPort}
        onPortChange={mgmt.setAddPort}
        token={mgmt.addToken}
        onTokenChange={mgmt.setAddToken}
        muxRuntime={mgmt.addMuxRuntime}
        onMuxRuntimeChange={mgmt.setAddMuxRuntime}
        installSteps={mgmt.addInstallSteps}
      />
      <EditServerModal
        server={mgmt.editServer}
        onClose={() => mgmt.setEditServer(null)}
        onSubmit={mgmt.handleEditServer}
        type={mgmt.editType}
        onTypeChange={mgmt.setEditType}
        host={mgmt.editHost}
        onHostChange={mgmt.setEditHost}
        port={mgmt.editPort}
        onPortChange={mgmt.setEditPort}
        token={mgmt.editToken}
        onTokenChange={mgmt.setEditToken}
        muxRuntime={mgmt.editMuxRuntime}
        onMuxRuntimeChange={mgmt.setEditMuxRuntime}
        isolationIntent={mgmt.editIsolationIntent}
        onIsolationIntentChange={mgmt.setEditIsolationIntent}
      />
    </div>
  );
}
