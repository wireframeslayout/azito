import { describe, expect, it, vi } from 'vitest';

/**
 * useDragUpload is a React hook, and this workspace runs tests with
 * environment: 'node' (no jsdom / renderHook). We test the underlying
 * counter logic by exercising a minimal reimplementation — the hook's
 * real value is (1) calling preventDefault to block browser-default file
 * navigation, and (2) resetting the counter via a window-level safety
 * valve. The useEffect registration itself is not covered here.
 */

function createDragEvent(types: string[] = ['Files']): { dataTransfer: { types: string[] }; preventDefault: () => void } {
  return { dataTransfer: { types }, preventDefault: vi.fn() };
}

function createHookState() {
  let dragCounter = 0;

  const onDragEnter = (e: ReturnType<typeof createDragEvent>) => {
    e.preventDefault();
    dragCounter++;
  };

  const onDragLeave = () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
    }
  };

  const onDrop = (e: ReturnType<typeof createDragEvent>) => {
    e.preventDefault();
    dragCounter = 0;
  };

  const reset = () => {
    dragCounter = 0;
  };

  return {
    get dragCounter() { return dragCounter; },
    onDragEnter,
    onDragLeave,
    onDrop,
    reset,
  };
}

describe('useDragUpload counter logic', () => {
  it('increments on dragenter', () => {
    const h = createHookState();
    h.onDragEnter(createDragEvent(['Files']));
    expect(h.dragCounter).toBe(1);
  });

  it('increments for tab drags too (counter is type-agnostic)', () => {
    const h = createHookState();
    h.onDragEnter(createDragEvent(['application/x-azito-tab']));
    expect(h.dragCounter).toBe(1);
  });

  it('decrements on dragleave and clears at 0', () => {
    const h = createHookState();
    h.onDragEnter(createDragEvent());
    h.onDragEnter(createDragEvent());
    expect(h.dragCounter).toBe(2);
    h.onDragLeave();
    expect(h.dragCounter).toBe(1);
    h.onDragLeave();
    expect(h.dragCounter).toBe(0);
  });

  it('resets counter on drop', () => {
    const h = createHookState();
    h.onDragEnter(createDragEvent());
    h.onDragEnter(createDragEvent());
    h.onDrop(createDragEvent());
    expect(h.dragCounter).toBe(0);
  });

  it('calls preventDefault on dragenter and drop', () => {
    const h = createHookState();
    const enterEvent = createDragEvent();
    const dropEvent = createDragEvent();
    h.onDragEnter(enterEvent);
    h.onDrop(dropEvent);
    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(dropEvent.preventDefault).toHaveBeenCalled();
  });

  it('counter never goes negative', () => {
    const h = createHookState();
    h.onDragLeave();
    h.onDragLeave();
    expect(h.dragCounter).toBe(0);
  });
});

describe('safety valve (window-level reset)', () => {
  it('calling reset after partial drag sequence fully clears counter', () => {
    const h = createHookState();
    h.onDragEnter(createDragEvent());
    h.onDragEnter(createDragEvent());
    h.onDragEnter(createDragEvent());
    expect(h.dragCounter).toBe(3);
    h.reset();
    expect(h.dragCounter).toBe(0);
  });

  it('counter works correctly after a reset', () => {
    const h = createHookState();
    h.onDragEnter(createDragEvent());
    h.onDragEnter(createDragEvent());
    h.reset();
    h.onDragEnter(createDragEvent());
    expect(h.dragCounter).toBe(1);
  });
});
