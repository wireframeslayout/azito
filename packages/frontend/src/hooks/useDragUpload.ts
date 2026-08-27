import { useRef, useCallback, useEffect } from 'react';

export function useDragUpload(
  mobile: boolean,
): {
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const dragCounterRef = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (mobile) return;
    e.preventDefault();
    dragCounterRef.current++;
  }, [mobile]);

  const onDragLeave = useCallback(() => {
    if (mobile) return;
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
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
  }, [mobile]);

  useEffect(() => {
    const reset = () => { dragCounterRef.current = 0; };
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset, true);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset, true);
    };
  }, []);

  return {
    dragHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
  };
}
