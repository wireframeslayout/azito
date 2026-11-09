import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Overlay, Button } from '../ui';
import { TerminalContainer } from '../TerminalContainer';
import { useMaximizedWindow } from '../../hooks/useMaximizedWindow';
import { useWorkspaceCatalog } from '../../hooks/useWorkspaceCatalog';
import { useWorkspaceTargets } from '../../hooks/useWorkspaceTargets';
import { useHotkeyBindings } from '../../hooks/useHotkeys';
import { formatKeySpec } from '../../lib/hotkeys/keySpec';
import { useOperationLinks } from '../../hooks/useOperationLinks';
import { buildOpenTabsTree, visibleMaximizeWindows, type MaximizeTreeRow } from '../../lib/maximizeTreeModel';

export function MaximizedWindow() {
  const { t } = useTranslation('workspace');
  const { selectedWindowId, workspace, select, close, isMobile } = useMaximizedWindow();
  const { allTasks, allProjects, refresh } = useWorkspaceCatalog();
  const { onOpenTask } = useWorkspaceTargets();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const { bindings } = useHotkeyBindings();
  const previousWindowId = useRef<number | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const open = selectedWindowId !== null && !isMobile;
  const fallbackFocus = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]')).find(element => element.dataset.tabId === workspace?.activeTabId) ?? null;
  const links = useOperationLinks(open ? allTasks.map(task => task.id) : []);
  const rows = buildOpenTabsTree(workspace?.tabs ?? [], allTasks, workspace?.windows ?? new Map(), links.parents);
  const visible = visibleMaximizeWindows(rows, expanded);
  const window = selectedWindowId === null ? undefined : workspace?.windows.get(selectedWindowId);
  const task = window ? allTasks.find(item => item.windows?.some(w => w.id === window.id)) : undefined;
  const project = window ? allProjects.find(item => item.id === (task?.projectId ?? window.projectId)) : undefined;
  useEffect(() => {
    if (open) {
      setExpanded(new Set(rows.flatMap(row => [row.key, ...row.children.map(child => child.key)])));
      const findSelected = (items: MaximizeTreeRow[]): string | undefined => {
        for (const row of items) {
          if (row.kind === 'window' && row.window.id === selectedWindowId) return row.key;
          const child = findSelected(row.children);
          if (child) return child;
        }
      };
      setFocused(findSelected(rows) ?? rows[0]?.key ?? null);
      setTreeOpen(true);
      requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"]')?.focus());
    }
  }, [open]);
  useEffect(() => {
    const previous = previousWindowId.current;
    previousWindowId.current = selectedWindowId;
    if (!open || previous === null || previous === selectedWindowId) return;
    const timer = globalThis.setTimeout(() => terminalRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea, [data-maximize-input]')?.focus(), 0);
    return () => globalThis.clearTimeout(timer);
  }, [selectedWindowId]);
  const move = (delta: number) => {
    if (!visible.length) return;
    const index = selectedWindowId === null ? -1 : visible.indexOf(selectedWindowId);
    const next = visible[(index + delta + visible.length) % visible.length];
    select(next);
  };
  // Overlay owns its stack entry; local shortcuts are registered inside it below.
  return <Overlay open={open} onClose={close} labelledBy="maximize-title" fallbackFocusTo={fallbackFocus} toggleAction="maximize.open" surface="solid" maxWidth="min(1400px, 96vw)" maxHeight="96vh" style={{ width: '96vw', height: '96vh', display: 'flex', flexDirection: 'column', padding: 0 }} onPrevious={() => move(-1)} onNext={() => move(1)} shouldCloseOnEscape={event => !(event.target instanceof HTMLElement && (event.target.closest('.xterm') || event.target.closest('[data-maximize-input]')))}>

    <header onFocusCapture={() => setInputFocused(false)} style={{ flexWrap: 'wrap', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: 'var(--space-3)', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}><h2 id="maximize-title" style={{ margin: 0 }}>{task?.title ?? t('maximize.title')} · {window?.label ?? window?.tmuxTarget ?? t('maximize.missing')}</h2><div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>{window && `#${window.id} · ${window.serverName} · ${project?.name ?? ''} · ${window.sleeping ? t('maximize.sleeping') : task?.status ?? ''}`}</div></div>
      {task && <Button size="sm" onClick={() => { onOpenTask?.(task.id); close(); }}>{t('maximize.openTask')}</Button>}
      {window && <Button size="sm" onClick={() => { workspace?.openWindowTab(window.id); close(); }}>{t('maximize.openTab')}</Button>}
      <Button size="sm" onClick={close}>{t('maximize.close')}</Button>
    </header>
    <div onFocusCapture={event => setInputFocused(event.target instanceof HTMLElement && !!event.target.closest('.xterm, [data-maximize-input]'))} className="maximize-content" style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
      <button type="button" className="maximize-tree-toggle btn" aria-expanded={treeOpen} onClick={() => setTreeOpen(value => !value)}>{t('maximize.openTabs')}</button>
      <div className={`maximize-tree ${treeOpen ? 'is-open' : ''}`} style={{ order: 2, overflow: 'auto', padding: 'var(--space-2)', background: 'var(--bg-elevated)' }}>
        <strong>{t('maximize.openTabs')}</strong>
        {links.error && <div role="alert">{t('maximize.linksError')} <Button size="sm" onClick={links.reload}>{t('maximize.retry')}</Button></div>}
        {rows.length === 0 && <p>{t('maximize.empty')}</p>}
        <div ref={treeRef} role="tree" aria-label={t('maximize.openTabs')} onKeyDown={event => {
          const items = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? []); const index = items.indexOf(document.activeElement as HTMLElement);
          if (event.key === ' ' ) { event.preventDefault(); return; }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); items[next]?.focus(); }
          if (event.key === 'Enter') { event.preventDefault(); items[index]?.click(); }
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const item = items[index]; const key = item?.dataset.key; if (!key) return; const isExpanded = expanded.has(key); if (item.hasAttribute('aria-expanded') && isExpanded !== (event.key === 'ArrowRight')) setExpanded(previous => { const next = new Set(previous); isExpanded ? next.delete(key) : next.add(key); return next; }); else if (event.key === 'ArrowLeft') item.closest('[role=group]')?.closest<HTMLElement>('[role=treeitem]')?.focus(); else if (item.getAttribute('aria-expanded') === 'true') item.querySelector<HTMLElement>('[role=group] [role=treeitem]')?.focus(); }
        }}>
          {rows.map(row => <TreeRow key={row.key} row={row} expanded={expanded} focused={focused ?? rows[0]?.key} selected={selectedWindowId} onFocus={setFocused} onSelect={id => { select(id); setTreeOpen(false); }} onToggle={key => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })} />)}
        </div>
      </div>
      <div ref={terminalRef} style={{ order: 1, flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {!window ? <p role="status">{t('maximize.missing')}</p> : window.sleeping ? <div><p>{t('maximize.sleeping')}</p><Button onClick={() => { void workspace?.wakeWindow(window.id).then(refresh); }}>{t('maximize.wake')}</Button></div> : <TerminalContainer key={window.id} registeredWindow={{ id: window.id, taskId: window.taskId }} serverName={window.serverName} target={window.tmuxTarget} projectId={window.projectId ?? task?.projectId} taskId={task?.id} allTasks={allTasks} />}
      </div>
    </div>
    <footer style={{ padding: 'var(--space-2)', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>{t(inputFocused ? 'maximize.inputHint' : 'maximize.hint')} {bindings['maximize.open'] && ` · ${formatKeySpec(bindings['maximize.open'])}: ${t('maximize.close')}`}</footer>
    <style>{`.maximize-tree { width: 260px; flex-shrink: 0; } .maximize-tree-toggle { display: none; } @media (max-width: 1100px) { .maximize-tree-toggle { display: block; position: absolute; top: var(--space-2); right: var(--space-2); z-index: 1; } .maximize-tree { display: none; position: absolute; z-index: 2; top: calc(var(--space-6) * 2); right: var(--space-2); width: min(260px, 90%); max-height: 70%; border: 1px solid var(--border); } .maximize-tree.is-open { display: block; } }`}</style>
  </Overlay>;
}

function TreeRow({ row, expanded, focused, selected, onFocus, onSelect, onToggle }: { row: MaximizeTreeRow; expanded: ReadonlySet<string>; focused: string | null; selected: number | null; onFocus: (key: string) => void; onSelect: (id: number) => void; onToggle: (key: string) => void }) {
  const { t } = useTranslation('workspace');
  const id = row.kind === 'window' ? row.window.id : row.windowId;
  const label = row.kind === 'task' ? row.task.title : row.window.label || row.window.tmuxTarget;
  const hasChildren = row.children.length > 0;
  return <div role="treeitem" tabIndex={focused === row.key ? 0 : -1} data-key={row.key} aria-selected={id !== null && id === selected} aria-expanded={hasChildren ? expanded.has(row.key) : undefined} onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }} onClick={event => { event.stopPropagation(); if (id !== null) onSelect(id); }} style={{ padding: 'var(--space-1)', cursor: id === null ? 'default' : 'pointer', background: id !== null && id === selected ? 'var(--selected-bg-strong)' : undefined }}>
    {hasChildren && <button tabIndex={-1} aria-label={t(expanded.has(row.key) ? 'maximize.collapse' : 'maximize.expand')} onClick={event => { event.stopPropagation(); onToggle(row.key); }}>{expanded.has(row.key) ? '▾' : '▸'}</button>}{label}
    {hasChildren && expanded.has(row.key) && <div role="group" style={{ paddingLeft: 'var(--space-3)' }}>{row.children.map(child => <TreeRow key={child.key} row={child} expanded={expanded} focused={focused} selected={selected} onFocus={onFocus} onSelect={onSelect} onToggle={onToggle} />)}</div>}
  </div>;
}
