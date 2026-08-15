import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useServerDetail } from '../../hooks/useServerDetail';
import { useServerEditForm } from '../../hooks/useServerEditForm';
import { useIsMobile } from '../../hooks/useIsMobile';
import { DEFAULT_SECTION, SERVER_SECTIONS } from './serverSections';
import type { ServerSectionId } from './serverSections';

const VALID_SECTIONS = new Set<string>(SERVER_SECTIONS.map((s) => s.id));
import ServerSectionNav from './ServerSectionNav';
import ServerDrilldownMenu from './ServerDrilldownMenu';
import { LoadingState } from '../ui';
import { EditServerModal } from '../workspace/ServerModals';
import { paths } from '../../paths';

const OverviewSection = lazy(() => import('./sections/OverviewSection'));
const SetupSection = lazy(() => import('./sections/SetupSection'));
const WindowsSection = lazy(() => import('./sections/WindowsSection'));
const DangerSection = lazy(() => import('./sections/DangerSection'));

interface ServerDetailPageProps {
  serverName: string;
  section?: string;
}

export default function ServerDetailPage({ serverName, section }: ServerDetailPageProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('servers');
  const isMobile = useIsMobile();
  const { server, servers, status, installStatus, sessions, isolationReport, loading, error, refresh } = useServerDetail(serverName);
  const mgmt = useServerEditForm();

  const activeSection: ServerSectionId = section && VALID_SECTIONS.has(section)
    ? section as ServerSectionId
    : DEFAULT_SECTION;
  const showDrilldown = isMobile && !section;

  if (loading) return <LoadingState message={t('detail.loadingDetails')} />;

  if (error) {
    return (
      <div style={{ padding: 'var(--space-4)', color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
        <div style={{ marginBottom: 'var(--space-2)' }}>{t('detail.failedToLoad', { error })}</div>
        <button
          onClick={refresh}
          style={{
            background: 'none', border: '1px solid var(--border)',
            color: 'var(--text)', borderRadius: 'var(--radius-md)',
            padding: '6px 16px', fontSize: 'var(--font-sm)', cursor: 'pointer',
          }}
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  if (!server) return null;

  if (showDrilldown) {
    return (
      <ServerDrilldownMenu
        servers={servers}
        currentServerName={serverName}
        status={status}
        installStatus={installStatus}
        sessions={sessions}
      />
    );
  }

  return (
    <>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, height: '100%' }}>
      {!isMobile && (
        <ServerSectionNav
          servers={servers}
          currentServerName={serverName}
          activeSection={activeSection}
        />
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: activeSection === 'windows' ? 'hidden' : 'auto',
          padding: activeSection === 'windows' ? 0 : isMobile ? 'var(--space-3)' : 'var(--space-4)',
          display: activeSection === 'windows' ? 'flex' : 'block',
          flexDirection: activeSection === 'windows' ? 'column' : undefined,
        }}
      >
        <Suspense fallback={<LoadingState message={t('common:states.loading')} />}>
          {activeSection === 'overview' && (
            <OverviewSection
              server={server}
              status={status}
              installStatus={installStatus}
              sessions={sessions}
              isolationReport={isolationReport}
              refresh={refresh}
              onEdit={() => mgmt.openEditModal(server)}
            />
          )}
          {activeSection === 'setup' && (
            <SetupSection server={server} installStatus={installStatus} refresh={refresh} />
          )}
          {activeSection === 'windows' && (
            <WindowsSection server={server} sessions={sessions} refresh={refresh} />
          )}
          {activeSection === 'danger' && (
            <DangerSection
              server={server}
              onDeleted={() => navigate(paths.servers())}
            />
          )}
        </Suspense>
      </div>
    </div>
    <EditServerModal
      server={mgmt.editServer}
      onClose={() => mgmt.setEditServer(null)}
      onSubmit={async () => { const ok = await mgmt.handleEditServer(); if (ok) await refresh(); }}
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
    />
    </>
  );
}
