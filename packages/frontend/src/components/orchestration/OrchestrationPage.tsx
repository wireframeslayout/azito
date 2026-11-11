import { formatWindowTitleLine, resolveWindowTitle } from '@azito/shared';
import { windowTitleInput } from '../../lib/windowDisplay';
import { useEffect, useRef, useState } from 'react';
import type { Window } from '../../pages/workspace/types';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOrchestrationModel } from '../../hooks/useOrchestrationModel';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { orchestratorStatus, buildOrchestratorTree } from '../../lib/orchestrationModel';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useOptionalMaximizedWindow } from '../../hooks/useMaximizedWindow';
import { useWorkspaceTargets } from '../../hooks/useWorkspaceTargets';
import { BottomSheet } from '../ui/BottomSheet';
import { LinkedPanel } from './LinkedPanel';
import { useWindowViewMode } from '../../hooks/useWindowViewMode';
import type { WindowViewMode } from '../../lib/windowViewMode';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useRightPanelState } from '../../hooks/useRightPanelState';
import { useToast } from '../../hooks/useToast';
import { paths } from '../../paths';
import { TerminalContainer } from '../TerminalContainer';
import { RightPanel } from '../workspace/RightPanel';
import { RightPanelToggle } from '../workspace/RightPanelToggle';
import { GlassPopover, LoadingState, EmptyState, Notice, Button, IconButton, TabBar, SegmentedToggle } from '../ui';
import { Icon } from '../ui/Icon';
import { BrailleSpinner } from '../ui/WindowActivityIndicator';
import { OrchestrationCreate } from './OrchestrationCreate';
import { OrchestrationSidebar } from './OrchestrationSidebar';

export interface OrchestrationPageProps { rightPanel?: ReactNode }

function titleOf(window: Window): string {
  return formatWindowTitleLine(resolveWindowTitle({ ...windowTitleInput(window), tmuxTarget: window.tmuxTarget }));
}

function OrchestrationWindow({ window, isMobile, showTab = false }: { window: Window; isMobile: boolean; showTab?: boolean }) {
  const { t } = useTranslation('common');
  // isMobile=false keeps the terminal as the default on phones too; changing that default is #719.
  const [viewMode, setViewMode] = useWindowViewMode(window.id, false, window.windowType === 'agent');
  const changeMode = (mode: WindowViewMode) => setViewMode(mode, window.id);
  return <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
    {showTab && <TabBar showTabList={false} tabs={[{ id: String(window.id), label: titleOf(window), closable: false }]} activeId={String(window.id)} onSelect={() => {}} trailing={!isMobile ? <SegmentedToggle<WindowViewMode> ariaLabel={t('terminal.viewMode.ariaLabel')} value={viewMode} onChange={changeMode} options={[{ value: 'terminal', label: t('terminal.viewMode.terminal'), icon: 'terminal' }, { value: 'chat', label: t('terminal.viewMode.chat'), icon: 'transcript' }]} /> : undefined} />}
    <TerminalContainer viewMode={viewMode} onViewModeChange={changeMode} serverName={window.serverName} target={window.tmuxTarget} terminalRef={{ kind: 'windowId', serverName: window.serverName, windowId: window.id, pane: 1 }} registeredWindow={{ id: window.id }} />
  </div>;
}

export default function OrchestrationPage({ rightPanel }: OrchestrationPageProps): ReactNode {
  const { t } = useTranslation('workspace');
  const isMobile = useIsMobile();
  const maximized = useOptionalMaximizedWindow();
  const { onOpenInTerminal, linkedSheetOpen: sheetOpen, setLinkedSheetOpen: setSheetOpen } = useWorkspaceTargets();
  useEffect(() => () => setSheetOpen(false), [setSheetOpen]);
  const [sheetWindow, setSheetWindow] = useState<Window | null>(null);
  const [windowOrder, setWindowOrder] = useState<Window[]>([]);
  const [fixedOrder, setFixedOrder] = useState<Window[]>([]);
  const touchStart = useRef<number | null>(null);
  const { windows, status, refresh } = useOrchestrators();
  const { entries, snapshotStatus } = useAgentActivity();
  const { tree } = useOrchestrationModel();
  const { pathname, state } = useLocation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [open, setOpen] = useRightPanelState();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLButtonElement>(null);
  const id = pathname.split('/')[2];
  const selected = windows.find((window) => String(window.id) === id);
  const ancestors: number[] = [];
  let parent = selected?.parentWindowId;
  while (parent != null && !ancestors.includes(parent)) { ancestors.push(parent); parent = windows.find(window => window.id === parent)?.parentWindowId; }
  const findNode = (nodes: typeof tree): (typeof tree)[number] | undefined => { for (const node of nodes) { if (node.window.id === selected?.id) return node; const found = findNode(node.children); if (found) return found; } return undefined; };
  const openInTab = (window: Window) => { setSheetOpen(false); onOpenInTerminal?.({ serverName: window.serverName, target: window.tmuxTarget, windowId: window.id }); navigate(window.projectId ? paths.workspace(window.projectId) : paths.root()); };
  const panel = selected && <LinkedPanel key={selected.id} windowId={selected.id} children={findNode(tree)?.children ?? []} onWindowOrder={setWindowOrder} onEnter={childId => navigate(paths.orchestration(childId))} enabled={isMobile ? sheetOpen : open} excludedWindowIds={[selected.id, ...ancestors]} onExpand={isMobile ? openInTab : window => maximized?.open(window.id, window)} onOpen={window => { if (isMobile) { setFixedOrder(windowOrder); setSheetWindow(window); return; } openInTab(window); }} onProject={projectId => navigate(paths.workspace(projectId))} />;
  useEffect(() => {
    if (status !== 'ready') return;
    if (!id && windows.length && !state?.missing && snapshotStatus === 'ready') {
      const roots = buildOrchestratorTree(windows);
      const order = { active: 0, idle: 1, sleeping: 2 };
      roots.sort((a, b) => order[orchestratorStatus(a.window, entries)] - order[orchestratorStatus(b.window, entries)]);
      navigate(paths.orchestration(roots[0].window.id), { replace: true });
    }
    else if (id && !selected) {
      showToast(t('orchestration.notFound'));
      navigate(paths.orchestration(), { replace: true, state: { missing: true } });
    }
  }, [status, id, selected, windows, navigate, showToast, t, state, snapshotStatus, entries]);
  const windowIndex = fixedOrder.findIndex(window => window.id === sheetWindow?.id);
  const stepWindow = (offset: number) => { const next = fixedOrder[windowIndex + offset]; if (next) setSheetWindow(next); };
  if (status === 'loading') return <LoadingState />;
  if (status === 'error' && !windows.length) return <Notice tone="danger" action={<Button onClick={refresh}>{t('orchestration.retry')}</Button>}>{t('orchestration.loadError')}</Notice>;
  return <div style={{ display: 'flex', height: '100%', minWidth: 0 }}>
    {!isMobile && <aside style={{ width: sidebarCollapsed ? 'calc(var(--space-6) * 2)' : 'var(--orchestration-sidebar-width)', maxWidth: '100%', overflow: 'auto', background: 'var(--bg-solid)', borderRight: '1px solid var(--border)' }}>
      {sidebarCollapsed && <IconButton aria-label={t('orchestration.showSidebar')} onClick={() => { setSidebarCollapsed(false); setListOpen(false); }}><Icon name="panel-left-open" size={20} /></IconButton>}
      {sidebarCollapsed ? <>
        <IconButton ref={listRef} aria-label={t('orchestration.title')} onClick={() => setListOpen((value) => !value)}>{windows.some((window) => orchestratorStatus(window, entries) === 'active') ? <BrailleSpinner /> : <Icon name="operations" size={20} />}</IconButton>
        <GlassPopover anchorRef={listRef} open={listOpen} onClose={() => setListOpen(false)} solid ariaLabel={t('orchestration.title')} items={windows.map((window) => ({ key: String(window.id), label: titleOf(window), selected: selected?.id === window.id, onSelect: () => { navigate(paths.orchestration(window.id)); setListOpen(false); } }))} />
      </> : <><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', padding: 'var(--space-2)', minWidth: 0 }}><h2 style={{ margin: 0, fontSize: 'var(--font-base)', whiteSpace: 'nowrap', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('orchestration.title')} {windows.length}</h2>{windows.length > 0 && <OrchestrationCreate showButton compact />}<IconButton aria-label={t('orchestration.hideSidebar')} onClick={() => { setSidebarCollapsed(true); setListOpen(false); }}><Icon name="panel-left-close" size={20} /></IconButton></div><OrchestrationSidebar selectedId={selected?.id} onSelect={(id) => navigate(paths.orchestration(id))} /></>}
    </aside>}
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {status === 'error' && <Notice tone="danger" action={<Button onClick={refresh}>{t('orchestration.retry')}</Button>}>{t('orchestration.loadError')}</Notice>}
      {selected && <nav aria-label={t('orchestration.title')}>{ancestors.slice().reverse().map(ancestorId => { const ancestor = windows.find(window => window.id === ancestorId); return ancestor && <Button key={ancestorId} size="sm" onClick={() => navigate(paths.orchestration(ancestorId))}>{titleOf(ancestor)}</Button>; })}</nav>}
      {selected ? <OrchestrationWindow key={selected.id} window={selected} isMobile={isMobile} showTab={!isMobile} /> : windows.length === 0 ? <EmptyState title={t('orchestration.empty')} action={<OrchestrationCreate showButton />} /> : <EmptyState title={t('orchestration.selectWindow')} />}
      {!isMobile && !open && <RightPanelToggle open={false} onToggle={() => setOpen(true)} controls="orchestration-right-panel" buttonRef={toggleRef} />}
    </main>
    {!isMobile && <RightPanel id="orchestration-right-panel" title={selected ? t('orchestration.connected', { count: selected.links.total }) : t('orchestration.connectedUnknown')} open={open} onOpenChange={setOpen} toggleRef={toggleRef}>{rightPanel ?? panel}</RightPanel>}
    {isMobile && <BottomSheet open={sheetOpen} onClose={() => { setSheetOpen(false); setSheetWindow(null); }} title={t('linkedPanel.title')} detents={[{ label: t('orchestration.expand'), height: '50dvh' }, { label: t('orchestration.collapse'), height: '95dvh' }]}><div hidden={!!sheetWindow}>{panel}</div>{sheetWindow && <div style={{ height: '85%', display: 'flex', flexDirection: 'column' }} onTouchStart={event => { touchStart.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={event => { if (touchStart.current !== null) { const delta = event.changedTouches[0].clientX - touchStart.current; if (Math.abs(delta) > 80) stepWindow(delta < 0 ? 1 : -1); touchStart.current = null; } }}><div style={{ display: 'flex', gap: 'var(--space-2)' }}><Button onClick={() => setSheetWindow(null)}>{t('linkedPanel.back')}</Button><Button disabled={windowIndex <= 0} onClick={() => stepWindow(-1)}>{t('linkedPanel.previous')}</Button><span>{windowIndex + 1} / {fixedOrder.length}</span><Button disabled={windowIndex >= fixedOrder.length - 1} onClick={() => stepWindow(1)}>{t('linkedPanel.next')}</Button></div><OrchestrationWindow key={sheetWindow.id} window={sheetWindow} isMobile /></div>}</BottomSheet>}
  </div>;
}
