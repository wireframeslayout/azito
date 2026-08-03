import type { WebSocket } from 'ws';
import type { BrowserSessionManager } from '../BrowserSessionManager';
import type { BrowserInput, BrowserTabInput, BrowserTabsMessage } from '../BrowserInput';
import { createBufferedMessageRelay, messageByteSize } from '../../../shared/utils/BufferedMessageRelay';

const TAB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ホバーカーソル同期の getCursorAt 実行間隔と、共有カーソル座標の emit 間隔。
// どちらも高頻度な mouseMoved に対する負荷軽減のためのスロットル。
const CURSOR_THROTTLE_MS = 120;
const PEER_CURSOR_THROTTLE_MS = 50;

// 接続ごとの一意 id を振るモジュールスコープのカウンタ（共有カーソルの発信元識別用）。
let nextPeerId = 0;

// Coalescing key for the pre-ready message buffer: collapses a burst of
// `resize` (the client re-sending on every debounce tick while its
// ResizeObserver settles) or `mouseMoved` events down to the latest one, so
// neither can crowd the one-off early `resize` (or anything else) out of the
// buffer's count cap while Chromium is still starting up. Everything else
// (clicks, keys, navigate, openTab, ...) is buffered normally (non-coalesced,
// append-only) since collapsing those would drop meaningful events.
// Malformed JSON coalesces to null (buffered normally) — it will fail to
// parse again on replay and just get ignored there, same as today.
function coalesceKeyForBrowserMessage(msg: Buffer | string): string | null {
  try {
    const parsed = JSON.parse(msg.toString()) as { type?: string; kind?: string };
    if (parsed.type === 'resize') return 'resize';
    if (parsed.type === 'mouse' && parsed.kind === 'mouseMoved') return 'mouseMoved';
    return null;
  } catch {
    return null;
  }
}

function createThrottler(intervalMs: number, fn: () => void): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = 0;

  const trigger = () => {
    const now = Date.now();
    const elapsed = now - lastRun;
    if (elapsed >= intervalMs) {
      lastRun = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        fn();
      }, intervalMs - elapsed);
    }
  };

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { trigger, cancel };
}

export function handleBrowserConnection(
  ws: WebSocket,
  browserSessionManager: BrowserSessionManager,
  serverName: string,
  groupId: string,
  tabId: string,
  hubOrigin?: string,
): void {
  const peerId = nextPeerId++;
  let closed = false;
  let cleanup: (() => void) | null = null;
  // Tracks whether the remote page currently has an unconfirmed IME
  // composition (preedit) pending, so cleanup() can clear it on disconnect —
  // otherwise a WS drop/tab-switch mid-composition would leave stray preedit
  // text visible on the remote page (and visible to other viewers) forever,
  // since compositionend never fires.
  let compositionActive = false;

  // The client sends its initial `resize` (and, on a cold start, possibly
  // `navigate`/`openTab`) right after the WS opens — before
  // getOrCreate()/getOrCreatePage() below have resolved and the real
  // message handler is wired up. Registering `ws.on('message', ...)` here,
  // immediately, and buffering until the page is ready prevents that early
  // burst from being silently dropped (which used to leave the remote
  // viewport at its default 1024x720 until an unrelated resize, e.g. from a
  // sidebar toggle, happened to land after the handler was attached).
  const messageRelay = createBufferedMessageRelay<Buffer | string>({
    sizeOf: messageByteSize,
    coalesceKey: coalesceKeyForBrowserMessage,
  });
  ws.on('message', (msg: Buffer | string) => {
    messageRelay.push(msg);
  });

  ws.on('close', () => {
    closed = true;
    messageRelay.clear();
    cleanup?.();
  });

  browserSessionManager.getOrCreate(serverName, { hubOrigin })
    .then((session) => browserSessionManager.restoreGroupIfEmpty(session, serverName, groupId).then(() => session))
    .then((session) => session.getOrCreatePage(groupId, tabId).then((page) => ({ session, page })))
    .then(({ session, page }) => {
      if (closed) {
        session.checkGroupIdle(groupId);
        browserSessionManager.checkIdle(serverName);
        return;
      }

      page.incrementClient();
      session.incrementGroupClient(groupId);
      browserSessionManager.checkIdle(serverName);

      const lastFrame = page.lastFrame;
      if (lastFrame && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(lastFrame));
      }

      const lastUrl = page.lastUrl;
      if (lastUrl && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'url', url: lastUrl }));
      }

      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'loading', loading: page.loading }));
      }

      const unsubscribeFrame = page.onFrame((frame) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(frame));
        }
      });

      const unsubscribeUrl = page.onUrl((url) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'url', url }));
        }
      });

      const unsubscribeLoading = page.onLoading((loading) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'loading', loading }));
        }
      });

      const unsubscribePeerCursor = page.onPeerCursor((peer) => {
        if (peer.id === peerId) return;
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'peerCursor', id: peer.id, x: peer.x, y: peer.y }));
        }
      });

      const unsubscribePeerLeft = page.onPeerLeft((id) => {
        if (id === peerId) return;
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'peerLeft', id }));
        }
      });

      const unsubscribeDialog = page.onDialog((info) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'dialog',
            dialogType: info.type,
            message: info.message,
            defaultValue: info.defaultValue,
          }));
        }
      });

      const unsubscribeDialogDismissed = page.onDialogDismissed(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'dialog-dismissed' }));
        }
      });

      const unsubscribeFileChooser = page.onFileChooser((info) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'filechooser', multiple: info.multiple }));
        }
      });

      const unsubscribeFileChooserDismissed = page.onFileChooserDismissed(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'filechooser-dismissed' }));
        }
      });

      const unsubscribeAuth = page.onAuth((info) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'auth', origin: info.origin }));
        }
      });

      const unsubscribeAuthDismissed = page.onAuthDismissed(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'auth-dismissed' }));
        }
      });

      const sendTabs = () => {
        if (ws.readyState !== ws.OPEN) return;
        const tabsMessage: BrowserTabsMessage = { type: 'tabs', tabs: session.listGroupTabs(groupId) };
        ws.send(JSON.stringify(tabsMessage));
      };
      sendTabs();

      const unsubscribeTabs = session.onGroupTabsChanged((changedGroupId) => {
        if (changedGroupId !== groupId) return;
        sendTabs();
      });

      let lastMouseX = 0;
      let lastMouseY = 0;
      let lastSentCursor: string | null = null;
      // getCursorAt は非同期なので、リクエスト順に応答が返るとは限らない。接続
      // ローカルの単調増加シーケンス番号で「自分が最新のリクエストか」を判定し、
      // 古い座標に対する応答が後から届いて最新結果を上書きしないようにする。
      let cursorRequestSeq = 0;
      // #401（キーボードトグル導入）までの暫定対応。isFocusedElementEditable()
      // は Runtime.evaluate を含む非同期処理なので、複数の queryEditable が
      // 短時間に飛び交うと解決順が入れ替わりうる — 接続ローカルで「最後に
      // 受け取った requestId」を保持し、応答時に自分が最新の問い合わせでなければ
      // 送信を破棄する（評価自体の重複実行は許容し、クライアントに届く応答だけ
      // 最新のものに絞る）。
      let latestEditableRequestId: number | null = null;

      const cursorThrottler = createThrottler(CURSOR_THROTTLE_MS, () => {
        const seq = ++cursorRequestSeq;
        page.getCursorAt(lastMouseX, lastMouseY).then((cursor) => {
          if (seq !== cursorRequestSeq) return;
          if (cursor === lastSentCursor) return;
          lastSentCursor = cursor;
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'cursor', cursor }));
          }
        }).catch(() => {});
      });

      const peerCursorThrottler = createThrottler(PEER_CURSOR_THROTTLE_MS, () => {
        page.emitPeerCursor({ id: peerId, x: lastMouseX, y: lastMouseY });
      });

      cleanup = () => {
        if (compositionActive) {
          compositionActive = false;
          page.dispatchInput({ type: 'composition', text: '', selectionStart: 0, selectionEnd: 0 }).catch(() => {});
        }
        unsubscribeFrame();
        unsubscribeUrl();
        unsubscribeLoading();
        unsubscribePeerCursor();
        unsubscribePeerLeft();
        unsubscribeDialog();
        unsubscribeDialogDismissed();
        unsubscribeFileChooser();
        unsubscribeFileChooserDismissed();
        unsubscribeAuth();
        unsubscribeAuthDismissed();
        unsubscribeTabs();
        cursorThrottler.cancel();
        peerCursorThrottler.cancel();
        page.emitPeerLeft(peerId);
        page.decrementClient();
        session.decrementGroupClient(groupId);
        session.checkGroupIdle(groupId);
        browserSessionManager.checkIdle(serverName);
      };

      // Flush anything buffered while the page was being created/fetched,
      // in arrival order, then switch to direct delivery for everything
      // that comes in from here on.
      messageRelay.deliverTo((msg: Buffer | string) => {
        try {
          const raw = JSON.parse(msg.toString()) as Record<string, unknown>;
          if (raw.type === 'dialog-response') {
            page.respondToDialog(Boolean(raw.accept), typeof raw.text === 'string' ? raw.text : undefined);
            return;
          }
          if (raw.type === 'auth-response') {
            if (raw.cancel) {
              page.cancelAuth();
            } else {
              page.respondToAuth(
                typeof raw.username === 'string' ? raw.username : '',
                typeof raw.password === 'string' ? raw.password : '',
              );
            }
            return;
          }
          if (raw.type === 'filechooser-response') {
            const rawFiles = Array.isArray(raw.files) ? raw.files : [];
            const files = rawFiles.filter((f): f is { name: string; mimeType: string; base64: string } =>
              typeof f === 'object' && f !== null &&
              typeof (f as Record<string, unknown>).name === 'string' &&
              typeof (f as Record<string, unknown>).mimeType === 'string' &&
              typeof (f as Record<string, unknown>).base64 === 'string',
            );
            page.respondToFileChooser(files);
            return;
          }
          const input = raw as unknown as BrowserInput | BrowserTabInput;
          if (input.type === 'openTab') {
            if (TAB_ID_RE.test(input.tabId)) {
              session.getOrCreatePage(groupId, input.tabId).catch(() => {});
            }
            return;
          }
          if (input.type === 'closeTab') {
            if (TAB_ID_RE.test(input.tabId)) {
              session.closePage(groupId, input.tabId).catch(() => {});
            }
            return;
          }
          if (input.type === 'copySelection') {
            page.getSelectionText().then((text) => {
              if (text && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'clipboard', text }));
              }
            }).catch(() => {});
            return;
          }
          if (input.type === 'queryEditable') {
            // #401（キーボードトグル導入）までの暫定対応: dispatchInput には
            // 流さず、ここで直接応答する（openTab/closeTab と同様の位置）。
            // requestId は Number.isSafeInteger で検証し、不正な値は無視する
            // （クライアントの単調増加カウンタが送るはずの値以外は受け付けない）。
            if (!Number.isSafeInteger(input.requestId)) return;
            const requestId = input.requestId;
            latestEditableRequestId = requestId;
            // requestId をそのままエコーし、クライアントが古い応答を無視できる
            // ようにする（連打で複数の問い合わせが飛び交う際の取り違え防止）。
            // さらに、この接続内で自分より新しい問い合わせが既に来ていれば
            // （＝自分が最新でなくなっていれば）応答自体を送らない — 無制限に
            // プローブし続けても、実際にクライアントへ届く応答は常に最新の
            // ものだけに絞る。
            page.isFocusedElementEditable().then((editable) => {
              if (latestEditableRequestId !== requestId) return;
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'editable', editable, requestId }));
              }
            }).catch(() => {});
            return;
          }
          if (input.type === 'mouse' && input.kind === 'mouseMoved') {
            lastMouseX = input.x;
            lastMouseY = input.y;
            cursorThrottler.trigger();
            peerCursorThrottler.trigger();
          }
          if (input.type === 'composition') {
            compositionActive = input.text.length > 0;
          } else if (input.type === 'insertText') {
            // insertText replaces/confirms any pending composition on the
            // remote page, so there is nothing left to clear on disconnect.
            compositionActive = false;
          }
          page.dispatchInput(input).catch(() => {});
        } catch { /* ignore malformed messages */ }
      });
    })
    .catch((err: Error) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
      }
    });
}
