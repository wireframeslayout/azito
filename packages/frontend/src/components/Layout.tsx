import { Suspense, lazy } from 'react';
import { useLocation } from 'react-router-dom';
import ProjectSidebar from './ProjectSidebar';
import { WorkspaceTargetsProvider } from '../hooks/useWorkspaceTargets';
import { AgentActivityProvider } from '../hooks/useAgentActivity';
import { NotificationCenterProvider } from '../hooks/useNotificationCenter';
import { ToastProvider } from '../hooks/useToast';
import { ConfirmProvider } from '../hooks/useConfirm';
import { TerminalThemeProvider } from '../hooks/useTerminalTheme';
import TerminalBackdrop from './TerminalBackdrop';
import { isGlobalPagePath } from '../paths';
import { StatusBar } from './StatusBar';
import { useServerResources, ServerResourcesProvider } from '../hooks/useServerResources';
import { ServerStatusProvider } from '../hooks/useServerStatuses';
import { SystemUpdateProvider } from '../hooks/useSystemUpdate';
import { HealthProvider } from '../hooks/useHealth';
import { UpdateOverlay } from './system/UpdateOverlay';
import { LoadingState } from './ui';

const Workspace = lazy(() => import('../pages/Workspace'));
const GlobalPageShell = lazy(() => import('./global/GlobalPageShell'));

export default function Layout() {
  const location = useLocation();
  const isGlobal = isGlobalPagePath(location.pathname);
  const { data: resourceData } = useServerResources(30000);
  const servers = resourceData?.servers ?? [];

  return (
    <TerminalThemeProvider>
    <ToastProvider>
    <ConfirmProvider>
    <WorkspaceTargetsProvider>
      <AgentActivityProvider>
      <NotificationCenterProvider>
      <ServerResourcesProvider servers={servers}>
      <ServerStatusProvider>
      <SystemUpdateProvider>
      <HealthProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', background: 'var(--bg-card)' }}>
          <div className="project-sidebar-desktop" style={{ height: '100%' }}>
            <ProjectSidebar />
          </div>
          <div className="workspace-panel" style={{ flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative', isolation: 'isolate' }}>
            <TerminalBackdrop variant="app" />
            <div style={{ display: isGlobal ? 'none' : 'contents' }}>
              <Suspense fallback={<LoadingState />}>
                <Workspace />
              </Suspense>
            </div>
            {isGlobal && (
              <Suspense fallback={<LoadingState />}>
                <GlobalPageShell />
              </Suspense>
            )}
          </div>
        </div>
        <StatusBar servers={servers} />
        <UpdateOverlay />
        <style>{`
          .project-sidebar-desktop { display: block; }
          .workspace-panel { background: var(--bg); }
          @media (min-width: 769px) {
            .workspace-panel {
              border-left: 1px solid var(--border);
            }
          }
          @media (max-width: 768px) {
            .project-sidebar-desktop { display: none !important; }
          }
        `}</style>
      </div>
      </HealthProvider>
      </SystemUpdateProvider>
      </ServerStatusProvider>
      </ServerResourcesProvider>
      </NotificationCenterProvider>
      </AgentActivityProvider>
    </WorkspaceTargetsProvider>
    </ConfirmProvider>
    </ToastProvider>
    </TerminalThemeProvider>
  );
}
