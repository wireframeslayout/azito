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
          else if (items[idx].dataset.parentTaskId) tree.querySelector<HTMLElement>(`[data-task-id="${items[idx].dataset.parentTaskId}"]`)?.focus();
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
