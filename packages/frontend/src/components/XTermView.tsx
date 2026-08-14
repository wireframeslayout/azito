import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTmuxTouchScroll } from '../hooks/useTmuxTouchScroll';
import { useIsMobile } from '../hooks/useIsMobile';
import { useVirtualKeyboard, KEYBOARD_HEIGHT_THRESHOLD } from '../hooks/useVirtualKeyboard';
import { useSupervisedLoadingOverlay } from '../hooks/useSupervisedLoadingOverlay';
import { useToast } from '../hooks/useToast';
import { Spinner } from './ui/Spinner';
import { useTerminalTheme } from '../hooks/useTerminalTheme';
import { createOsc52Extractor } from '../utils/osc52';
import { buildWsUrl } from '../api/wsUrl';
import TerminalBackdrop from './TerminalBackdrop';

// SP端末クイックキーフッター（TerminalQuickKeyBar）と⌨透過パッド（MobileKeyboardOverlay）が
// 送出しうるキー全種を網羅する。両者ともこのマップ経由でアクティブなWS接続へ直接キーを流す
// （Issue #69 T3 — 新規のsend実装を作らず、この既存経路をXTermViewRefで外部公開して再利用する）。
const SPECIAL_KEY_MAP: Record<string, string> = {
  'Enter': '\r', 'Escape': '\x1b', 'Tab': '\t',
  'Up': '\x1b[A', 'Down': '\x1b[B', 'Left': '\x1b[D', 'Right': '\x1b[C',
  'C-c': '\x03', 'C-d': '\x04',
  'y': 'y', 'n': 'n',
};

function agentLaunchLabel(token: string | null, t: (key: string) => string): string {
  if (token === 'claude') return t('terminal.launchingClaude');
  if (token === 'codex') return t('terminal.launchingCodex');
  return t('terminal.launchingAgent');
}

const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
// オフラインのペイン（tmux target は存在するが出力が一切流れてこない）に接続すると、WS の
// open は成立してもデータが永久に来ず、useSupervisedLoadingOverlay の「接続中…」スピナーが
// 無期限に回り続ける。初回接続に限りこのタイムアウトで打ち切り、明示的なエラー状態へ遷移させる。
const CONNECT_DATA_TIMEOUT_MS = 10000;

async function writeClipboard(
  text: string,
  onError: (msg: string) => void,
  clipboardFailedMsg?: string,
): Promise<void> {
  if (!navigator.clipboard) {
    onError(clipboardFailedMsg || 'Clipboard access denied');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    onError(`コピー失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface XTermViewHandle {
  /**
   * TerminalQuickKeyBar / MobileKeyboardOverlay がこの端末表示に直接キーを送出するための
   * ハンドル（Issue #69 T3）。SPECIAL_KEY_MAP に載っているキー名のみ有効。既存の内部
   * sendSpecialKey をそのまま公開するだけで、送出経路（アクティブなWS接続）は増やさない。
   */
  sendKey: (key: string) => void;
}

interface XTermViewProps {
  serverName: string;
  target: string;
  onDisconnect?: () => void;
  onWindowNotFound?: () => void;
  onMaxRetriesReached?: () => void;
  onConnectTimeout?: () => void;
}

const XTermView = forwardRef<XTermViewHandle, XTermViewProps>(function XTermView({ serverName, target, onDisconnect, onWindowNotFound, onMaxRetriesReached, onConnectTimeout }, ref) {
  const { t } = useTranslation('common');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<any>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connectDataTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadingOverlay = useSupervisedLoadingOverlay(serverName, target);
  const isMobile = useIsMobile();
  const keyboardVisible = useVirtualKeyboard();
  const { xtermTheme } = useTerminalTheme();
  const { showToast } = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;

  const sendSpecialKey = useCallback((key: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const seq = SPECIAL_KEY_MAP[key];
      if (seq) wsRef.current.send(seq);
    }
  }, []);

  useImperativeHandle(ref, () => ({ sendKey: sendSpecialKey }), [sendSpecialKey]);

  const fontSize = isMobile ? 12 : 14;

  useTmuxTouchScroll({ containerRef });

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme;
  }, [xtermTheme]);

  useEffect(() => {
    if (!isMobile || !window.visualViewport) return;
    const vp = window.visualViewport;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const applyViewport = () => {
      const shrink = window.innerHeight - vp.height;
      if (shrink >= KEYBOARD_HEIGHT_THRESHOLD) {
        // キーボード出現中: 親のpaddingは0になるため、画面下端までの明示heightでよい
        const rect = wrapper.getBoundingClientRect();
        const available = vp.height - rect.top;
        wrapper.style.height = `${Math.max(available, 100)}px`;
        fitRef.current?.fit();
      } else {
        // キーボード収納: 明示heightをJSX指定の100%に戻し、flexレイアウト+親paddingに委ねる
        wrapper.style.height = '100%';
        requestAnimationFrame(() => fitRef.current?.fit());
      }
    };

    // visualViewport の resize/scroll はキーボード開閉アニメーション中に連続発火し、
    // レイアウト未確定の中途半端な値で高さを確定させてしまうため、最後のイベントから
    // 一定時間後に1回だけ処理する
    const onResize = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyViewport, 120);
    };

    vp.addEventListener('resize', onResize);
    vp.addEventListener('scroll', onResize);
    // 一部ブラウザはキーボード収納時に visualViewport の resize を発火せず
    // window の resize しか飛ばさないため、フォールバックとして window resize も監視する
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(debounceTimer);
      vp.removeEventListener('resize', onResize);
      vp.removeEventListener('scroll', onResize);
      window.removeEventListener('resize', onResize);
      wrapper.style.height = '100%';
      fitRef.current?.fit();
    };
  }, [isMobile]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let terminalContainer: HTMLDivElement | null = null;
    let focusHandler: (() => void) | null = null;
    let pasteHandler: ((event: ClipboardEvent) => void) | null = null;
    let documentPasteHandler: ((event: ClipboardEvent) => void) | null = null;
    let keydownHandler: ((event: KeyboardEvent) => void) | null = null;
    let sizeCheckInterval: ReturnType<typeof setInterval> | undefined;
    let sizeCheckTimeout: ReturnType<typeof setTimeout> | undefined;
    let onDataDisposable: { dispose: () => void } | null = null;
    async function init() {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      if (!document.querySelector('link[href*="xterm.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
        document.head.appendChild(link);
      }
      if (disposed || !containerRef.current) return;

      const terminal = new Terminal({ cursorBlink: true, fontSize, fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace", theme: xtermThemeRef.current, allowTransparency: true, allowProposedApi: true, scrollback: 5000 });
      termRef.current = terminal;
      const fitAddon = new FitAddon();
      fitRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(containerRef.current);

      terminalContainer = containerRef.current;
      focusHandler = () => terminal.focus();
      const handlePaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return;

        event.preventDefault();
        event.stopPropagation();
        terminal.focus();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(text);
        }
      };
      pasteHandler = handlePaste;
      documentPasteHandler = (event: ClipboardEvent) => {
        const targetNode = event.target instanceof Node ? event.target : null;
        const activeNode = document.activeElement;
        if (!terminalContainer) return;
        if (
          (targetNode && terminalContainer.contains(targetNode)) ||
          (activeNode && terminalContainer.contains(activeNode))
        ) {
          handlePaste(event);
        }
      };
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        const mod = event.ctrlKey || event.metaKey;
        if (!mod) return true;

        if (key === 'c' && terminal.hasSelection()) {
          const selection = terminal.getSelection();
          if (selection) {
            writeClipboard(selection, showToastRef.current, tRef.current('terminal.clipboardFailed'));
            terminal.clearSelection();
          }
          return false;
        }

        if (key === 'v') {
          return false;
        }

        return true;
      });


      terminalContainer.addEventListener('mousedown', focusHandler);
      terminalContainer.addEventListener('paste', pasteHandler, true);
      document.addEventListener('paste', documentPasteHandler, true);
      if (keydownHandler) {
        document.addEventListener('keydown', keydownHandler, true);
      }

      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const doFit = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          fitAddon.fit();
          if (terminal.cols > 2 && terminal.rows > 2 && wsRef.current?.readyState === WebSocket.OPEN)
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }, 100);
      };
      const ro = new ResizeObserver((entries) => {
        const e = entries[0];
        if (!e || e.contentRect.width < 10 || e.contentRect.height < 10) return;
        doFit();
      });
      roRef.current = ro;
      if (containerRef.current) ro.observe(containerRef.current);
      resizeHandler = doFit;
      window.addEventListener('resize', doFit);

      // タブが非表示→表示に切り替わったとき（ワークスペースのタブ切替など）、
      // 表示されなくなっている間に残った明示heightが原因で中途半端なサイズのまま
      // 固定されてしまうことがあるため、再表示を検知して明示heightをJSX指定の100%に戻しrefitする
      let wasVisible = true;
      const io = new IntersectionObserver((entries) => {
        const e = entries[0];
        if (!e) return;
        if (e.isIntersecting) {
          if (!wasVisible) {
            if (wrapperRef.current) wrapperRef.current.style.height = '100%';
            requestAnimationFrame(() => fitAddon.fit());
          }
          wasVisible = true;
        } else {
          wasVisible = false;
        }
      });
      ioRef.current = io;
      if (containerRef.current) io.observe(containerRef.current);

      function waitForSize(cb: () => void) {
        fitAddon.fit();
        if (terminal.cols > 2 && terminal.rows > 2) { cb(); return; }
        sizeCheckInterval = setInterval(() => {
          if (disposed) { clearInterval(sizeCheckInterval); return; }
          fitAddon.fit();
          if (terminal.cols > 2 && terminal.rows > 2) { clearInterval(sizeCheckInterval); cb(); }
        }, 100);
        sizeCheckTimeout = setTimeout(() => clearInterval(sizeCheckInterval), 5000);
      }

      waitForSize(() => {
        if (disposed) return;
        let reconnectAttempts = 0;
        let firstDisconnect = true;

        function connect() {
          if (disposed) return;
          const extractOsc52 = createOsc52Extractor((text) => {
            writeClipboard(text, showToastRef.current, tRef.current('terminal.clipboardFailed'));
          });

          onDataDisposable?.dispose();
          onDataDisposable = null;
          const prev = wsRef.current;
          if (prev) {
            prev.onclose = null;
            prev.onerror = null;
            prev.onmessage = null;
            try { prev.close(); } catch { /* already closed */ }
          }
          clearTimeout(connectDataTimerRef.current);

          const ws = new WebSocket(buildWsUrl({ server: serverName, target, cols: String(terminal.cols), rows: String(terminal.rows) }));
          wsRef.current = ws;
          let firstMsg = true;
          // 初回接続に限り、オフライン(＝出力が永久に来ない)ペインを検出する。WS の open 自体は
          // 成立してしまうため onclose には頼れず、データ到達を独自タイムアウトで見張る。2回目
          // 以降(バックオフ再接続)は既存の disconnected/reconnecting フローに任せる。
          let connectTimedOut = false;
          if (reconnectAttempts === 0) {
            connectDataTimerRef.current = setTimeout(() => {
              if (disposed || !firstMsg) return;
              connectTimedOut = true;
              onConnectTimeout?.();
              try { ws.close(); } catch { /* already closed */ }
            }, CONNECT_DATA_TIMEOUT_MS);
          }
          ws.onopen = () => {
            reconnectAttempts = 0;
            firstDisconnect = true;
            terminal.focus();
            fitAddon.fit();
            ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
          };
          ws.onmessage = (e: MessageEvent) => {
            if (firstMsg) { firstMsg = false; clearTimeout(connectDataTimerRef.current); loadingOverlay.markConnected(); }
            const data = typeof e.data === 'string' ? e.data : '';
            extractOsc52(data);
            terminal.write(e.data);
          };
          ws.onclose = (e) => {
            clearTimeout(connectDataTimerRef.current);
            if (disposed) return;
            if (connectTimedOut) return;
            if (e.code === 4404) { onWindowNotFound?.(); return; }
            if (firstDisconnect) {
              firstDisconnect = false;
              onDisconnect?.();
            }
            if (reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
              const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY_MS);
              reconnectAttempts++;
              terminal.write(`\r\n\x1b[33m[Disconnected — reconnecting (${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...]\x1b[0m\r\n`);
              reconnectTimerRef.current = setTimeout(connect, delay);
            } else {
              terminal.write('\r\n\x1b[33m[Connection closed]\x1b[0m\r\n');
              onMaxRetriesReached?.();
            }
          };
          ws.onerror = () => { /* close event follows */ };
          onDataDisposable = terminal.onData((d: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
        }

        connect();
      });
    }

    let resizeHandler: (() => void) | null = null;
    init();
    return () => {
      disposed = true;
      if (terminalContainer && focusHandler) {
        terminalContainer.removeEventListener('mousedown', focusHandler);
      }
      if (terminalContainer && pasteHandler) {
        terminalContainer.removeEventListener('paste', pasteHandler, true);
      }
      if (documentPasteHandler) {
        document.removeEventListener('paste', documentPasteHandler, true);
      }
      if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler, true);
      }
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
      }
      clearInterval(sizeCheckInterval);
      clearTimeout(sizeCheckTimeout);
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(connectDataTimerRef.current);
      onDataDisposable?.dispose();
      roRef.current?.disconnect();
      ioRef.current?.disconnect();
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [serverName, target]);
  return (
    <div
      ref={wrapperRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
        paddingBottom: isMobile && !keyboardVisible ? 'var(--mobile-bottom-inset)' : 0,
      }}
    >
      <TerminalBackdrop variant="terminal" />
      <div ref={containerRef} tabIndex={0} style={{ flex: 1, padding: 4, overflow: 'hidden', outline: 'none', position: 'relative', zIndex: 1 }} />
      {loadingOverlay.mounted && (
        <div
          role="status"
          className="terminal-loading-overlay"
          onTransitionEnd={loadingOverlay.handleTransitionEnd}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            // 半透明化される --bg ではなく常時不透明の土台色（Workspaceスコープでは --bg が透過し背後のペインが見える）
            background: 'var(--bg-solid)',
            zIndex: 5,
            opacity: loadingOverlay.fadingOut ? 0 : 1,
          }}
        >
          <Spinner
            size={30}
            color={loadingOverlay.phase === 'timeout' ? 'var(--warning)' : 'var(--accent)'}
            trackColor={loadingOverlay.phase === 'timeout' ? 'var(--warning-a15)' : 'var(--accent-a15)'}
            paused={loadingOverlay.phase === 'timeout'}
          />
          <span style={{ color: 'var(--text)', fontSize: 'var(--font-md)' }}>
            {loadingOverlay.phase === 'connecting' && t('terminal.connecting')}
            {loadingOverlay.phase === 'launching' && agentLaunchLabel(loadingOverlay.agentToken, t)}
            {loadingOverlay.phase === 'timeout' && t('terminal.launchTimeout')}
          </span>
          {loadingOverlay.phase === 'launching' && loadingOverlay.agentToken && (
            <span
              style={{
                color: 'var(--purple)',
                background: 'var(--purple-a15)',
                border: '1px solid var(--purple-a35)',
                borderRadius: 'var(--radius-full)',
                padding: '2px 10px',
                fontSize: 'var(--font-xs)',
                fontFamily: 'monospace',
              }}
            >
              ✳ {loadingOverlay.agentToken}
            </span>
          )}
          {loadingOverlay.phase === 'launching' && (
            <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', fontFamily: 'monospace' }}>{t('terminal.supervisedMonitoring')}</span>
          )}
          {loadingOverlay.phase === 'timeout' && (
            <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', fontFamily: 'monospace' }}>{t('terminal.continueDisplay')}</span>
          )}
        </div>
      )}
    </div>
  );
});

export default XTermView;
