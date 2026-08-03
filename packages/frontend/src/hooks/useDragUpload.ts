import { useState, useRef, useCallback } from 'react';
import { uploadAndGetUrl } from '../components/StoragePanel';
import type { SidebarMode } from '../pages/workspace/types';

export function useDragUpload(
  projectId: number | null,
  sidebarMode: SidebarMode,
  showToast: (msg: string) => void,
  mobile: boolean,
): {
  globalDrag: boolean;
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => Promise<void>;
  };
} {
  const [globalDrag, setGlobalDrag] = useState(false);
  const dragCounterRef = useRef(0);

  // A tab being dragged between panes (TabBar/MiniTabBar's HTML5 drag-and-drop, see
  // onTabDragStart) shares the same browser drag-and-drop machinery as a file drop, and
  // bubbles the same dragenter event up to this container. Without this check, dragging a
  // tab would also flip on the full-screen "Drop files to upload to Storage" overlay
  // (WorkspaceLayout, zIndex 200), which visually covers the pane drop-zone highlighting a
  // tab drag is supposed to show. This is the *only* thing gated on the marker — every
  // other part of the enter/leave/over/drop event machinery (preventDefault,
  // dragCounterRef increment/decrement, the drop upload flow) is untouched, so an ordinary
  // file drag (from the OS, or from some other in-page draggable) behaves exactly as
  // before. `types` (not `getData`, which only ever resolves on the `drop` event itself)
  // is the only thing readable mid-drag.
  const isTabDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('application/x-azito-tab');

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (mobile) return;
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1 && !isTabDrag(e)) setGlobalDrag(true);
  }, [mobile]);

  const onDragLeave = useCallback(() => {
    if (mobile) return;
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setGlobalDrag(false);
    }
  }, [mobile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (mobile) return;
    e.preventDefault();
  }, [mobile]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    if (mobile) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setGlobalDrag(false);
    if (!projectId || sidebarMode === 'storage') return;
    const droppedFiles = Array.from(e.dataTransfer.files);
    for (const f of droppedFiles) {
      const url = await uploadAndGetUrl(projectId, f);
      if (url) {
        await navigator.clipboard.writeText(url).catch(() => {});
        showToast(`Uploaded ${f.name} — URL copied`);
      } else {
        showToast(`Failed to upload ${f.name}`);
      }
    }
  }, [mobile, projectId, sidebarMode, showToast]);

  return {
    globalDrag,
    dragHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
  };
}
