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
import { UpdateOverlay } from './system/UpdateOverlay';
import { LoadingState } from './ui';
import { MOBILE_SHELL_SLOT_ID, MOBILE_STATUS_SLOT_ID } from '../hooks/useMobileShellPortalNode';

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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', background: 'var(--bg-card)' }}>
          <div className="project-sidebar-desktop" style={{ height: '100%' }}>
            <ProjectSidebar />
          </div>
          <div className="workspace-panel" style={{ flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative', isolation: 'isolate', display: 'flex', flexDirection: 'column' }}>
            <TerminalBackdrop variant="app" />
            {/* SP チップ行の常設スロット（Issue #69 T8b）: Workspace／WorkspaceLayout が
                自身のチップ行・ナビシート・タブスイッチャーシートをここへ createPortal する。
                グローバルページ表示中に Workspace 自身のサブツリーが display:none で隠れても、
                このスロットは常設（flex column の最上段）のため隠れない。SP 以外は空のまま
                （中身が mobile 限定のため高さゼロ、既存デスクトップ表示に影響しない）。
                zIndex は付けない: このスロット自体に z-index を持たせるとここが独自の
                stacking context になり、下（コンテンツ側）で position:fixed の全画面シート
                （TaskDetailMenu 等、このスロットの外＝タスクパネル側でレンダーされる）が
                どれだけ高い z-index を積んでも、スロット全体の背後に埋もれてしまう
                （Issue #338 レビュー指摘）。チップ行自体は position:fixed で全画面を覆わない
                ため z-index 不要 — 各シート側が自身の z-index で正しく前面に出る。 */}
            <div id={MOBILE_SHELL_SLOT_ID} style={{ flexShrink: 0, position: 'relative' }} />
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
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
        </div>
        <StatusBar servers={servers} />
        {/* SP 常駐ステータスバーのスロット（Issue #338 T13）: mobile-shell-slot と対になる
            下端版。flexShrink:0 で高さ分だけ上のコンテンツ行（project-sidebar-desktop +
            workspace-panel）が自動的に縮むため、SP の文脈フッター（TerminalQuickKeyBar /
            PromptInputBar、いずれも in-flow でコンテンツ列末尾に描画される）はこのスロットの
            分だけ自然に上へ積まれる — --sp-footer-h のような bottom オフセット計算は不要
            （Issue #263 で導入・Issue #338 T1 で拡張された機構は、唯一の消費者だった
            FloatingActivityPill の廃止に伴い不要になったため削除した）。デスクトップでは
            Workspace 側が MobileStatusBar 自体をレンダーしないため常に空のまま（高さ0）。 */}
        <div id={MOBILE_STATUS_SLOT_ID} style={{ flexShrink: 0, position: 'relative' }} />
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
