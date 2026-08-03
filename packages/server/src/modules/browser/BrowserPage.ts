import type { Page, CDPSession } from 'playwright';
import { EventEmitter } from 'node:events';
import type { BrowserFrame, BrowserInput } from './BrowserInput';

export const DEFAULT_CHROME_MAJOR = '130';

// リンクローカルのみブロック（169.254.0.0/16: クラウドメタデータ 169.254.169.254 を
// 含む、および IPv6 リンクローカル fe80::/10）。本機能はシェルアクセスを持つ
// 自己ホスト型ツールであり厳格な SSRF 防御はスコープ外だが、誤アクセスの実害が
// 大きいメタデータ系リンクローカルだけは遮断する。loopback・RFC1918・localhost
// などは、サーバー上で動く開発画面をプレビューするという本機能の目的上、
// 意図的に許可する。
const LINK_LOCAL_PATTERNS = [
  /^169\.254\./,
  /^fe80:/i,
];

function isAllowedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return !LINK_LOCAL_PATTERNS.some(p => p.test(host));
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A single tab within a shared BrowserSession: owns the playwright Page + its
 * dedicated CDPSession, screencast streaming, and per-page peer/cursor state.
 * dispatchInput/back/forward/reload/navigate/resize all act on this page only
 * (never on other pages sharing the same persistent context).
 */
export type BrowserDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface BrowserDialogInfo {
  type: BrowserDialogType;
  message: string;
  defaultValue: string;
}

export interface FileChooserInfo {
  multiple: boolean;
}

export interface FileChooserFile {
  name: string;
  mimeType: string;
  base64: string;
}

export interface BrowserAuthInfo {
  origin: string;
}

const DIALOG_TIMEOUT_MS = 30_000;
const FILECHOOSER_TIMEOUT_MS = 60_000;

export class BrowserPage {
  private cdp: CDPSession | null = null;
  private emitter = new EventEmitter();
  private _lastFrame: BrowserFrame | null = null;
  private _lastUrl: string | null = null;
  private _clientCount = 0;
  private _targetId: string | null = null;
  private _mainFrameId: string | null = null;
  private _loading = false;
  private _title: string | null = null;

  constructor(private page: Page) {}

  get lastFrame(): BrowserFrame | null { return this._lastFrame; }
  get lastUrl(): string | null { return this._lastUrl; }
  get clientCount(): number { return this._clientCount; }
  get targetId(): string | null { return this._targetId; }
  get loading(): boolean { return this._loading; }
  get title(): string | null { return this._title; }

  incrementClient(): void { this._clientCount++; }
  decrementClient(): void {
    this._clientCount = Math.max(0, this._clientCount - 1);
    if (this._clientCount === 0) this.emitter.emit('all-clients-left');
  }

  async start(): Promise<void> {
    const page = this.page;

    // A freshly opened tab never fires 'framenavigated' (that only fires on
    // subsequent navigations) but is already sitting at about:blank — without
    // this, lastUrl stays null forever for an untouched tab, which the
    // client relies on (via the 'url' message) to know the tab is blank and
    // show the start page.
    this._lastUrl = page.url();

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      this._lastUrl = url;
      this.emitter.emit('url', url);
      this.refreshTitle().catch(() => {});
    });

    page.on('dialog', async (dialog) => {
      const dialogType = dialog.type() as BrowserDialogType;
      const info: BrowserDialogInfo = {
        type: dialogType,
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
      };
      this.emitter.emit('dialog', info);

      const timeoutMs = this._clientCount > 0 ? DIALOG_TIMEOUT_MS : 0;
      const defaultAccept = dialogType !== 'prompt';

      const response = await new Promise<{ accept: boolean; text?: string }>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const settle = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.emitter.off('dialog-response', onResponse);
          this.emitter.off('all-clients-left', settle);
          resolve({ accept: defaultAccept });
        };

        const onResponse = (res: { accept: boolean; text?: string }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.emitter.off('all-clients-left', settle);
          resolve(res);
        };

        this.emitter.once('dialog-response', onResponse);

        if (timeoutMs <= 0) {
          settle();
        } else {
          this.emitter.once('all-clients-left', settle);
          timer = setTimeout(settle, timeoutMs);
        }
      });

      this.emitter.emit('dialog-dismissed');

      if (response.accept) {
        await dialog.accept(response.text);
      } else {
        await dialog.dismiss();
      }
    });

    page.on('filechooser', async (chooser) => {
      const info: FileChooserInfo = { multiple: chooser.isMultiple() };
      this.emitter.emit('filechooser', info);

      const timeoutMs = this._clientCount > 0 ? FILECHOOSER_TIMEOUT_MS : 0;

      const response = await new Promise<{ files: FileChooserFile[] }>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const settle = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.emitter.off('filechooser-response', onResponse);
          this.emitter.off('all-clients-left', settle);
          resolve({ files: [] });
        };

        const onResponse = (res: { files: FileChooserFile[] }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.emitter.off('all-clients-left', settle);
          resolve(res);
        };

        this.emitter.once('filechooser-response', onResponse);

        if (timeoutMs <= 0) {
          settle();
        } else {
          this.emitter.once('all-clients-left', settle);
          timer = setTimeout(settle, timeoutMs);
        }
      });

      this.emitter.emit('filechooser-dismissed');

      try {
        chooser.setFiles(response.files.map(f => ({
          name: f.name,
          mimeType: f.mimeType,
          buffer: Buffer.from(f.base64, 'base64'),
        })));
      } catch {
        chooser.setFiles([]);
      }
    });

    this.cdp = await page.context().newCDPSession(page);
    const cdp = this.cdp;

    cdp.on('Fetch.requestPaused', (params: { requestId: string }) => {
      cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    });
    cdp.on('Fetch.authRequired', (params: {
      requestId: string;
      authChallenge: { origin?: string };
    }) => {
      this.handleAuthRequired(cdp, params);
    });
    await cdp.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });

    try {
      const ver = await cdp.send('Browser.getVersion') as { userAgent?: string };
      const rawUA = ver?.userAgent ?? '';
      if (rawUA.includes('HeadlessChrome')) {
        const normalizedUA = rawUA.replace(/HeadlessChrome\//g, 'Chrome/');
        const chromeMatch = normalizedUA.match(/Chrome\/([\d.]+)/);
        const chromeVersion = chromeMatch ? chromeMatch[1] : `${DEFAULT_CHROME_MAJOR}.0.0.0`;
        const majorVersion = chromeVersion.split('.')[0];
        await this.cdp.send('Emulation.setUserAgentOverride', {
          userAgent: normalizedUA,
          userAgentMetadata: {
            brands: [
              { brand: 'Chromium', version: majorVersion },
              { brand: 'Google Chrome', version: majorVersion },
              { brand: 'Not?A_Brand', version: '99' },
            ],
            fullVersionList: [
              { brand: 'Chromium', version: chromeVersion },
              { brand: 'Google Chrome', version: chromeVersion },
              { brand: 'Not?A_Brand', version: '99.0.0.0' },
            ],
            platform: 'Linux',
            platformVersion: '',
            architecture: 'x86',
            model: '',
            mobile: false,
          },
        });
      }
    } catch {
      // best-effort: proceed without UA override
    }

    // Page.enable is required for frameStartedLoading/frameStoppedLoading to
    // fire; the frame tree lookup then tells us which frameId is the main
    // frame, so loading state (and the events below) only tracks the tab's
    // top-level navigation, not iframes within it.
    await this.cdp.send('Page.enable');
    try {
      const frameTree = await this.cdp.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } };
      this._mainFrameId = frameTree?.frameTree?.frame?.id ?? null;
    } catch {
      this._mainFrameId = null;
    }

    this.cdp.on('Page.frameStartedLoading', (params: { frameId: string }) => {
      if (params.frameId !== this._mainFrameId) return;
      this._loading = true;
      this.emitter.emit('loading', true);
    });

    this.cdp.on('Page.frameStoppedLoading', (params: { frameId: string }) => {
      if (params.frameId !== this._mainFrameId) return;
      this._loading = false;
      this.emitter.emit('loading', false);
      this.refreshTitle().catch(() => {});
    });

    this.cdp.on('Page.screencastFrame', (params: { data: string; metadata: { deviceWidth: number; deviceHeight: number }; sessionId: number }) => {
      this.cdp!.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      const frame: BrowserFrame = {
        type: 'frame',
        data: params.data,
        cssW: params.metadata.deviceWidth,
        cssH: params.metadata.deviceHeight,
      };
      this._lastFrame = frame;
      this.emitter.emit('frame', frame);
    });

    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      everyNthFrame: 1,
    });

    try {
      const info = await this.cdp.send('Target.getTargetInfo') as { targetInfo?: { targetId?: string } };
      this._targetId = info?.targetInfo?.targetId ?? null;
    } catch {
      this._targetId = null;
    }

    // Target.targetInfoChanged fires whenever the page changes document.title
    // at runtime (SPA route changes, unread-count badges, etc.) — the
    // navigation/load-stop-triggered refreshTitle() below only catches the
    // title as of load completion, so without this a post-load title change
    // would be stuck forever. setDiscoverTargets is required for the event
    // to fire at all; both are best-effort (some environments/CDP versions
    // may not support target discovery), so refreshTitle() at
    // navigation/load-stop remains as a fallback.
    try {
      await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    } catch {
      // fall back to navigation/load-stop-triggered refreshTitle() only
    }
    this.cdp.on('Target.targetInfoChanged', (params: { targetInfo?: { targetId?: string; title?: string } }) => {
      const info = params?.targetInfo;
      if (!info || info.targetId !== this._targetId) return;
      this.applyTitle(info.title ?? null);
    });

    await this.refreshTitle();
  }

  // Re-reads the target's title via CDP and applies it (emitting 'title'
  // only if it changed). On failure (e.g. cdp not attached yet, target
  // gone), the previous title is kept rather than cleared — a transient CDP
  // error shouldn't blank out an otherwise-valid tab label.
  private async refreshTitle(): Promise<void> {
    if (!this.cdp) return;
    try {
      const info = await this.cdp.send('Target.getTargetInfo') as { targetInfo?: { title?: string } };
      this.applyTitle(info?.targetInfo?.title ?? null);
    } catch {
      // keep the previous title
    }
  }

  // Shared change-detection: only updates _title and emits 'title' when the
  // value actually changed, so listeners (BrowserSession's
  // group-tabs-changed re-broadcast) aren't triggered on every
  // navigation/load-stop/targetInfoChanged when the title is unchanged.
  private applyTitle(title: string | null): void {
    if (title === this._title) return;
    this._title = title;
    this.emitter.emit('title', title);
  }

  private async handleAuthRequired(cdp: CDPSession, params: {
    requestId: string;
    authChallenge: { origin?: string };
  }): Promise<void> {
    const { requestId } = params;
    const origin = params.authChallenge?.origin ?? '';
    const info: BrowserAuthInfo = { origin };
    this.emitter.emit('auth', info);

    const timeoutMs = this._clientCount > 0 ? DIALOG_TIMEOUT_MS : 0;

    const response = await new Promise<{ username: string; password: string } | { cancel: true }>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.emitter.off('auth-response', onResponse);
        this.emitter.off('all-clients-left', settle);
        resolve({ cancel: true });
      };

      const onResponse = (res: { username: string; password: string } | { cancel: true }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.emitter.off('all-clients-left', settle);
        resolve(res);
      };

      this.emitter.once('auth-response', onResponse);

      if (timeoutMs <= 0) {
        settle();
      } else {
        this.emitter.once('all-clients-left', settle);
        timer = setTimeout(settle, timeoutMs);
      }
    });

    this.emitter.emit('auth-dismissed');

    if ('cancel' in response) {
      await cdp.send('Fetch.continueWithAuth', {
        requestId,
        authChallengeResponse: { response: 'CancelAuth' },
      }).catch(() => {});
    } else {
      await cdp.send('Fetch.continueWithAuth', {
        requestId,
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: response.username,
          password: response.password,
        },
      }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this._lastFrame = null;
    this._loading = false;
    this._title = null;
    this.emitter.removeAllListeners();

    if (this.cdp) {
      try { await this.cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
      try { await this.cdp.detach(); } catch { /* ignore */ }
      this.cdp = null;
    }
    try { await this.page.close(); } catch { /* ignore */ }
  }

  onFrame(listener: (frame: BrowserFrame) => void): () => void {
    this.emitter.on('frame', listener);
    return () => { this.emitter.off('frame', listener); };
  }

  onUrl(listener: (url: string) => void): () => void {
    this.emitter.on('url', listener);
    return () => { this.emitter.off('url', listener); };
  }

  onLoading(listener: (loading: boolean) => void): () => void {
    this.emitter.on('loading', listener);
    return () => { this.emitter.off('loading', listener); };
  }

  onTitle(listener: (title: string | null) => void): () => void {
    this.emitter.on('title', listener);
    return () => { this.emitter.off('title', listener); };
  }

  onAuth(listener: (info: BrowserAuthInfo) => void): () => void {
    this.emitter.on('auth', listener);
    return () => { this.emitter.off('auth', listener); };
  }

  respondToAuth(username: string, password: string): void {
    this.emitter.emit('auth-response', { username, password });
  }

  cancelAuth(): void {
    this.emitter.emit('auth-response', { cancel: true });
  }

  onAuthDismissed(listener: () => void): () => void {
    this.emitter.on('auth-dismissed', listener);
    return () => { this.emitter.off('auth-dismissed', listener); };
  }

  onDialog(listener: (info: BrowserDialogInfo) => void): () => void {
    this.emitter.on('dialog', listener);
    return () => { this.emitter.off('dialog', listener); };
  }

  respondToDialog(accept: boolean, text?: string): void {
    this.emitter.emit('dialog-response', { accept, text });
  }

  onDialogDismissed(listener: () => void): () => void {
    this.emitter.on('dialog-dismissed', listener);
    return () => { this.emitter.off('dialog-dismissed', listener); };
  }

  onFileChooser(listener: (info: FileChooserInfo) => void): () => void {
    this.emitter.on('filechooser', listener);
    return () => { this.emitter.off('filechooser', listener); };
  }

  respondToFileChooser(files: FileChooserFile[]): void {
    this.emitter.emit('filechooser-response', { files });
  }

  onFileChooserDismissed(listener: () => void): () => void {
    this.emitter.on('filechooser-dismissed', listener);
    return () => { this.emitter.off('filechooser-dismissed', listener); };
  }

  emitPeerCursor(peer: { id: number; x: number; y: number }): void {
    this.emitter.emit('peer-cursor', peer);
  }

  onPeerCursor(listener: (peer: { id: number; x: number; y: number }) => void): () => void {
    this.emitter.on('peer-cursor', listener);
    return () => { this.emitter.off('peer-cursor', listener); };
  }

  emitPeerLeft(id: number): void {
    this.emitter.emit('peer-left', id);
  }

  onPeerLeft(listener: (id: number) => void): () => void {
    this.emitter.on('peer-left', listener);
    return () => { this.emitter.off('peer-left', listener); };
  }

  // ホバー先の実効カーソル（'text'/'pointer'/'default' 等）を返す。cdp 未接続・
  // 評価失敗時は例外を投げず 'default' にフォールバックする（呼び出し側の
  // 描画スロットルを止めないため）。
  async getCursorAt(x: number, y: number): Promise<string> {
    if (!this.cdp) return 'default';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return 'default';

    const expression = `(() => {
      const el = document.elementFromPoint(${nx}, ${ny});
      if (!el) return 'default';
      const style = getComputedStyle(el);
      const cursor = style.cursor;
      if (cursor === 'auto') {
        const tag = el.tagName;
        const textInputTypes = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
        const isTextField = (tag === 'INPUT' && textInputTypes.includes(String(el.type || '').toLowerCase()))
          || tag === 'TEXTAREA' || el.isContentEditable;
        if (isTextField) return 'text';
        const hasDirectText = Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && n.textContent && n.textContent.trim().length > 0
        );
        return hasDirectText ? 'text' : 'default';
      }
      return cursor;
    })()`;

    try {
      const response = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true }) as {
        result?: { value?: unknown };
      };
      const value = response?.result?.value;
      return typeof value === 'string' ? value : 'default';
    } catch {
      return 'default';
    }
  }

  // #401（キーボードトグル導入）までの暫定対応: タッチのタップで同期 focus した
  // 直後に呼ばれ、リモートページの現在の activeElement が実際に編集可能かを
  // 判定する。false ならクライアント側が hidden input を blur してソフトキー
  // ボードを閉じる。cdp 未接続・評価失敗時は false（キーボードを閉じる側）に
  // フォールバックする — getCursorAt と異なり、誤って開いたキーボードを閉じ
  // 忘れるより、誤って一瞬チラつかせて閉じる方が実害が小さいため。
  async isFocusedElementEditable(): Promise<boolean> {
    if (!this.cdp) return false;

    // Input.dispatchMouseEvent によるクリックのフォーカス反映は非同期にDOMへ
    // 反映されるため、直後に Runtime.evaluate すると activeElement がまだ
    // クリック前の要素のままのことがある。妥当な待ちを挟んで競合を避ける。
    await new Promise((resolve) => setTimeout(resolve, 100));

    // activeElement が IFRAME や shadow host の場合、実際にフォーカスされている
    // 末端の要素まで降りてから判定する:
    //  - IFRAME: same-origin なら contentDocument.activeElement へ降りる。
    //    cross-origin は contentDocument へのアクセスが例外または null になり
    //    中身を検査できないため、キーボードを閉じる側 false にフォールバック
    //    する（この暫定対応では cross-origin iframe 内のテキスト入力にキー
    //    ボードを開けない制限が残るが、#401 の明示トグル導入で解消する）。
    //  - shadow host: open な shadowRoot でフォーカスされた要素があれば
    //    shadowRoot.activeElement へ降りる。closed な shadowRoot は
    //    element.shadowRoot が取得できず降りられないため、host 要素自身に
    //    対する従来判定（isEditableEl）にフォールバックする。
    // どちらも複数段ネストしうるので同じループで交互に辿る。
    const expression = `(() => {
      const isEditableEl = (el) => {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
        if (tag === 'INPUT') {
          if (el.readOnly || el.disabled) return false;
          const nonTextTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'date', 'time', 'datetime-local', 'month', 'week', 'image'];
          const type = String(el.type || 'text').toLowerCase();
          return !nonTextTypes.includes(type);
        }
        return Boolean(el.isContentEditable);
      };

      let el = document.activeElement;
      while (el) {
        if (el.tagName === 'IFRAME') {
          let innerDoc;
          try {
            innerDoc = el.contentDocument;
          } catch {
            return false; // cross-origin: cannot inspect, close the keyboard
          }
          if (!innerDoc) return false; // cross-origin (or not yet loaded)
          el = innerDoc.activeElement;
          continue;
        }
        if (el.shadowRoot && el.shadowRoot.activeElement) {
          el = el.shadowRoot.activeElement;
          continue;
        }
        break;
      }
      return isEditableEl(el);
    })()`;

    try {
      const response = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true }) as {
        result?: { value?: unknown };
      };
      return response?.result?.value === true;
    } catch {
      return false;
    }
  }

  async getSelectionText(): Promise<string> {
    if (!this.cdp) return '';
    try {
      const response = await this.cdp.send('Runtime.evaluate', {
        expression: `window.getSelection()?.toString() ?? ''`,
        returnByValue: true,
      }) as { result?: { value?: unknown } };
      const value = response?.result?.value;
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  async dispatchInput(input: BrowserInput): Promise<void> {
    if (!this.cdp) return;

    switch (input.type) {
      case 'mouse': {
        const button = input.button ?? 'left';
        if (input.kind === 'mouseWheel') {
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: input.x,
            y: input.y,
            deltaX: input.deltaX ?? 0,
            deltaY: input.deltaY ?? 0,
          });
        } else {
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: input.kind,
            x: input.x,
            y: input.y,
            button,
            clickCount: input.kind === 'mousePressed' ? 1 : 0,
          });
        }
        break;
      }
      case 'key': {
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: input.kind,
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          nativeVirtualKeyCode: input.keyCode,
          ...(input.text ? { text: input.text } : {}),
        });
        break;
      }
      case 'insertText': {
        await this.cdp.send('Input.insertText', { text: input.text });
        break;
      }
      case 'composition': {
        const start = Number(input.selectionStart);
        const end = Number(input.selectionEnd);
        await this.cdp.send('Input.imeSetComposition', {
          text: input.text,
          selectionStart: Number.isFinite(start) ? start : input.text.length,
          selectionEnd: Number.isFinite(end) ? end : input.text.length,
        }).catch(() => {});
        break;
      }
      case 'navigate': {
        if (!isAllowedUrl(input.url)) break;
        await this.page.goto(input.url).catch(() => {});
        break;
      }
      case 'back': {
        await this.page.goBack().catch(() => {});
        break;
      }
      case 'forward': {
        await this.page.goForward().catch(() => {});
        break;
      }
      case 'reload': {
        await this.page.reload().catch(() => {});
        break;
      }
      case 'stopLoading': {
        await this.cdp.send('Page.stopLoading').catch(() => {});
        break;
      }
      case 'resize': {
        if (typeof input.width !== 'number' || typeof input.height !== 'number') break;
        if (!Number.isFinite(input.width) || !Number.isFinite(input.height)) break;
        const width = Math.round(clamp(input.width, 320, 3840));
        const height = Math.round(clamp(input.height, 240, 2160));
        // NOTE: viewport is per-page, not per-client. When multiple clients view the
        // same page, the last resize message wins (last-writer-wins).
        await this.page.setViewportSize({ width, height }).catch(() => {});
        break;
      }
    }
  }
}
