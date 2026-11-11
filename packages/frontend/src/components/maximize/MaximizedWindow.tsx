import { useEffect, useRef, useState } from 'react';
import type { Window } from '../../pages/workspace/types';
import { useTranslation } from 'react-i18next';
import { Overlay, Button, Notice } from '../ui';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { handleRovingTreeKeyDown } from '../../hooks/useTreeKeyboard';
import { GlassPopoverSurface } from '../ui/GlassPopoverSurface';
import { TerminalContainer } from '../TerminalContainer';
import { MaximizeHeader } from './MaximizeHeader';
import { MaximizeTreeRow } from './MaximizeTreeRow';
import { useWindowViewMode } from '../../hooks/useWindowViewMode';
import { useMaximizedWindow } from '../../hooks/useMaximizedWindow';
import { useWorkspaceCatalog } from '../../hooks/useWorkspaceCatalog';
import { useWorkspaceTargets } from '../../hooks/useWorkspaceTargets';
import { useHotkeyBindings } from '../../hooks/useHotkeys';
import { formatKeySpec } from '../../lib/hotkeys/keySpec';
import { useOrchestrationLinks } from '../../hooks/useOrchestrationLinks';
import { useOrchestrationModel } from '../../hooks/useOrchestrationModel';
import { buildAttentionContext } from '../../lib/orchestrationModel';
import { resolveLinkedWindows } from '../../lib/linkedWindowsModel';
import { useOperationLinks } from '../../hooks/useOperationLinks';
import { buildOpenTabsTree, buildLinkedTree, visibleMaximizeWindows, focusableMaximizeRow, type MaximizeTreeRow as MaximizeTreeRowModel } from '../../lib/maximizeTreeModel';

export function MaximizedWindow() {
  const { selectedWindowId, isMobile } = useMaximizedWindow();
  return selectedWindowId !== null && !isMobile ? <MaximizedWindowContent /> : null;
}

function MaximizedWindowContent() {
  const { t } = useTranslation('workspace');
  const { selectedWindowId, workspace, extraWindows, rememberWindow, forgetWindow, select, close, isMobile, fallbackFocusTo } = useMaximizedWindow();
  const { allTasks, allProjects, refresh } = useWorkspaceCatalog();
  const { onOpenTask, onOpenInTerminal } = useWorkspaceTargets();
  const { windowIndicator, entries } = useAgentActivity();
  const { tree: orchestrators } = useOrchestrationModel();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => globalThis.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => { const query = globalThis.matchMedia('(max-width: 1100px)'); const change = (event: MediaQueryListEvent) => setNarrow(event.matches); query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
  const [inputFocused, setInputFocused] = useState(false);
  const [waking, setWaking] = useState(false);
  const [linkedSource, setLinkedSource] = useState<Window | null>(null);
  const { bindings } = useHotkeyBindings();
  const previousWindowId = useRef<number | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const treeToggleRef = useRef<HTMLButtonElement>(null);
  const lastTreeFocus = useRef<HTMLElement | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const open = selectedWindowId !== null && !isMobile;
  const fallbackFocus = fallbackFocusTo?.isConnected ? fallbackFocusTo : Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]')).find(element => element.dataset.tabId === workspace?.activeTabId) ?? null;
  const tabs = workspace?.tabs ?? [];
  const tabTaskIds = new Set(tabs.flatMap(tab => tab.kind === 'task' ? [tab.taskId] : []));
  const tabWindowIds = new Set(tabs.flatMap(tab => tab.kind === 'window' ? [tab.windowId] : []));
  const links = useOperationLinks(allTasks.filter(task => tabTaskIds.has(task.id) || task.windows?.some(window => tabWindowIds.has(window.id))).map(task => task.id));
  const rows = buildOpenTabsTree(workspace?.tabs ?? [], allTasks, workspace?.windows ?? new Map(), links.parents);
  const window = selectedWindowId === null ? undefined : workspace?.windows.get(selectedWindowId) ?? extraWindows.get(selectedWindowId);
  const source = window?.role === 'orchestrator' ? window : linkedSource;
  useEffect(() => { if (!open) setLinkedSource(null); else if (window?.role === 'orchestrator') setLinkedSource(window); }, [open, window]);
  const orchestration = useOrchestrationLinks(open && source ? source.id : null);
  const findNode = (nodes: typeof orchestrators): (typeof orchestrators)[number] | undefined => { for (const node of nodes) { if (node.window.id === source?.id) return node; const found = findNode(node.children); if (found) return found; } };
  const linkedItems = resolveLinkedWindows(orchestration.links, [...(workspace?.windows.values() ?? []), ...extraWindows.values()], allTasks, allProjects, buildAttentionContext(entries, allTasks));
  const selectedResolved = orchestration.links.find(link => link.resolvedWindowId === selectedWindowId)?.resolvedWindow;
  const selectedLinked = selectedResolved && { ...selectedResolved, projectId: selectedResolved.projectId ?? undefined, taskId: selectedResolved.taskId ?? undefined, label: selectedResolved.label ?? undefined };
  useEffect(() => {
    const saved = selectedWindowId === null ? undefined : extraWindows.get(selectedWindowId);
    if (selectedLinked && saved && (saved.sleeping !== selectedLinked.sleeping || saved.tmuxTarget !== selectedLinked.tmuxTarget)) rememberWindow(selectedLinked);
  }, [selectedLinked, selectedWindowId, extraWindows, rememberWindow]);
  const unavailableLink = orchestration.links.find(link => link.targetWindowId === selectedWindowId && link.resolvedWindowId === null);
  useEffect(() => {
    if (!orchestration.loading && !orchestration.error && unavailableLink && selectedWindowId !== null) forgetWindow(selectedWindowId);
  }, [orchestration.loading, orchestration.error, unavailableLink, selectedWindowId, forgetWindow]);
  const linkedRows = source ? buildLinkedTree(linkedItems, findNode(orchestrators)?.children ?? []) : [];
  const visible = visibleMaximizeWindows([...rows, ...linkedRows], expanded);
  const task = window ? allTasks.find(item => item.windows?.some(w => w.id === window.id)) : undefined;
  const project = window ? allProjects.find(item => item.id === (task?.projectId ?? window.projectId)) : undefined;
  const status = window ? windowIndicator(window.serverName, window.tmuxTarget) : null;
  const [viewMode, setViewMode] = useWindowViewMode(selectedWindowId, false, window?.windowType === 'agent');
  const knownKeys = useRef(new Set<string>());
  const treeSelection = useRef<number | null>(null);
  const allRows = [...rows, ...linkedRows];
  const rowKeys = (items: readonly MaximizeTreeRowModel[]): unknown[] => items.map(row => [row.key, rowKeys(row.children)]);
  const rowSignature = JSON.stringify(rowKeys(allRows));
  useEffect(() => {
    if (!open) { knownKeys.current = new Set(); treeSelection.current = null; return; }
    const keys = new Set<string>();
    let selectedPath: string[] | undefined;
    const visit = (items: MaximizeTreeRowModel[], path: string[]) => {
      for (const row of items) {
        keys.add(row.key);
        const next = [...path, row.key];
        if (row.kind === 'window' && row.window.id === selectedWindowId) selectedPath = next;
        visit(row.children, next);
      }
    };
    visit(allRows, []);
    const added = [...keys].filter(key => !knownKeys.current.has(key));
    const initial = knownKeys.current.size === 0;
    knownKeys.current = keys;
    const selectionChanged = treeSelection.current !== selectedWindowId;
    treeSelection.current = selectedWindowId;
    const revealSelection = selectionChanged || (selectedPath && added.includes(selectedPath[selectedPath.length - 1]));
    setExpanded(previous => new Set([...previous, ...added, ...(revealSelection ? selectedPath?.slice(0, -1) ?? [] : [])].filter(key => keys.has(key))));
    setFocused(previous => (selectionChanged ? selectedPath?.at(-1) : undefined) ?? (previous && keys.has(previous) ? previous : selectedPath?.at(-1) ?? allRows[0]?.key ?? null));
    if (initial) {
      setTreeOpen(true);
      if (selectedPath) requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"]')?.focus());
    } else if (lastTreeFocus.current && !lastTreeFocus.current.isConnected && document.activeElement === document.body) {
      requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"]')?.focus());
    }
  }, [open, selectedWindowId, rowSignature]);
  useEffect(() => {
    const previous = previousWindowId.current;
    previousWindowId.current = selectedWindowId;
    if (!open || previous === null || previous === selectedWindowId) return;
    const timer = globalThis.setTimeout(() => terminalRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea, [data-maximize-input]')?.focus(), 0);
    return () => globalThis.clearTimeout(timer);
  }, [selectedWindowId]);
  const selectWindow = (id: number) => {
    const findWindow = (items: readonly MaximizeTreeRowModel[]): Window | undefined => {
      for (const row of items) {
        if (row.kind === 'window' && row.window.id === id) return row.window;
        const child = findWindow(row.children);
        if (child) return child;
      }
    };
    const target = findWindow(allRows);
    if (target && !workspace?.windows.has(id)) rememberWindow(target);
    select(id);
  };
  const move = (delta: number) => {
    if (!visible.length) return;
    const index = selectedWindowId === null ? -1 : visible.indexOf(selectedWindowId);
    const next = visible[(index + delta + visible.length) % visible.length];
    selectWindow(next);
  };
  // Overlay owns its stack entry; local shortcuts are registered inside it below.
  return <Overlay open={open} onClose={close} labelledBy="maximize-title" fallbackFocusTo={fallbackFocus} toggleAction="maximize.open" toggleWhen="always" surface="solid" maxWidth="min(1400px, 96vw)" maxHeight="96vh" style={{ width: '96vw', height: '96vh', display: 'flex', flexDirection: 'column', padding: 0 }} onPrevious={() => move(-1)} onNext={() => move(1)} shouldCloseOnEscape={event => !(event.target instanceof HTMLElement && (event.target.closest('.xterm') || event.target.closest('[data-maximize-input]')))}>

    <MaximizeHeader window={window} task={task} project={project} status={status} viewMode={viewMode} onViewModeChange={mode => setViewMode(mode, selectedWindowId)} onFocus={() => setInputFocused(false)} onOpenTask={() => { if (task) onOpenTask?.(task.id); close(); }} onOpenTab={() => { if (window) { if (workspace?.windows.has(window.id)) workspace.openWindowTab(window.id); else onOpenInTerminal?.({ serverName: window.serverName, target: window.tmuxTarget, windowId: window.id }); } close(); }} onClose={close} />
    <div onFocusCapture={event => setInputFocused(event.target instanceof HTMLElement && !!event.target.closest('.xterm, [data-maximize-input]'))} className="maximize-content" style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
      <button ref={treeToggleRef} type="button" className="maximize-tree-toggle btn" aria-expanded={treeOpen} onClick={() => setTreeOpen(value => !value)}>{t('maximize.openTabs')}</button>
      <GlassPopoverSurface onKeyDown={event => { if (event.key === 'Escape' && narrow && treeOpen) { event.preventDefault(); event.stopPropagation(); setTreeOpen(false); requestAnimationFrame(() => treeToggleRef.current?.focus()); } }} open={open && narrow && treeOpen} onOutside={event => { if (!(event.target instanceof Element && event.target.closest('.maximize-tree-toggle'))) setTreeOpen(false); }} className={`maximize-tree ${treeOpen ? 'is-open' : ''}`} style={{ order: 2, overflow: 'auto', padding: 'var(--space-2)', background: 'var(--bg-elevated)' }}>
        <strong style={{ fontSize: 'var(--font-sm)' }}>{t('maximize.openTabs')}</strong>
        {links.error && <div role="alert">{t('maximize.linksError')} <Button size="sm" onClick={links.reload}>{t('maximize.retry')}</Button></div>}
        {rows.length === 0 && <p>{t('maximize.empty')}</p>}
        <div ref={treeRef} role="tree" aria-label={t('maximize.openTabs')} onFocusCapture={event => { if (event.target instanceof HTMLElement && event.target.getAttribute('role') === 'treeitem') lastTreeFocus.current = event.target; }} onKeyDown={event => handleRovingTreeKeyDown(event, treeRef.current, key => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; }))}>
          {rows.map(row => <MaximizeTreeRow key={row.key} row={row} expanded={expanded} focused={focusableMaximizeRow(rows, expanded, focused)} selected={selectedWindowId} onFocus={setFocused} onSelect={id => { select(id); setTreeOpen(false); }} onToggle={key => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })} />)}
        </div>
        {source && <section aria-label={t('maximize.linkedTitle', { name: source.label ?? source.tmuxTarget })}>
          <strong>{t('maximize.linkedTitle', { name: source.label ?? source.tmuxTarget })}</strong>
          {orchestration.loading && <p role="status">{t('linkedPanel.loading')}</p>}
          {orchestration.error && <Notice tone="danger" role="alert" action={<Button size="sm" onClick={() => void orchestration.refresh()}>{t('maximize.retry')}</Button>}>{t('maximize.linksError')}</Notice>}
          {!orchestration.loading && !orchestration.error && orchestration.links.length === 0 && linkedRows.length === 0 && <p>{t('maximize.linkedEmpty')}</p>}
          {!orchestration.error && linkedItems.some(item => !item.window && !item.task) && <p role="status">{t('linkedPanel.windowUnavailable')}</p>}
          <div role="tree" aria-label={t('maximize.linkedTitle', { name: source.label ?? source.tmuxTarget })} onKeyDown={event => handleRovingTreeKeyDown(event, event.currentTarget, key => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; }))}>
            {linkedRows.map(row => <MaximizeTreeRow key={row.key} row={row} expanded={expanded} focused={focusableMaximizeRow(linkedRows, expanded, focused)} selected={selectedWindowId} onFocus={setFocused} onSelect={id => { selectWindow(id); setTreeOpen(false); }} onToggle={key => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })} />)}
          </div>
        </section>}
      </GlassPopoverSurface>
      <div ref={terminalRef} style={{ order: 1, flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 0 }}>
        {!window ? <p role="status">{t('maximize.missing')}</p> : window.sleeping ? <div><p>{t('maximize.sleeping')}</p><Button loading={waking} disabled={!workspace} onClick={() => { if (!workspace) return; setWaking(true); void workspace.wakeWindow(window).then(() => Promise.all([refresh(), orchestration.refresh()])).finally(() => setWaking(false)); }}>{t('maximize.wake')}</Button></div> : <TerminalContainer key={window.id} viewMode={viewMode} onViewModeChange={mode => setViewMode(mode, selectedWindowId)} registeredWindow={{ id: window.id, taskId: window.taskId }} serverName={window.serverName} target={window.tmuxTarget} terminalRef={{ kind: 'windowId', serverName: window.serverName, windowId: window.id, pane: 1 }} projectId={window.projectId ?? task?.projectId} taskId={task?.id} allTasks={allTasks} />}
      </div>
    </div>
    <footer className="maximize-footer key-hints">
      {inputFocused && <span><kbd className="key-chip">Esc</kbd> {t('maximize.inputHint')}</span>}
      <span><kbd className="key-chip">Alt + ↑ / ↓</kbd> {t('maximize.hint')}</span>
      {bindings['maximize.open'] && <span><kbd className="key-chip">{formatKeySpec(bindings['maximize.open'])}</kbd> {t('maximize.close')}</span>}
    </footer>
    <style>{`.maximize-tree { width: var(--orchestration-sidebar-width); flex-shrink: 0; } .maximize-tree-toggle { display: none; } @media (max-width: 1100px) { .maximize-tree-toggle { display: block; position: absolute; top: var(--space-2); right: var(--space-2); z-index: 1; } .maximize-tree { display: none; position: absolute; z-index: 2; top: calc(var(--space-6) * 2); right: var(--space-2); width: min(var(--orchestration-sidebar-width), 90%); max-height: 70%; border: 1px solid var(--border); } .maximize-tree.is-open { display: block; } } .maximize-tree-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }`}</style>
  </Overlay>;
}
