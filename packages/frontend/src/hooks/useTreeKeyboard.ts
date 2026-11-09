export function handleTreeKeyDown(e: React.KeyboardEvent, tree: HTMLElement | null, expandedIds: ReadonlySet<number>, toggleExpanded: (id: number) => void, toggleWindow: (id: number, current: boolean) => void): void {
    if (!tree) return;
    const items = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx < 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        items[Math.min(idx + 1, items.length - 1)]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[Math.max(idx - 1, 0)]?.focus();
        break;
      case 'ArrowRight': {
        e.preventDefault();
        const windowId = Number(items[idx].dataset.windowId);
        if (windowId && items[idx].getAttribute('aria-expanded') === 'false') { toggleWindow(windowId, false); break; }
        const taskId = Number(items[idx].dataset.taskId);
        if (taskId && !expandedIds.has(taskId)) {
          toggleExpanded(taskId);
        } else {
          const next = items[idx + 1];
          if (next) next.focus();
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const windowId = Number(items[idx].dataset.windowId);
        if (windowId && items[idx].getAttribute('aria-expanded') === 'true') { toggleWindow(windowId, true); break; }
        const taskId = Number(items[idx].dataset.taskId);
        if (taskId && expandedIds.has(taskId)) {
          toggleExpanded(taskId);
        } else {
          const parentItem = items[idx].closest('[role="group"]')?.closest('[role="treeitem"]') as HTMLElement | null;
          if (parentItem) parentItem.focus();
        }
        break;
      }
      case 'Enter':
        e.preventDefault();
        (items[idx] as HTMLElement).click();
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
    }
  }

/** Roving-focus tree operations for trees keyed by strings. */
export function handleRovingTreeKeyDown(e: React.KeyboardEvent, tree: HTMLElement | null, onToggle: (key: string) => void): void {
  if (!tree || e.altKey || e.defaultPrevented) return;
  const items = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  const item = items[index];
  switch (e.key) {
    case ' ':
      e.preventDefault();
      break;
    case 'ArrowDown': case 'ArrowUp': case 'Home': case 'End': {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
      items[next]?.focus();
      break;
    }
    case 'Enter': e.preventDefault(); item.click(); break;
    case 'ArrowRight': case 'ArrowLeft': {
      e.preventDefault();
      const expanded = item.getAttribute('aria-expanded');
      if (item.dataset.key && ((e.key === 'ArrowRight' && expanded === 'false') || (e.key === 'ArrowLeft' && expanded === 'true'))) onToggle(item.dataset.key);
      else if (e.key === 'ArrowLeft') item.closest('[role="group"]')?.closest<HTMLElement>('[role="treeitem"]')?.focus();
      else if (expanded === 'true') item.querySelector<HTMLElement>('[role="group"] [role="treeitem"]')?.focus();
      break;
    }
  }
}
