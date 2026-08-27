import { useState, useRef, useCallback, useEffect } from 'react';

export function useDragUpload(
  mobile: boolean,
): {
  globalDrag: boolean;
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const [globalDrag, setGlobalDrag] = useState(false);
  const dragCounterRef = useRef(0);

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

  const onDrop = useCallback((e: React.DragEvent) => {
    if (mobile) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setGlobalDrag(false);
  }, [mobile]);

  useEffect(() => {
    const reset = () => { dragCounterRef.current = 0; setGlobalDrag(false); };
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset, true);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset, true);
    };
  }, []);

  return {
    globalDrag,
    dragHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
  };
}
