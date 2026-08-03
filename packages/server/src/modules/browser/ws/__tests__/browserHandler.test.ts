import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { handleBrowserConnection } from '../browserHandler';
import type { BrowserSessionManager } from '../../BrowserSessionManager';

// Minimal fake satisfying the subset of the 'ws' WebSocket API this handler
// uses: on('message'|'close'), send(), readyState/OPEN, close().
class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeFakePage() {
  return {
    lastFrame: null,
    lastUrl: null,
    loading: false,
    incrementClient: vi.fn(),
    decrementClient: vi.fn(),
    onFrame: vi.fn(() => () => {}),
    onUrl: vi.fn(() => () => {}),
    onLoading: vi.fn(() => () => {}),
    onPeerCursor: vi.fn(() => () => {}),
    onPeerLeft: vi.fn(() => () => {}),
    emitPeerLeft: vi.fn(),
    emitPeerCursor: vi.fn(),
    getCursorAt: vi.fn(async () => 'default'),
    isFocusedElementEditable: vi.fn(async () => false),
    dispatchInput: vi.fn(async (_input: unknown) => {}),
    onDialog: vi.fn(() => () => {}),
    onDialogDismissed: vi.fn(() => () => {}),
    respondToDialog: vi.fn(),
    onFileChooser: vi.fn(() => () => {}),
    onFileChooserDismissed: vi.fn(() => () => {}),
    respondToFileChooser: vi.fn(),
    onAuth: vi.fn(() => () => {}),
    onAuthDismissed: vi.fn(() => () => {}),
    respondToAuth: vi.fn(),
    cancelAuth: vi.fn(),
  };
}

function makeFakeSession(page: ReturnType<typeof makeFakePage>) {
  return {
    checkGroupIdle: vi.fn(),
    incrementGroupClient: vi.fn(),
    decrementGroupClient: vi.fn(),
    listGroupTabs: vi.fn(() => []),
    onGroupTabsChanged: vi.fn(() => () => {}),
    getOrCreatePage: vi.fn(async () => page),
    closePage: vi.fn(async () => {}),
  };
}

describe('handleBrowserConnection — message buffering before the page is ready', () => {
  // Regression: the client sends its initial `resize` immediately after the
  // WS opens, well before browserSessionManager.getOrCreate()/
  // session.getOrCreatePage() resolve. The old code only registered
  // ws.on('message', ...) inside that resolved .then(), so this early
  // resize was silently dropped — leaving the remote viewport at its
  // default 1024x720 (visible as a stretched/wrong aspect ratio) until an
  // unrelated resize happened to land after the handler was attached.
  it('delivers a resize sent before getOrCreate() resolves to page.dispatchInput once the page is ready', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);
    const ready = deferred<typeof session>();

    const manager = {
      getOrCreate: vi.fn(() => ready.promise),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    // Sent while getOrCreate() is still pending — must not be lost.
    ws.emit('message', JSON.stringify({ type: 'resize', width: 800, height: 600 }));
    expect(page.dispatchInput).not.toHaveBeenCalled();

    ready.resolve(session);
    await vi.waitFor(() => {
      expect(page.dispatchInput).toHaveBeenCalledTimes(1);
    });

    expect(page.dispatchInput).toHaveBeenCalledWith({ type: 'resize', width: 800, height: 600 });
  });

  it('preserves arrival order across buffered and post-ready messages', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);
    const ready = deferred<typeof session>();

    const manager = {
      getOrCreate: vi.fn(() => ready.promise),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    ws.emit('message', JSON.stringify({ type: 'resize', width: 800, height: 600 }));
    ws.emit('message', JSON.stringify({ type: 'reload' }));

    ready.resolve(session);
    await vi.waitFor(() => {
      expect(page.dispatchInput).toHaveBeenCalledTimes(2);
    });

    expect(page.dispatchInput.mock.calls[0][0]).toEqual({ type: 'resize', width: 800, height: 600 });
    expect(page.dispatchInput.mock.calls[1][0]).toEqual({ type: 'reload' });

    // Messages arriving after the page is ready go straight through too.
    ws.emit('message', JSON.stringify({ type: 'back' }));
    await vi.waitFor(() => {
      expect(page.dispatchInput).toHaveBeenCalledTimes(3);
    });
    expect(page.dispatchInput.mock.calls[2][0]).toEqual({ type: 'back' });
  });

  it('discards the buffer instead of delivering it if the socket closes before the page is ready', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);
    const ready = deferred<typeof session>();

    const manager = {
      getOrCreate: vi.fn(() => ready.promise),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    ws.emit('message', JSON.stringify({ type: 'resize', width: 800, height: 600 }));
    ws.close();

    ready.resolve(session);
    // Give the resolved chain a chance to run; since `closed` is true it
    // takes the early-return branch and must not process the buffer.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(page.dispatchInput).not.toHaveBeenCalled();
  });
});

describe('handleBrowserConnection — IME composition cleanup on disconnect', () => {
  // Regression: a WS drop, tab switch, or unmount mid-composition never
  // fires compositionend, so without explicit cleanup the remote page would
  // be left with a stray unconfirmed preedit forever (visible to other
  // viewers and interfering with subsequent input).
  it('sends an empty composition to dispatchInput on close when a composition was left pending', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    ws.emit('message', JSON.stringify({ type: 'composition', text: 'あい', selectionStart: 2, selectionEnd: 2 }));
    await vi.waitFor(() => {
      expect(page.dispatchInput).toHaveBeenCalledTimes(1);
    });

    ws.close();

    expect(page.dispatchInput).toHaveBeenCalledTimes(2);
    expect(page.dispatchInput).toHaveBeenLastCalledWith({
      type: 'composition', text: '', selectionStart: 0, selectionEnd: 0,
    });
  });

  it('does not send a cleanup composition on close once insertText has confirmed it', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    ws.emit('message', JSON.stringify({ type: 'composition', text: 'あい', selectionStart: 2, selectionEnd: 2 }));
    ws.emit('message', JSON.stringify({ type: 'insertText', text: 'あい' }));
    await vi.waitFor(() => {
      expect(page.dispatchInput).toHaveBeenCalledTimes(2);
    });

    ws.close();

    expect(page.dispatchInput).toHaveBeenCalledTimes(2);
  });
});

// #401（キーボードトグル導入）までの暫定対応: タッチのタップ時にクライアントが
// 送る {type:'queryEditable'} は dispatchInput へ流さず、page.isFocusedElementEditable()
// の結果を {type:'editable'} として直接応答する。
describe('handleBrowserConnection — queryEditable (#401 keyboard-toggle interim)', () => {
  it('responds with {type:"editable"} reflecting page.isFocusedElementEditable(), without calling dispatchInput', async () => {
    const page = makeFakePage();
    page.isFocusedElementEditable.mockResolvedValue(true);
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    ws.emit('message', JSON.stringify({ type: 'queryEditable', requestId: 7 }));

    await vi.waitFor(() => {
      expect(page.isFocusedElementEditable).toHaveBeenCalledTimes(1);
    });
    expect(page.dispatchInput).not.toHaveBeenCalled();

    const editableMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'editable');
    expect(editableMsg).toEqual({ type: 'editable', editable: true, requestId: 7 });
  });

  it('responds with editable:false when isFocusedElementEditable() resolves false', async () => {
    const page = makeFakePage();
    page.isFocusedElementEditable.mockResolvedValue(false);
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    ws.emit('message', JSON.stringify({ type: 'queryEditable', requestId: 3 }));

    await vi.waitFor(() => {
      expect(page.isFocusedElementEditable).toHaveBeenCalledTimes(1);
    });

    const editableMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'editable');
    expect(editableMsg).toEqual({ type: 'editable', editable: false, requestId: 3 });
  });

  it('discards a stale response once a newer queryEditable has arrived on the same connection (latest-only)', async () => {
    const page = makeFakePage();
    const deferredEditable = deferred<boolean>();
    page.isFocusedElementEditable
      .mockImplementationOnce(() => deferredEditable.promise)
      .mockImplementationOnce(async () => true);
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    // First tap's query is still pending (resolves later); a second tap's
    // query is sent (and resolves) before it. Only the second (latest)
    // request's answer must ever reach the client — the first's, once
    // superseded, is discarded even though its evaluation still ran.
    ws.emit('message', JSON.stringify({ type: 'queryEditable', requestId: 1 }));
    ws.emit('message', JSON.stringify({ type: 'queryEditable', requestId: 2 }));

    await vi.waitFor(() => {
      const msg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'editable' && m.requestId === 2);
      expect(msg).toEqual({ type: 'editable', editable: true, requestId: 2 });
    });

    deferredEditable.resolve(false);
    // Give the (now-stale) first request's .then() a chance to run; its
    // response must never be sent.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const staleMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'editable' && m.requestId === 1);
    expect(staleMsg).toBeUndefined();
  });

  it('ignores queryEditable with a non-integer requestId', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    for (const badRequestId of [1.5, NaN, Infinity, '1' as unknown as number, null as unknown as number]) {
      ws.emit('message', JSON.stringify({ type: 'queryEditable', requestId: badRequestId }));
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(page.isFocusedElementEditable).not.toHaveBeenCalled();
    expect(ws.sent.map((s) => JSON.parse(s)).some((m) => m.type === 'editable')).toBe(false);
  });
});

describe('handleBrowserConnection — filechooser forwarding', () => {
  it('forwards filechooser event from page to WS client', async () => {
    const page = makeFakePage();
    let capturedListener: ((info: { multiple: boolean }) => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page.onFileChooser as any).mockImplementation((listener: (info: { multiple: boolean }) => void) => {
      capturedListener = listener;
      return () => {};
    });
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    await vi.waitFor(() => expect(capturedListener).not.toBeNull());

    capturedListener!({ multiple: true });

    const fcMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'filechooser');
    expect(fcMsg).toEqual({ type: 'filechooser', multiple: true });
  });

  it('forwards filechooser-response from WS to page.respondToFileChooser', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    const files = [{ name: 'img.png', mimeType: 'image/png', base64: 'abc123' }];
    ws.emit('message', JSON.stringify({ type: 'filechooser-response', files }));

    await vi.waitFor(() => {
      expect(page.respondToFileChooser).toHaveBeenCalledWith(files);
    });
    expect(page.dispatchInput).not.toHaveBeenCalled();
  });

  it('sends empty array when filechooser-response has no files field', async () => {
    const page = makeFakePage();
    const session = makeFakeSession(page);

    const manager = {
      getOrCreate: vi.fn(async () => session),
      restoreGroupIfEmpty: vi.fn(async () => {}),
      checkIdle: vi.fn(),
    };

    const ws = new FakeWebSocket();

    handleBrowserConnection(
      ws as unknown as WebSocket,
      manager as unknown as BrowserSessionManager,
      'test-server',
      'group-a',
      'tab-a',
    );

    ws.emit('message', JSON.stringify({ type: 'filechooser-response' }));

    await vi.waitFor(() => {
      expect(page.respondToFileChooser).toHaveBeenCalledWith([]);
    });
  });
});
