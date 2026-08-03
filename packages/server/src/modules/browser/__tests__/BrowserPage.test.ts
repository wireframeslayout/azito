import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserPage } from '../BrowserPage';

// dispatchInput requires a live CDP session; we inject a fake `page` + `cdp`
// directly (bracket-notation cast) rather than launching a real browser,
// matching the lightweight style of the existing manager tests.
function createPageWithFakeUnderlying() {
  const rawPage = {
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    setViewportSize: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
  };
  const page = new BrowserPage(rawPage as never);
  const send = vi.fn(async () => ({}));
  (page as unknown as { cdp: unknown }).cdp = { send };
  return { page, rawPage, send };
}

describe('BrowserPage.dispatchInput', () => {
  it('calls goBack on back', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'back' });
    expect(rawPage.goBack).toHaveBeenCalled();
  });

  it('calls goForward on forward', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'forward' });
    expect(rawPage.goForward).toHaveBeenCalled();
  });

  it('calls reload on reload', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'reload' });
    expect(rawPage.reload).toHaveBeenCalled();
  });

  it('clamps and rounds viewport size on resize', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'resize', width: 5000, height: 100 });
    expect(rawPage.setViewportSize).toHaveBeenCalledWith({ width: 3840, height: 240 });
  });

  it('rounds valid viewport size on resize', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'resize', width: 1024.6, height: 720.4 });
    expect(rawPage.setViewportSize).toHaveBeenCalledWith({ width: 1025, height: 720 });
  });

  // Regression: navigating to a localhost/private-network URL used to be
  // silently blocked by isAllowedUrl's host allowlist. Previewing a dev
  // server running on the same machine/network is this feature's whole
  // point, so localhost must reach page.goto.
  it('calls goto for a localhost navigate target', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'navigate', url: 'http://localhost:5173' });
    expect(rawPage.goto).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('calls goto for an RFC1918 private-network navigate target', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'navigate', url: 'http://192.168.1.10' });
    expect(rawPage.goto).toHaveBeenCalledWith('http://192.168.1.10');
  });

  it('blocks navigate to the cloud metadata link-local address', async () => {
    const { page, rawPage } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'navigate', url: 'http://169.254.169.254/latest/meta-data' });
    expect(rawPage.goto).not.toHaveBeenCalled();
  });

  it('sends Page.stopLoading on stopLoading', async () => {
    const { page, send } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'stopLoading' });
    expect(send).toHaveBeenCalledWith('Page.stopLoading');
  });

  it('sends Input.imeSetComposition with the given text and selection', async () => {
    const { page, send } = createPageWithFakeUnderlying();
    await page.dispatchInput({ type: 'composition', text: 'あい', selectionStart: 1, selectionEnd: 2 });
    expect(send).toHaveBeenCalledWith('Input.imeSetComposition', {
      text: 'あい',
      selectionStart: 1,
      selectionEnd: 2,
    });
  });

  it('falls back to text.length for non-finite selection values', async () => {
    const { page, send } = createPageWithFakeUnderlying();
    await page.dispatchInput({
      type: 'composition',
      text: 'あいう',
      selectionStart: NaN,
      selectionEnd: Infinity,
    });
    expect(send).toHaveBeenCalledWith('Input.imeSetComposition', {
      text: 'あいう',
      selectionStart: 3,
      selectionEnd: 3,
    });
  });
});

// start() drives Page.enable/getFrameTree and wires the frameStartedLoading/
// frameStoppedLoading listeners, so — unlike the dispatchInput/getCursorAt
// suites above, which inject a fake `cdp` after construction — these tests
// need a fake `page`/`context`/`cdp` that start() can actually run against
// (screencast + Target.getTargetInfo calls fall through to the generic {}
// default below since this suite doesn't care about their results).
function createStartedPage(mainFrameId = 'main-frame-id', initialUrl = 'about:blank', initialTitle: string | null = null) {
  const cdpHandlers = new Map<string, ((params: unknown) => void)[]>();
  // Mutable box so tests can change what Target.getTargetInfo returns before
  // triggering the framenavigated/frameStoppedLoading events that cause
  // refreshTitle() to re-read it.
  const titleBox = { current: initialTitle };
  const cdp = {
    on: vi.fn((event: string, handler: (params: unknown) => void) => {
      const list = cdpHandlers.get(event) ?? [];
      list.push(handler);
      cdpHandlers.set(event, list);
    }),
    send: vi.fn(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: mainFrameId } } };
      if (method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: 'target-1', title: titleBox.current ?? undefined } };
      }
      return {};
    }),
  };
  const mainFrame = { url: () => initialUrl };
  const rawPage = {
    on: vi.fn((event: string, handler: (frame: unknown) => void) => {
      const list = cdpHandlers.get(`page:${event}`) ?? [];
      list.push(handler);
      cdpHandlers.set(`page:${event}`, list);
    }),
    url: () => initialUrl,
    mainFrame: () => mainFrame,
    context: () => ({ newCDPSession: async () => cdp }),
  };
  const page = new BrowserPage(rawPage as never);
  return {
    page,
    setTitle: (title: string | null) => { titleBox.current = title; },
    emit: (event: string, params: unknown) => {
      for (const handler of cdpHandlers.get(event) ?? []) handler(params);
    },
    // Simulates page.on('framenavigated', ...) firing for the main frame —
    // the fake frame object passed to the handler must be === mainFrame()
    // for BrowserPage's own `frame !== page.mainFrame()` guard to pass.
    emitFrameNavigated: () => {
      for (const handler of cdpHandlers.get('page:framenavigated') ?? []) handler(mainFrame);
    },
  };
}

describe('BrowserPage.start', () => {
  // Regression: a freshly opened tab never fires 'framenavigated' (only
  // subsequent navigations do), so lastUrl stayed null forever for an
  // untouched tab — the client relies on receiving {type:'url'} (even for
  // about:blank) to know the tab is blank and show the start page.
  it('initializes lastUrl from page.url() immediately, including about:blank', async () => {
    const { page } = createStartedPage('main-frame-id', 'about:blank');
    await page.start();
    expect(page.lastUrl).toBe('about:blank');
  });

  it('initializes lastUrl from page.url() for a page opened directly to a real URL', async () => {
    const { page } = createStartedPage('main-frame-id', 'http://localhost:5173/');
    await page.start();
    expect(page.lastUrl).toBe('http://localhost:5173/');
  });
});

describe('BrowserPage UA normalization', () => {
  it('sends Emulation.setUserAgentOverride when UA contains HeadlessChrome', async () => {
    const cdpHandlers = new Map<string, ((params: unknown) => void)[]>();
    const sendCalls: { method: string; params?: unknown }[] = [];
    const cdp = {
      on: vi.fn((event: string, handler: (params: unknown) => void) => {
        const list = cdpHandlers.get(event) ?? [];
        list.push(handler);
        cdpHandlers.set(event, list);
      }),
      send: vi.fn(async (method: string, params?: unknown) => {
        sendCalls.push({ method, params });
        if (method === 'Browser.getVersion') {
          return { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.6723.0 Safari/537.36' };
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 't1' } };
        return {};
      }),
    };
    const rawPage = {
      on: vi.fn(),
      url: () => 'about:blank',
      mainFrame: () => ({ url: () => 'about:blank' }),
      context: () => ({ newCDPSession: async () => cdp }),
    };
    const page = new BrowserPage(rawPage as never);
    await page.start();

    const uaCall = sendCalls.find(c => c.method === 'Emulation.setUserAgentOverride');
    expect(uaCall).toBeDefined();
    const p = uaCall!.params as { userAgent: string; userAgentMetadata: { brands: { brand: string }[]; mobile: boolean } };
    expect(p.userAgent).not.toContain('HeadlessChrome');
    expect(p.userAgent).toContain('Chrome/130.0.6723.0');
    expect(p.userAgentMetadata.mobile).toBe(false);
    expect(p.userAgentMetadata.brands).toEqual(
      expect.arrayContaining([expect.objectContaining({ brand: 'Google Chrome', version: '130' })]),
    );
  });

  it('does not send Emulation.setUserAgentOverride when UA has no HeadlessChrome', async () => {
    const sendCalls: string[] = [];
    const cdp = {
      on: vi.fn(),
      send: vi.fn(async (method: string) => {
        sendCalls.push(method);
        if (method === 'Browser.getVersion') {
          return { userAgent: 'Mozilla/5.0 Chrome/130.0.6723.0 Safari/537.36' };
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 't1' } };
        return {};
      }),
    };
    const rawPage = {
      on: vi.fn(),
      url: () => 'about:blank',
      mainFrame: () => ({ url: () => 'about:blank' }),
      context: () => ({ newCDPSession: async () => cdp }),
    };
    const page = new BrowserPage(rawPage as never);
    await page.start();

    expect(sendCalls).not.toContain('Emulation.setUserAgentOverride');
  });
});

describe('BrowserPage title', () => {
  it('picks up the title from Target.getTargetInfo once start() completes', async () => {
    const { page } = createStartedPage('main-frame-id', 'http://localhost:5173/', 'Vite App');
    await page.start();
    expect(page.title).toBe('Vite App');
  });

  it('is null when Target.getTargetInfo has no title', async () => {
    const { page } = createStartedPage('main-frame-id', 'about:blank', null);
    await page.start();
    expect(page.title).toBeNull();
  });

  it('emits onTitle only when the title actually changes on framenavigated', async () => {
    const { page, setTitle, emitFrameNavigated } = createStartedPage('main-frame-id', 'http://localhost:5173/', 'Home');
    await page.start();

    const listener = vi.fn();
    page.onTitle(listener);

    // Re-navigate with a different title: should emit.
    setTitle('About');
    emitFrameNavigated();
    await vi.waitFor(() => expect(page.title).toBe('About'));
    expect(listener).toHaveBeenCalledWith('About');

    // Re-navigate with the same title: must not emit again.
    listener.mockClear();
    emitFrameNavigated();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits onTitle when the title changes on frameStoppedLoading for the main frame', async () => {
    const { page, setTitle, emit } = createStartedPage('main-frame-id', 'http://localhost:5173/', 'Loading…');
    await page.start();

    const listener = vi.fn();
    page.onTitle(listener);

    setTitle('Loaded Page');
    emit('Page.frameStoppedLoading', { frameId: 'main-frame-id' });
    await vi.waitFor(() => expect(page.title).toBe('Loaded Page'));
    expect(listener).toHaveBeenCalledWith('Loaded Page');
  });

  it('ignores frameStoppedLoading for a non-main frame', async () => {
    const { page, setTitle, emit } = createStartedPage('main-frame-id', 'http://localhost:5173/', 'Home');
    await page.start();

    const listener = vi.fn();
    page.onTitle(listener);

    setTitle('Iframe changed this?');
    emit('Page.frameStoppedLoading', { frameId: 'iframe-id' });
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
    expect(page.title).toBe('Home');
  });

  // Regression: a title-only change after load (SPA route change, unread
  // count badge, etc.) never fires framenavigated or frameStoppedLoading, so
  // without Target.targetInfoChanged the title would be stuck forever.
  it('updates and emits the title from a bare Target.targetInfoChanged for its own targetId, with no navigation/load event', async () => {
    const { page, emit } = createStartedPage('main-frame-id', 'http://localhost:5173/', 'Home');
    await page.start();
    expect(page.title).toBe('Home');

    const listener = vi.fn();
    page.onTitle(listener);

    emit('Target.targetInfoChanged', { targetInfo: { targetId: 'target-1', title: 'Home (3)' } });

    expect(page.title).toBe('Home (3)');
    expect(listener).toHaveBeenCalledWith('Home (3)');
  });

  it('ignores Target.targetInfoChanged for a different targetId', async () => {
    const { page, emit } = createStartedPage('main-frame-id', 'http://localhost:5173/', 'Home');
    await page.start();

    const listener = vi.fn();
    page.onTitle(listener);

    emit('Target.targetInfoChanged', { targetInfo: { targetId: 'some-other-target', title: 'Unrelated' } });

    expect(listener).not.toHaveBeenCalled();
    expect(page.title).toBe('Home');
  });
});

describe('BrowserPage loading state', () => {
  it('is false before any frame events arrive', async () => {
    const { page } = createStartedPage();
    await page.start();
    expect(page.loading).toBe(false);
  });

  it('sets loading true/false for the main frame and emits onLoading', async () => {
    const { page, emit } = createStartedPage('main-frame-id');
    await page.start();

    const listener = vi.fn();
    page.onLoading(listener);

    emit('Page.frameStartedLoading', { frameId: 'main-frame-id' });
    expect(page.loading).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);

    emit('Page.frameStoppedLoading', { frameId: 'main-frame-id' });
    expect(page.loading).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it('ignores frameStartedLoading/frameStoppedLoading for a non-main frame (e.g. an iframe)', async () => {
    const { page, emit } = createStartedPage('main-frame-id');
    await page.start();

    const listener = vi.fn();
    page.onLoading(listener);

    emit('Page.frameStartedLoading', { frameId: 'iframe-id' });
    expect(page.loading).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('BrowserPage.getCursorAt', () => {
  it('returns default when no cdp session is attached', async () => {
    const page = new BrowserPage({} as never);
    await expect(page.getCursorAt(10, 20)).resolves.toBe('default');
  });

  it('returns the evaluated cursor value from cdp', async () => {
    const page = new BrowserPage({} as never);
    const send = vi.fn(async () => ({ result: { value: 'pointer' } }));
    (page as unknown as { cdp: unknown }).cdp = { send };

    const cursor = await page.getCursorAt(15, 25);

    expect(cursor).toBe('pointer');
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
      returnByValue: true,
      expression: expect.stringContaining('document.elementFromPoint(15, 25)'),
    }));
  });

  it('falls back to default when cdp.send rejects', async () => {
    const page = new BrowserPage({} as never);
    const send = vi.fn(async () => { throw new Error('boom'); });
    (page as unknown as { cdp: unknown }).cdp = { send };

    await expect(page.getCursorAt(1, 1)).resolves.toBe('default');
  });

  it('falls back to default when the evaluated value is not a string', async () => {
    const page = new BrowserPage({} as never);
    const send = vi.fn(async () => ({ result: { value: undefined } }));
    (page as unknown as { cdp: unknown }).cdp = { send };

    await expect(page.getCursorAt(1, 1)).resolves.toBe('default');
  });

  it('embeds coordinates as forced numbers, not raw strings', async () => {
    const page = new BrowserPage({} as never);
    const send = vi.fn(async () => ({ result: { value: 'default' } }));
    (page as unknown as { cdp: unknown }).cdp = { send };

    // A non-numeric-looking input still resolves via Number() coercion; NaN
    // short-circuits before reaching cdp.send.
    await page.getCursorAt(Number('not-a-number'), 5);

    expect(send).not.toHaveBeenCalled();
  });
});

// #401（キーボードトグル導入）までの暫定対応。isFocusedElementEditable() は
// Runtime.evaluate 前に100msの待ちを入れるため、フェイクタイマーで即座に進める。
describe('BrowserPage.isFocusedElementEditable', () => {
  it('returns false when no cdp session is attached', async () => {
    const page = new BrowserPage({} as never);
    await expect(page.isFocusedElementEditable()).resolves.toBe(false);
  });

  it('returns true when Runtime.evaluate reports an editable activeElement', async () => {
    vi.useFakeTimers();
    try {
      const page = new BrowserPage({} as never);
      const send = vi.fn(async () => ({ result: { value: true } }));
      (page as unknown as { cdp: unknown }).cdp = { send };

      const promise = page.isFocusedElementEditable();
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe(true);
      expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
        returnByValue: true,
        expression: expect.stringContaining('document.activeElement'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when Runtime.evaluate reports a non-editable activeElement', async () => {
    vi.useFakeTimers();
    try {
      const page = new BrowserPage({} as never);
      const send = vi.fn(async () => ({ result: { value: false } }));
      (page as unknown as { cdp: unknown }).cdp = { send };

      const promise = page.isFocusedElementEditable();
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to false when cdp.send rejects', async () => {
    vi.useFakeTimers();
    try {
      const page = new BrowserPage({} as never);
      const send = vi.fn(async () => { throw new Error('boom'); });
      (page as unknown as { cdp: unknown }).cdp = { send };

      const promise = page.isFocusedElementEditable();
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to false when the evaluated value is not exactly true', async () => {
    vi.useFakeTimers();
    try {
      const page = new BrowserPage({} as never);
      const send = vi.fn(async () => ({ result: { value: 'true' } }));
      (page as unknown as { cdp: unknown }).cdp = { send };

      const promise = page.isFocusedElementEditable();
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BrowserPage dialog handling', () => {
  function createDialogPage() {
    const dialogHandlers: ((dialog: unknown) => void)[] = [];
    const rawPage = {
      on: vi.fn((event: string, handler: (arg: unknown) => void) => {
        if (event === 'dialog') dialogHandlers.push(handler);
      }),
      url: () => 'about:blank',
      mainFrame: () => ({ url: () => 'about:blank' }),
      context: () => ({
        newCDPSession: async () => ({
          on: vi.fn(),
          send: vi.fn(async (method: string) => {
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
            if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 't1' } };
            return {};
          }),
        }),
      }),
    };
    const page = new BrowserPage(rawPage as never);
    return {
      page,
      fireDialog: (dialog: { type: () => string; message: () => string; defaultValue: () => string; accept: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> }) => {
        for (const handler of dialogHandlers) handler(dialog);
      },
    };
  }

  function makePlaywrightDialog(dialogType: string, message = '', defaultValue = '') {
    return {
      type: () => dialogType,
      message: () => message,
      defaultValue: () => defaultValue,
      accept: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
    };
  }

  it('emits dialog event and resolves with respondToDialog(true)', async () => {
    const { page, fireDialog } = createDialogPage();
    await page.start();
    // Simulate at least one client so timeout is 30s
    page.incrementClient();

    const listener = vi.fn();
    page.onDialog(listener);

    const dialog = makePlaywrightDialog('confirm', 'Are you sure?');
    fireDialog(dialog);

    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener).toHaveBeenCalledWith({
      type: 'confirm',
      message: 'Are you sure?',
      defaultValue: '',
    });

    page.respondToDialog(true);

    await vi.waitFor(() => expect(dialog.accept).toHaveBeenCalled());
    expect(dialog.dismiss).not.toHaveBeenCalled();
  });

  it('calls dialog.dismiss when respondToDialog(false)', async () => {
    const { page, fireDialog } = createDialogPage();
    await page.start();
    page.incrementClient();

    const dialog = makePlaywrightDialog('confirm', 'Delete?');
    fireDialog(dialog);

    page.respondToDialog(false);

    await vi.waitFor(() => expect(dialog.dismiss).toHaveBeenCalled());
    expect(dialog.accept).not.toHaveBeenCalled();
  });

  it('passes text to dialog.accept for prompt type', async () => {
    const { page, fireDialog } = createDialogPage();
    await page.start();
    page.incrementClient();

    const dialog = makePlaywrightDialog('prompt', 'Enter name:', 'default');
    fireDialog(dialog);

    page.respondToDialog(true, 'John');

    await vi.waitFor(() => expect(dialog.accept).toHaveBeenCalledWith('John'));
  });

  it('auto-accepts alert when no clients are connected (immediate timeout)', async () => {
    const { page, fireDialog } = createDialogPage();
    await page.start();
    // clientCount is 0

    const dialog = makePlaywrightDialog('alert', 'Hello');
    fireDialog(dialog);

    await vi.waitFor(() => expect(dialog.accept).toHaveBeenCalled());
  });

  it('auto-dismisses prompt when no clients are connected', async () => {
    const { page, fireDialog } = createDialogPage();
    await page.start();

    const dialog = makePlaywrightDialog('prompt', 'Enter value:');
    fireDialog(dialog);

    await vi.waitFor(() => expect(dialog.dismiss).toHaveBeenCalled());
  });

  it('auto-accepts confirm on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { page, fireDialog } = createDialogPage();
      await page.start();
      page.incrementClient();

      const dialog = makePlaywrightDialog('confirm', 'Proceed?');
      fireDialog(dialog);

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(dialog.accept).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits dialog-dismissed after response', async () => {
    const { page, fireDialog } = createDialogPage();
    await page.start();
    page.incrementClient();

    const dismissedListener = vi.fn();
    page.onDialogDismissed(dismissedListener);

    const dialog = makePlaywrightDialog('alert', 'OK');
    fireDialog(dialog);

    page.respondToDialog(true);

    await vi.waitFor(() => expect(dismissedListener).toHaveBeenCalled());
  });
});

describe('BrowserPage filechooser handling', () => {
  function createFileChooserPage() {
    const filechooserHandlers: ((chooser: unknown) => void)[] = [];
    const rawPage = {
      on: vi.fn((event: string, handler: (arg: unknown) => void) => {
        if (event === 'filechooser') filechooserHandlers.push(handler);
      }),
      url: () => 'about:blank',
      mainFrame: () => ({ url: () => 'about:blank' }),
      context: () => ({
        newCDPSession: async () => ({
          on: vi.fn(),
          send: vi.fn(async (method: string) => {
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
            if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 't1' } };
            return {};
          }),
        }),
      }),
    };
    const page = new BrowserPage(rawPage as never);
    return {
      page,
      fireFileChooser: (chooser: { isMultiple: () => boolean; setFiles: ReturnType<typeof vi.fn> }) => {
        for (const handler of filechooserHandlers) handler(chooser);
      },
    };
  }

  function makePlaywrightFileChooser(multiple = false) {
    return {
      isMultiple: () => multiple,
      setFiles: vi.fn(),
    };
  }

  it('emits filechooser event and resolves with respondToFileChooser', async () => {
    const { page, fireFileChooser } = createFileChooserPage();
    await page.start();
    page.incrementClient();

    const listener = vi.fn();
    page.onFileChooser(listener);

    const chooser = makePlaywrightFileChooser(true);
    fireFileChooser(chooser);

    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener).toHaveBeenCalledWith({ multiple: true });

    const files = [{ name: 'test.png', mimeType: 'image/png', base64: 'aGVsbG8=' }];
    page.respondToFileChooser(files);

    await vi.waitFor(() => expect(chooser.setFiles).toHaveBeenCalled());
    const arg = chooser.setFiles.mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0].name).toBe('test.png');
    expect(arg[0].mimeType).toBe('image/png');
    expect(Buffer.isBuffer(arg[0].buffer)).toBe(true);
  });

  it('sets empty files immediately when no clients', async () => {
    const { page, fireFileChooser } = createFileChooserPage();
    await page.start();

    const chooser = makePlaywrightFileChooser();
    fireFileChooser(chooser);

    await vi.waitFor(() => expect(chooser.setFiles).toHaveBeenCalled());
    expect(chooser.setFiles).toHaveBeenCalledWith([]);
  });

  it('sets empty files on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { page, fireFileChooser } = createFileChooserPage();
      await page.start();
      page.incrementClient();

      const chooser = makePlaywrightFileChooser();
      fireFileChooser(chooser);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(chooser.setFiles).toHaveBeenCalled());
      expect(chooser.setFiles).toHaveBeenCalledWith([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets empty files when all clients leave', async () => {
    const { page, fireFileChooser } = createFileChooserPage();
    await page.start();
    page.incrementClient();

    const chooser = makePlaywrightFileChooser();
    fireFileChooser(chooser);

    page.decrementClient();

    await vi.waitFor(() => expect(chooser.setFiles).toHaveBeenCalled());
    expect(chooser.setFiles).toHaveBeenCalledWith([]);
  });

  it('emits filechooser-dismissed after response', async () => {
    const { page, fireFileChooser } = createFileChooserPage();
    await page.start();
    page.incrementClient();

    const dismissedListener = vi.fn();
    page.onFileChooserDismissed(dismissedListener);

    const chooser = makePlaywrightFileChooser();
    fireFileChooser(chooser);

    page.respondToFileChooser([]);

    await vi.waitFor(() => expect(dismissedListener).toHaveBeenCalled());
  });
});

describe('BrowserPage auth handling', () => {
  function createAuthPage() {
    const cdpHandlers = new Map<string, ((params: unknown) => void)[]>();
    const sendCalls: { method: string; params?: unknown }[] = [];
    const cdp = {
      on: vi.fn((event: string, handler: (params: unknown) => void) => {
        const list = cdpHandlers.get(event) ?? [];
        list.push(handler);
        cdpHandlers.set(event, list);
      }),
      send: vi.fn(async (method: string, params?: unknown) => {
        sendCalls.push({ method, params });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 't1' } };
        return {};
      }),
    };
    const rawPage = {
      on: vi.fn(),
      url: () => 'about:blank',
      mainFrame: () => ({ url: () => 'about:blank' }),
      context: () => ({ newCDPSession: async () => cdp }),
    };
    const page = new BrowserPage(rawPage as never);
    return {
      page,
      sendCalls,
      fireAuthRequired: (requestId: string, origin = 'https://example.com') => {
        for (const handler of cdpHandlers.get('Fetch.authRequired') ?? []) {
          handler({ requestId, authChallenge: { origin } });
        }
      },
      fireRequestPaused: (requestId: string) => {
        for (const handler of cdpHandlers.get('Fetch.requestPaused') ?? []) {
          handler({ requestId });
        }
      },
    };
  }

  it('sends Fetch.enable with handleAuthRequests: true on start', async () => {
    const { page, sendCalls } = createAuthPage();
    await page.start();
    const fetchEnable = sendCalls.find(c => c.method === 'Fetch.enable');
    expect(fetchEnable).toBeDefined();
    expect(fetchEnable!.params).toEqual({ handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  });

  it('calls Fetch.continueRequest on Fetch.requestPaused', async () => {
    const { page, sendCalls, fireRequestPaused } = createAuthPage();
    await page.start();

    fireRequestPaused('req-123');
    await vi.waitFor(() => {
      const continueReq = sendCalls.find(c => c.method === 'Fetch.continueRequest');
      expect(continueReq).toBeDefined();
      expect(continueReq!.params).toEqual({ requestId: 'req-123' });
    });
  });

  it('sends ProvideCredentials when respondToAuth is called', async () => {
    const { page, sendCalls, fireAuthRequired } = createAuthPage();
    await page.start();
    page.incrementClient();

    const listener = vi.fn();
    page.onAuth(listener);

    fireAuthRequired('req-auth-1', 'https://secure.example.com');

    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener).toHaveBeenCalledWith({ origin: 'https://secure.example.com' });

    page.respondToAuth('admin', 's3cret');

    await vi.waitFor(() => {
      const call = sendCalls.find(c => c.method === 'Fetch.continueWithAuth');
      expect(call).toBeDefined();
      expect(call!.params).toEqual({
        requestId: 'req-auth-1',
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: 'admin',
          password: 's3cret',
        },
      });
    });
  });

  it('sends CancelAuth when cancelAuth is called', async () => {
    const { page, sendCalls, fireAuthRequired } = createAuthPage();
    await page.start();
    page.incrementClient();

    fireAuthRequired('req-auth-2');

    page.cancelAuth();

    await vi.waitFor(() => {
      const call = sendCalls.find(c => c.method === 'Fetch.continueWithAuth');
      expect(call).toBeDefined();
      expect(call!.params).toEqual({
        requestId: 'req-auth-2',
        authChallengeResponse: { response: 'CancelAuth' },
      });
    });
  });

  it('auto-cancels auth when no clients are connected', async () => {
    const { page, sendCalls, fireAuthRequired } = createAuthPage();
    await page.start();

    fireAuthRequired('req-auth-3');

    await vi.waitFor(() => {
      const call = sendCalls.find(c => c.method === 'Fetch.continueWithAuth');
      expect(call).toBeDefined();
      expect(call!.params).toEqual({
        requestId: 'req-auth-3',
        authChallengeResponse: { response: 'CancelAuth' },
      });
    });
  });

  it('auto-cancels auth on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { page, sendCalls, fireAuthRequired } = createAuthPage();
      await page.start();
      page.incrementClient();

      fireAuthRequired('req-auth-4');

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        const call = sendCalls.find(c => c.method === 'Fetch.continueWithAuth');
        expect(call).toBeDefined();
        expect(call!.params).toEqual({
          requestId: 'req-auth-4',
          authChallengeResponse: { response: 'CancelAuth' },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits auth-dismissed after response', async () => {
    const { page, fireAuthRequired } = createAuthPage();
    await page.start();
    page.incrementClient();

    const dismissedListener = vi.fn();
    page.onAuthDismissed(dismissedListener);

    fireAuthRequired('req-auth-5');

    page.respondToAuth('user', 'pass');

    await vi.waitFor(() => expect(dismissedListener).toHaveBeenCalled());
  });
});
