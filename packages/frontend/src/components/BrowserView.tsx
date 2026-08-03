import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './ui/IconButton';
import { MiniTabBar } from './ui/MiniTabBar';
import { Icon } from './ui/Icon';
import { BrowserTouchGesture } from './browserTouchGesture';
import { WheelVelocityTracker, BrowserWheelInertia } from './browserWheelGesture';
import BrowserDialog from './BrowserDialog';
import type { BrowserDialogInfo } from './BrowserDialog';
import { useToast } from '../hooks/useToast';
import { buildWsUrl } from '../api/wsUrl';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface PeerCursor {
  x: number;
  y: number;
  lastSeen: number;
}

// サーバーの {type:'cursor'} を CSS の cursor プロパティへそのまま渡す前の許可リスト。
// これに合致しない値は 'default' に落とし、任意 CSS 値の注入を防ぐ。
const CSS_CURSOR_RE = /^[a-z-]+$/;
// 共有カーソルの掃除間隔。正常な離脱は peerLeft / 自 WS close で即時反映されるため、
// この sweep はあくまで peerLeft を取りこぼした異常切断（ネットワーク断等）時の
// 掃除用フェイルセーフであり、アイドル非表示の目的ではない。
const PEER_CURSOR_SWEEP_INTERVAL_MS = 1000;
const PEER_CURSOR_STALE_MS = 30000;
// 共有カーソルマーカーの配色（id を巡回して割り当て）。
const PEER_CURSOR_COLORS = ['var(--accent)', 'var(--success)', 'var(--warning)', 'var(--purple)', 'var(--danger)'];

// Touch scroll: outgoing mouseWheel events during an active swipe are
// coalesced to once per animation frame (rAF), not on a fixed ms timer —
// see the touch effect below. The tap-vs-swipe movement threshold
// (TAP_MOVE_THRESHOLD_PX) lives in browserTouchGesture.ts alongside the
// gesture state machine that uses it; the release-velocity/inertia physics
// (Issue #403) live in browserWheelGesture.ts.

// Suppresses the browser's synthetic "compatibility" mouse events
// (mousedown/mouseup/click) that follow a touch sequence on some browsers
// even after touchend's preventDefault() — a belt-and-suspenders guard on
// top of that preventDefault(). Any onMouse* reaching the canvas within this
// window of a touchend is ignored.
const TOUCH_MOUSE_GUARD_MS = 500;

// Fixed quick-link candidates for the start page. Project-server-aware
// suggestions and navigation history are out of scope for this iteration.
const QUICK_LINKS: { url: string; label: string; dotColor?: string }[] = [
  { url: 'http://localhost:5173', label: 'localhost:5173' },
  { url: 'http://localhost:3001', label: 'localhost:3001' },
  { url: 'https://example.com', label: 'example.com', dotColor: 'var(--text-dim)' },
];

const IPV4_LITERAL_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIPv4(host: string): boolean {
  const match = IPV4_LITERAL_RE.exec(host);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some(n => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

// Scheme-less input (e.g. "localhost:5173") should default to http:// for local/
// private dev targets — this feature exists to preview dev servers running on
// the host machine or LAN, which almost never serve HTTPS. Public IPs (e.g.
// 8.8.8.8) fall through to the https default.
function isLocalOrPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  if (h.endsWith('.local') || h.endsWith('.ts.net')) return true;
  if (isPrivateIPv4(h)) return true;
  return false;
}

function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/\s/.test(s)) return false;
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) return true;
  if (IPV4_LITERAL_RE.test(s.split(/[:/]/)[0])) return true;
  return /^[^\s/]+\.[^\s/]+/.test(s);
}

function inferDefaultScheme(hostAndPath: string): 'http' | 'https' {
  // Parse via URL rather than naive `:` splitting so IPv6 literals like
  // "[::1]:5173" resolve correctly; fall back to https on parse failure.
  try {
    const parsed = new URL(`http://${hostAndPath}`);
    return isLocalOrPrivateHost(parsed.hostname) ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

interface BrowserTab {
  tabId: string;
  url: string | null;
  loading: boolean;
  title: string | null;
}

interface BrowserViewProps {
  serverName: string;
  /** One browser window (workspace tab) = one group; tabs inside are managed here. */
  groupId: string;
  /** Chromium tab (within groupId) to connect to on mount, restored from the last session. */
  initialTabId?: string;
  /** Called whenever the active Chromium tab changes, so the caller can persist it. */
  onActiveTabChange?: (tabId: string) => void;
}

// {type:'tabs'} からのラベル生成。ページタイトルがあればそれを優先し、無ければ
// URL の hostname+path に短縮、それも無ければ（新規タブ直後等）'New Tab'。
function tabLabel(url: string | null, title: string | null, newTabLabel: string): string {
  if (title && title.trim()) return title;
  if (!url) return newTabLabel;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.hostname}${path}` || newTabLabel;
  } catch {
    return url;
  }
}

// タブラベルがタイトル表示になると URL が見えなくなるため、ツールチップには
// 常に URL（未確定なら 'New Tab'）を出す。
function tabTooltip(url: string | null, newTabLabel: string): string {
  return url || newTabLabel;
}

export default function BrowserView({ serverName, groupId, initialTabId, onActiveTabChange }: BrowserViewProps) {
  const { t } = useTranslation('browser');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // Mirrors `canvasRef.current`, but as state so the touch effect (below)
  // can depend on it: the canvas is conditionally rendered (start page /
  // error state vs. the live canvas), so it unmounts and remounts as
  // `showStartPage`/`connectionState` change — a plain ref read in an effect
  // with an empty/unrelated dependency array would silently miss every
  // remount after the first. See the touch effect's callback ref for the
  // attach side of this.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const setCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    setCanvasEl(el);
  }, []);

  const [activeTabId, setActiveTabId] = useState(initialTabId ?? 't1');
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [frameDimensions, setFrameDimensions] = useState<{ cssW: number; cssH: number }>({ cssW: 1024, cssH: 720 });
  // Mirrors `frameDimensions` for consumers (the touch effect) that must not
  // re-run on every screencast frame — see the {type:'frame'} handler and
  // the touch effect below for why.
  const frameDimensionsRef = useRef(frameDimensions);
  // Set right after a touchend is handled, so a browser-synthesized
  // compatibility mouse event landing shortly after can be ignored by the
  // mouse handlers (belt-and-suspenders alongside touchend's preventDefault()).
  const lastTouchEndAtRef = useRef(0);
  // #401（キーボードトグル導入）までの暫定対応: タップ確定時に同期 focus した
  // hidden input が実際に編集可能な要素にフォーカスしていなかった場合、
  // {type:'editable', editable:false} を受けて blur するための状態。
  // null = 応答待ちなし。値は直近タップで送った queryEditable の requestId
  // — 連打で複数の問い合わせが飛び交っても、一致する requestId の応答だけを
  // 処理する（古い応答で新しいタップの pending 状態を誤って処理しないため）。
  // タッチ起点の focus だけを対象にし、マウスクリックの focus（handleMouseDown）
  // には適用しない。
  const touchFocusPendingRef = useRef<number | null>(null);
  // タップごとに queryEditable の requestId を採番する単調増加カウンタ。
  const queryEditableSeqRef = useRef(0);
  // Issue #403: タッチ effect が現在の慣性スクロール rAF ループを止める関数を
  // ここに登録しておく（effect 自身の cleanup でも呼ぶが、タブ切替時は
  // canvasEl/sendMessage が変わらず touch effect が再実行されないことがあるため、
  // 下の WS 張り替え effect の冒頭でもこの ref 経由で明示的に停止する — WS が
  // 実は同一 wsRef に新しい接続として差し替わるだけで sendMessage 自体は
  // false を返さず、慣性ループが古いジェスチャのまま新しいタブへ mouseWheel を
  // 送り続けてしまうのを防ぐため）。
  const stopInertiaRef = useRef<(() => void) | null>(null);
  const [cursorStyle, setCursorStyle] = useState('default');
  const [peerCursors, setPeerCursors] = useState<Map<number, PeerCursor>>(new Map());
  const [imeAnchor, setImeAnchor] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [isLoading, setIsLoading] = useState(false);
  const [pendingDialog, setPendingDialog] = useState<BrowserDialogInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();
  // The active tab's confirmed URL as last reported by the server (or
  // optimistically set right after a local navigate), distinct from `url`
  // (the editable URL bar value). null = not yet received for this tab —
  // used to decide when to show the start page (only once we know the tab
  // is actually blank, never during the initial "still connecting" gap).
  const [receivedUrl, setReceivedUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const composingRef = useRef(false);
  const urlEditingRef = useRef(false);
  const urlEditedRef = useRef(false);
  const latestUrlRef = useRef('');

  // Returns whether the message was actually sent (WS open), so callers that
  // optimistically update local UI state (e.g. navigateTo hiding the start
  // page) can gate that update on the send having actually gone out.
  const sendMessage = useCallback((msg: unknown): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    // Switching tabs tears down and re-establishes the WS connection (each
    // connection is bound to a single Chromium tab); reset every piece of
    // display state so the previous tab's frame/url/cursors don't linger
    // while the new one connects.
    setConnectionState('connecting');
    setErrorMessage(null);
    setUrl('');
    urlEditedRef.current = false;
    latestUrlRef.current = '';
    setFrameDimensions({ cssW: 1024, cssH: 720 });
    frameDimensionsRef.current = { cssW: 1024, cssH: 720 };
    // #401 暫定対応: タブ切替で前のタブの応答待ち・同期 focus を持ち越さない。
    // pending の有無に関わらず blur し、開きっぱなしのソフトキーボードを閉じる。
    touchFocusPendingRef.current = null;
    hiddenInputRef.current?.blur();
    // Issue #403: タブ切替で前のタブ向けの慣性スクロールを持ち越さない。
    // canvasEl/sendMessage の同一性は tab 切替で変わらないことがあり、touch
    // effect 自体は再実行されない場合があるため、ref 経由で明示的に止める。
    stopInertiaRef.current?.();
    setCursorStyle('default');
    setPeerCursors(new Map());
    setIsLoading(false);
    setPendingDialog(null);
    setHistoryOpen(false);
    setReceivedUrl(null);
    const prevCanvas = canvasRef.current;
    if (prevCanvas) {
      const ctx = prevCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, prevCanvas.width, prevCanvas.height);
    }

    const ws = new WebSocket(
      buildWsUrl({ mode: 'browser', server: serverName, group: groupId, page: activeTabId }),
    );
    wsRef.current = ws;

    const img = new Image();
    imgRef.current = img;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setConnectionState('connected');
      setErrorMessage(null);
    };

    ws.onmessage = (e: MessageEvent) => {
      // A previous tab's connection may still be closing (async) when a new
      // one is opened; ignore anything from a socket that is no longer the
      // active one so its state (frame/url/tabs/...) can't overwrite the new
      // tab's.
      if (wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'frame') {
          const prev = frameDimensionsRef.current;
          frameDimensionsRef.current = { cssW: msg.cssW, cssH: msg.cssH };
          // Only trigger a re-render (and the touch effect's dependents,
          // were it to depend on this state) when the size actually
          // changed — {type:'frame'} arrives on every screencast frame,
          // most of which don't resize anything.
          if (prev.cssW !== msg.cssW || prev.cssH !== msg.cssH) {
            setFrameDimensions({ cssW: msg.cssW, cssH: msg.cssH });
          }
          img.onload = () => {
            if (wsRef.current !== ws) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.drawImage(img, 0, 0);
          };
          img.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.type === 'url') {
          latestUrlRef.current = msg.url;
          setReceivedUrl(msg.url);
          if (!urlEditedRef.current) {
            setUrl(msg.url);
          }
          if (msg.url && msg.url !== 'about:blank') {
            setHistory((prev) =>
              prev[prev.length - 1] === msg.url ? prev : [...prev, msg.url].slice(-50),
            );
          }
        } else if (msg.type === 'clipboard') {
          if (typeof msg.text === 'string') {
            navigator.clipboard.writeText(msg.text).catch(() => {
              showToast(t('clipboardDenied'));
            });
          }
        } else if (msg.type === 'loading') {
          setIsLoading(Boolean(msg.loading));
        } else if (msg.type === 'cursor') {
          const cursor = typeof msg.cursor === 'string' && CSS_CURSOR_RE.test(msg.cursor) ? msg.cursor : 'default';
          setCursorStyle(cursor);
        } else if (msg.type === 'peerCursor') {
          setPeerCursors((prev) => {
            const next = new Map(prev);
            next.set(msg.id, { x: msg.x, y: msg.y, lastSeen: Date.now() });
            return next;
          });
        } else if (msg.type === 'editable') {
          // #401（キーボードトグル導入）までの暫定対応。タッチ起点の focus が
          // 実際に編集可能な要素でなかった場合のみ blur してソフトキーボードを
          // 閉じる。デスクトップのマウスクリック focus は対象外
          // （touchFocusPendingRef が立つのはタッチのタップ時のみ）。
          // requestId が直近タップの pending と一致する場合のみ処理し、連打で
          // 交錯した古い応答は無視する。
          if (touchFocusPendingRef.current !== null && msg.requestId === touchFocusPendingRef.current) {
            touchFocusPendingRef.current = null;
            if (msg.editable !== true) {
              hiddenInputRef.current?.blur();
            }
          }
        } else if (msg.type === 'peerLeft') {
          setPeerCursors((prev) => {
            if (!prev.has(msg.id)) return prev;
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
        } else if (msg.type === 'tabs') {
          const nextTabs: BrowserTab[] = Array.isArray(msg.tabs) ? msg.tabs : [];
          setTabs(nextTabs);
          // The server's loading state is authoritative; resync isLoading
          // from the active tab's entry here so a missed/dropped
          // {type:'loading'} message self-heals on the next tab-list update
          // instead of leaving the reload button stuck showing "stop".
          const activeTab = nextTabs.find((t) => t.tabId === activeTabId);
          if (activeTab) setIsLoading(activeTab.loading);
        } else if (msg.type === 'dialog') {
          setPendingDialog({ type: msg.dialogType, message: msg.message, defaultValue: msg.defaultValue });
        } else if (msg.type === 'dialog-dismissed') {
          setPendingDialog(null);
        } else if (msg.type === 'auth') {
          setPendingDialog({ type: 'auth', message: '', defaultValue: '', origin: msg.origin });
        } else if (msg.type === 'auth-dismissed') {
          setPendingDialog(null);
        } else if (msg.type === 'filechooser') {
          handleFileChooserRef.current(Boolean(msg.multiple));
        } else if (msg.type === 'filechooser-dismissed') {
          // no-op: native file dialog already closed on client side
        } else if (msg.type === 'error') {
          setConnectionState('error');
          setErrorMessage(msg.message);
        }
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      setConnectionState('disconnected');
      setPeerCursors(new Map());
      // #401 暫定対応: 切断で queryEditable の応答は二度と来ないので、応答待ち
      // のまま開きっぱなしになっているソフトキーボードを閉じる。
      touchFocusPendingRef.current = null;
      hiddenInputRef.current?.blur();
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setConnectionState('error');
    };

    return () => {
      ws.close();
      // Only clear the ref if it still points at this effect's socket — a
      // later effect run (tab switch) may already have replaced it with a
      // newer connection, and this cleanup must not null that out.
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [serverName, groupId, activeTabId]);

  // If the active tab was closed (locally or by another viewer of this
  // group), switch to the first remaining tab once the server confirms the
  // updated tab list.
  useEffect(() => {
    if (tabs.length === 0) return;
    if (tabs.some((t) => t.tabId === activeTabId)) return;
    setActiveTabId(tabs[0].tabId);
  }, [tabs, activeTabId]);

  // Persist the active Chromium tab (via the caller) so a later reconnect —
  // including one restored from a TTL-expired snapshot — reopens on the tab
  // the user was actually looking at, not always 't1'.
  useEffect(() => {
    onActiveTabChange?.(activeTabId);
  }, [activeTabId, onActiveTabChange]);

  // Keep the remote viewport in sync with the canvas container size.
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const sendResize = (width: number, height: number) => {
      if (width < 10 || height < 10) return;
      sendMessage({ type: 'resize', width: Math.round(width), height: Math.round(height) });
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => sendResize(width, height), 300);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [sendMessage]);

  // Send the current container size once as soon as the connection opens.
  useEffect(() => {
    if (connectionState !== 'connected') return;
    const container = canvasContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    sendMessage({ type: 'resize', width: Math.round(rect.width), height: Math.round(rect.height) });
  }, [connectionState, sendMessage]);

  // Drop peer cursors that haven't received an update recently (covers missed
  // peerLeft messages, e.g. an ungraceful disconnect).
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setPeerCursors((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, cursor] of prev) {
          if (now - cursor.lastSeen > PEER_CURSOR_STALE_MS) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, PEER_CURSOR_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = frameDimensions.cssW / rect.width;
    const scaleY = frameDimensions.cssH / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }, [frameDimensions]);

  const handleMouseEvent = useCallback((e: React.MouseEvent<HTMLCanvasElement>, kind: string) => {
    const { x, y } = getCanvasCoords(e);
    const buttonMap: Record<number, string> = { 0: 'left', 1: 'middle', 2: 'right' };
    sendMessage({
      type: 'mouse',
      kind,
      x,
      y,
      button: buttonMap[e.button] ?? 'left',
    });
  }, [getCanvasCoords, sendMessage]);

  // Moves the hidden IME input to the given viewport point (clamped to the
  // canvas container), so the OS composition/candidate window anchors near
  // the click instead of the off-screen default position.
  const anchorImeInput = useCallback((clientX: number, clientY: number) => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const left = Math.min(Math.max(clientX - rect.left, 0), Math.max(rect.width - 1, 0));
    const top = Math.min(Math.max(clientY - rect.top, 0), Math.max(rect.height - 16, 0));
    setImeAnchor({ left, top });
  }, []);

  // True while a browser-synthesized "compatibility" mouse event following a
  // touch sequence might still land here — see TOUCH_MOUSE_GUARD_MS and the
  // touchend handler's preventDefault() (the primary defense) below.
  const isWithinTouchMouseGuard = useCallback(() => {
    return Date.now() - lastTouchEndAtRef.current < TOUCH_MOUSE_GUARD_MS;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (isWithinTouchMouseGuard()) return;
    anchorImeInput(e.clientX, e.clientY);
    hiddenInputRef.current?.focus();
    handleMouseEvent(e, 'mousePressed');
  }, [anchorImeInput, handleMouseEvent, isWithinTouchMouseGuard]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isWithinTouchMouseGuard()) return;
    handleMouseEvent(e, 'mouseReleased');
  }, [handleMouseEvent, isWithinTouchMouseGuard]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isWithinTouchMouseGuard()) return;
    if (e.buttons === 0 && e.movementX === 0 && e.movementY === 0) return;
    handleMouseEvent(e, 'mouseMoved');
  }, [handleMouseEvent, isWithinTouchMouseGuard]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(e);
    sendMessage({
      type: 'mouse',
      kind: 'mouseWheel',
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }, [getCanvasCoords, sendMessage]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      sendMessage({ type: 'copySelection' });
      return;
    }
    // Ctrl/Cmd+V は preventDefault せず素通しする — ここで潰すとネイティブの
    // paste イベントが発火せず、handlePaste（insertText 転送）に到達しない。
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return;

    e.preventDefault();
    sendMessage({
      type: 'key',
      kind: 'keyDown',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      ...(e.key === 'Enter' ? { text: '\r' } : {}),
    });
  }, [sendMessage]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    // keyDown 側で素通し/特別扱いした Ctrl/Cmd+C・V は keyUp も送らない
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'v')) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return;

    sendMessage({
      type: 'key',
      kind: 'keyUp',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
    });
  }, [sendMessage]);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    sendMessage({ type: 'composition', text: '', selectionStart: 0, selectionEnd: 0 });
  }, [sendMessage]);

  const handleCompositionUpdate = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
    const text = e.data ?? '';
    sendMessage({ type: 'composition', text, selectionStart: text.length, selectionEnd: text.length });
  }, [sendMessage]);

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    if (e.data) {
      // Input.insertText replaces any pending (unconfirmed) composition and
      // confirms it, so no separate "clear composition" message is needed
      // for the committed-text case.
      sendMessage({ type: 'insertText', text: e.data });
    } else {
      // Composition was cancelled (e.g. Esc) with no committed text — clear
      // the remote page's pending preedit explicitly.
      sendMessage({ type: 'composition', text: '', selectionStart: 0, selectionEnd: 0 });
    }
    const input = hiddenInputRef.current;
    if (input) input.value = '';
  }, [sendMessage]);

  const handleInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    const input = e.currentTarget;
    if (input.value) {
      sendMessage({ type: 'insertText', text: input.value });
      input.value = '';
    }
  }, [sendMessage]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      composingRef.current = false;
      sendMessage({ type: 'insertText', text });
    }
  }, [sendMessage]);

  const navigateTo = useCallback((rawUrl: string) => {
    if (!rawUrl.trim()) return;
    const trimmed = rawUrl.trim();
    let navigateUrl: string;
    if (looksLikeUrl(trimmed)) {
      navigateUrl = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `${inferDefaultScheme(trimmed)}://${trimmed}`;
    } else {
      navigateUrl = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    }
    const sent = sendMessage({ type: 'navigate', url: navigateUrl });
    // Only optimistically update local UI state (URL bar, start page
    // visibility) if the navigate actually went out — while disconnected,
    // sendMessage is a no-op, and pretending we navigated would hide the
    // start page / desync the URL bar for a navigation that never happened.
    if (!sent) return;
    // Navigation is confirmed: let subsequent {type:'url'} events (e.g. redirects)
    // sync the URL bar again, even if the input is still focused.
    urlEditedRef.current = false;
    setUrl(navigateUrl);
    // Hide the start page immediately, optimistically — don't wait for the
    // server's {type:'url'} round-trip.
    setReceivedUrl(navigateUrl);
  }, [sendMessage]);

  const handleNavigate = useCallback(() => {
    navigateTo(url);
  }, [url, navigateTo]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleNavigate();
    }
  }, [handleNavigate]);

  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    urlEditedRef.current = true;
    setUrl(e.target.value);
  }, []);

  const handleUrlFocus = useCallback(() => {
    urlEditingRef.current = true;
    urlEditedRef.current = false;
  }, []);

  const handleUrlBlur = useCallback(() => {
    urlEditingRef.current = false;
    if (!urlEditedRef.current) {
      setUrl(latestUrlRef.current);
    }
  }, []);

  const handleBack = useCallback(() => {
    sendMessage({ type: 'back' });
  }, [sendMessage]);

  const handleForward = useCallback(() => {
    sendMessage({ type: 'forward' });
  }, [sendMessage]);

  const handleReloadOrStop = useCallback(() => {
    if (isLoading) {
      sendMessage({ type: 'stopLoading' });
    } else {
      sendMessage({ type: 'reload' });
    }
  }, [isLoading, sendMessage]);

  const handleDialogResponse = useCallback((accept: boolean, text?: string) => {
    if (pendingDialog?.type === 'auth') {
      sendMessage({ type: 'auth-response', cancel: true });
    } else {
      sendMessage({ type: 'dialog-response', accept, text });
    }
    setPendingDialog(null);
  }, [sendMessage, pendingDialog]);

  const handleAuthResponse = useCallback((username: string, password: string) => {
    sendMessage({ type: 'auth-response', username, password });
    setPendingDialog(null);
  }, [sendMessage]);

  const handleFileChooser = useCallback((multiple: boolean) => {
    const input = fileInputRef.current;
    if (!input) return;
    input.multiple = multiple;
    input.value = '';

    const sendFiles = (files: Array<{ name: string; mimeType: string; base64: string }>) => {
      sendMessage({ type: 'filechooser-response', files });
    };

    const onFiles = () => {
      const selectedFiles = Array.from(input.files || []);
      if (selectedFiles.length === 0) {
        sendFiles([]);
        return;
      }

      const oversized = selectedFiles.filter(f => f.size > MAX_FILE_SIZE);
      if (oversized.length > 0) {
        showToast(t('fileSizeExceeded', { names: oversized.map(f => f.name).join(', ') }));
        sendFiles([]);
        return;
      }

      Promise.all(
        selectedFiles.map(file => new Promise<{ name: string; mimeType: string; base64: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(',')[1] || '';
            resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', base64 });
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }))
      ).then(sendFiles).catch(() => {
        showToast(t('fileReadFailed'));
        sendFiles([]);
      });
    };

    const onCancel = () => {
      sendFiles([]);
      input.removeEventListener('change', onChange);
    };

    const onChange = () => {
      input.removeEventListener('cancel', onCancel);
      onFiles();
    };

    input.addEventListener('change', onChange, { once: true });
    input.addEventListener('cancel', onCancel, { once: true });
    input.click();
  }, [sendMessage, showToast]);

  const handleFileChooserRef = useRef(handleFileChooser);
  handleFileChooserRef.current = handleFileChooser;

  const handleOpenTab = useCallback(() => {
    const newTabId = `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    sendMessage({ type: 'openTab', tabId: newTabId });
    setActiveTabId(newTabId);
  }, [sendMessage]);

  const handleCloseTab = useCallback((tabId: string) => {
    sendMessage({ type: 'closeTab', tabId });
  }, [sendMessage]);

  // Touch handling is wired via native addEventListener (not React's
  // onTouch* props) because touchmove must call preventDefault() to stop the
  // page from native-scrolling under the canvas — React attaches touch
  // listeners as passive by default, which silently ignores
  // preventDefault(). useTmuxTouchScroll (terminal touch-scroll) uses the
  // same technique for the same reason.
  //
  // Reuse of useTmuxTouchScroll itself was considered and rejected: it
  // quantizes movement into fixed-size "lines" (WHEEL_DELTA_PER_LINE) sized
  // for xterm's line-based scrollback and targets `.xterm-viewport`
  // specifically, neither of which fits a pixel-addressable page here — this
  // canvas wants deltas that track the finger 1:1. It also has no notion of
  // "tap" (a swipe there only ever scrolls, it never clicks), which this view
  // needs to keep single-tap-to-click working.
  //
  // Depends on `canvasEl` (not `frameDimensions`): the canvas element itself
  // unmounts/remounts as `showStartPage`/`connectionState` change (start
  // page ↔ live canvas ↔ error view), so the effect must re-run then to
  // attach to the new element — but must NOT re-run on every incoming
  // screencast frame (see the {type:'frame'} handler), which would tear
  // down and rebuild the listeners mid-gesture, silently discarding the
  // in-flight BrowserTouchGesture (pendingDx/Dy, tap-vs-swipe
  // classification). Coordinate scaling reads `frameDimensionsRef.current`
  // instead of depending on `frameDimensions` state for that reason.
  //
  // Issue #403 (touch scroll inertia): a swipe's outgoing mouseWheel sends
  // are coalesced to once per rAF (not a fixed-ms throttle), and touchend
  // hands off to a time-based inertia coast using browserWheelGesture.ts's
  // physics (WheelVelocityTracker + BrowserWheelInertia) — see startInertia
  // below. task/224's terminal-side touchScrollPhysics.ts is intentionally
  // NOT reused here: that one quantizes into xterm line units, this one
  // needs raw pixel deltas for a 1:1-scrolling remote page; only the tuned
  // physics constants (half-life, thresholds) are kept in sync between the
  // two, not the code.
  useEffect(() => {
    const canvas = canvasEl;
    if (!canvas) return;

    const gesture = new BrowserTouchGesture();
    // Issue #403: tracks position/time samples for the current gesture so a
    // touchend can estimate a release velocity and kick off inertia — see
    // browserWheelGesture.ts for the physics.
    const velocityTracker = new WheelVelocityTracker();
    // Identifier of the single finger the current gesture is tracking. A
    // second finger touching down mid-gesture cancels it outright (see
    // onTouchStart/onTouchMove below) rather than being tracked as a
    // separate pointer — this view has no pinch/two-finger gesture of its
    // own, so the only thing multi-touch must do is stop a stray second
    // finger from being read as (or interrupting) a tap/swipe. Once set,
    // subsequent move/end events are matched against this id so a *different*
    // finger's touchend can't prematurely end this gesture.
    let activeTouchId: number | null = null;

    // Issue #403: touchmove only accumulates into `gesture`; the actual
    // mouseWheel send is coalesced to once per animation frame rather than a
    // fixed-ms timestamp throttle, so the outgoing rate naturally tracks the
    // display's refresh rate instead of an arbitrary constant.
    let moveRafId: number | null = null;
    let lastMoveClientX = 0;
    let lastMoveClientY = 0;

    // Issue #403: the inertia rAF loop started from onTouchEnd's release
    // velocity, if any. Only one can run at a time (a new touchstart or
    // touchcancel stops it — see below).
    let inertiaRafId: number | null = null;

    const cancelMoveFlush = () => {
      if (moveRafId !== null) {
        cancelAnimationFrame(moveRafId);
        moveRafId = null;
      }
    };

    const stopInertia = () => {
      if (inertiaRafId !== null) {
        cancelAnimationFrame(inertiaRafId);
        inertiaRafId = null;
      }
    };
    stopInertiaRef.current = stopInertia;

    const toCanvasScale = () => {
      const rect = canvas.getBoundingClientRect();
      const { cssW, cssH } = frameDimensionsRef.current;
      return { rect, scaleX: cssW / rect.width, scaleY: cssH / rect.height };
    };

    // Issue #403 review follow-up: Workspace tab switching can leave this
    // BrowserView mounted but CSS-hidden (display:none on an ancestor)
    // rather than unmounting it, so neither the effect's cleanup nor
    // canvasEl changes — without this check, an in-flight rAF loop (move
    // flush or inertia) would keep sending mouseWheel for up to ~2s after
    // the tab is switched away, visible to every other viewer of this
    // shared browser. `offsetParent` is null whenever any ancestor (or the
    // element itself) has `display:none`; this workspace's hidden-tab
    // mechanism is exactly that (no `position:fixed` ancestor is used for
    // hiding here, which is the one case `offsetParent` doesn't catch).
    // `isConnected` additionally covers the element having been removed
    // from the document entirely.
    const isCanvasVisible = () => canvas.isConnected && canvas.offsetParent !== null;

    const sendTap = (kind: string, clientX: number, clientY: number) => {
      const { rect, scaleX, scaleY } = toCanvasScale();
      sendMessage({
        type: 'mouse',
        kind,
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
        button: 'left',
      });
    };

    // Issue #403: deltaX/deltaY must be scaled the same way x/y are (the
    // canvas's CSS size and the remote page's CSS viewport size — cssW/cssH —
    // aren't necessarily equal to the canvas's on-screen rect), or a swipe
    // scrolls a different amount than the finger's actual on-screen travel
    // whenever the canvas is rendered at other than 1:1.
    const sendWheel = (dx: number, dy: number, clientX: number, clientY: number): boolean => {
      const { rect, scaleX, scaleY } = toCanvasScale();
      return sendMessage({
        type: 'mouse',
        kind: 'mouseWheel',
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
        // Content follows the finger: dragging up (negative dy) reveals content
        // below, i.e. scrolls down — the same sign convention as a native touch
        // scroll, and the inverse of raw finger movement.
        deltaX: -dx * scaleX,
        deltaY: -dy * scaleY,
      });
    };

    const scheduleMoveFlush = () => {
      if (moveRafId !== null) return;
      moveRafId = requestAnimationFrame(() => {
        moveRafId = null;
        // See isCanvasVisible()'s comment: a CSS-hidden-but-still-mounted
        // canvas must not keep sending mouseWheel to the shared browser.
        if (!isCanvasVisible()) return;
        const { dx, dy } = gesture.takePending();
        if (dx === 0 && dy === 0) return;
        sendWheel(dx, dy, lastMoveClientX, lastMoveClientY);
      });
    };

    // Issue #403: starts the inertia rAF loop from the touchend's estimated
    // release velocity, if it's above the minimum threshold. Coordinates
    // stay fixed at the last valid touch position for the whole coast (the
    // finger is no longer on the surface to update them).
    const startInertia = (endT: number, clientX: number, clientY: number) => {
      const { vx, vy } = velocityTracker.releaseVelocity(endT);
      const inertia = new BrowserWheelInertia(vx, vy);
      if (inertia.done) return; // below INERTIA_MIN_VELOCITY, or a stale release

      let lastFrameTime: number | null = null;
      const tick = (now: number) => {
        // See isCanvasVisible()'s comment: stop coasting rather than send
        // mouseWheel to a shared browser the user is no longer looking at.
        if (!isCanvasVisible()) {
          inertiaRafId = null;
          return;
        }
        if (lastFrameTime === null) lastFrameTime = now;
        const dtMs = now - lastFrameTime;
        lastFrameTime = now;
        const { x: dx, y: dy } = inertia.step(dtMs);
        let sent = true;
        if (dx !== 0 || dy !== 0) {
          sent = sendWheel(dx, dy, clientX, clientY);
        }
        // Stop conditions: velocity decayed below threshold, or the socket
        // is no longer open (a real disconnect — a tab switch instead swaps
        // wsRef to a new, open connection without sendMessage ever
        // returning false, which is why tab switches are stopped separately
        // via stopInertiaRef in the WS-reset effect, not detected here).
        if (inertia.done || !sent) {
          inertiaRafId = null;
          return;
        }
        inertiaRafId = requestAnimationFrame(tick);
      };
      inertiaRafId = requestAnimationFrame(tick);
    };

    const onTouchStart = (e: TouchEvent) => {
      // A new touch grabs the content — any residual momentum from a
      // previous swipe must stop, same as a finger landing on a natively
      // coasting scroll view.
      stopInertia();
      // A second finger touching down turns this into a multi-touch
      // interaction this view has no gesture for (no pinch-zoom, no
      // two-finger scroll) — discard whatever single-finger gesture was in
      // flight so it can't resolve into an unintended tap/scroll, and don't
      // start tracking a new one until back down to one finger.
      if (e.touches.length > 1) {
        gesture.cancel();
        cancelMoveFlush();
        activeTouchId = null;
        return;
      }
      const touch = e.touches[0];
      if (!touch) return;
      activeTouchId = touch.identifier;
      gesture.start(touch.clientX, touch.clientY);
      velocityTracker.reset();
      velocityTracker.addSample(touch.clientX, touch.clientY, e.timeStamp);
      // Deliberately no anchorImeInput()/hiddenInputRef focus() here: on
      // touch devices, focusing the hidden input pops the OS keyboard,
      // which shrinks the visualViewport and fires a ResizeObserver-driven
      // remote viewport resize mid-swipe. Touch-to-keyboard input is
      // reintroduced by a later issue (an explicit keyboard toggle); mouse
      // clicks still focus it in handleMouseDown.
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        gesture.cancel();
        cancelMoveFlush();
        activeTouchId = null;
        return;
      }
      // Only ever one touch on the surface here (the `length > 1` branch
      // above returns early), but still match by identifier rather than
      // indexing [0] for consistency with onTouchEnd's changedTouches
      // lookup, where a stale/mismatched identifier must not be acted on.
      const touch = Array.from(e.touches).find((t) => t.identifier === activeTouchId);
      if (!touch) return;
      e.preventDefault();

      gesture.accumulate(touch.clientX, touch.clientY);
      velocityTracker.addSample(touch.clientX, touch.clientY, e.timeStamp);
      lastMoveClientX = touch.clientX;
      lastMoveClientY = touch.clientY;
      // Below the tap threshold, movement is only accumulated inside
      // `gesture` — no wheel is sent, so a tap never produces a stray
      // scroll. The rAF flush below (via takePending) still receives all of
      // it once the threshold is crossed.
      if (!gesture.isScrolling()) return;

      scheduleMoveFlush();
    };

    const onTouchEnd = (e: TouchEvent) => {
      // Only the finger this gesture started with may end it — a *different*
      // finger lifting (the tracked one is still down, e.g. after a
      // multi-touch cancel left activeTouchId null, or in a rare
      // browser-dependent multi-touch sequence) must not trigger a tap/flush
      // for a gesture that either isn't this touch's or was already
      // cancelled.
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === activeTouchId);
      if (!touch) return;
      activeTouchId = null;
      cancelMoveFlush();
      // gesture.end() doesn't reset the scrolling flag (only cancel()/start()
      // do), so this reads the pre-end() classification: true for both a
      // 'flush' and a 'none' result (a swipe whose last bit was already sent
      // by the rAF flush above), false only for 'tap'.
      const wasScrolling = gesture.isScrolling();
      const result = gesture.end();
      if (result.type === 'flush') {
        // Any movement accumulated since the last rAF flush (including a
        // swipe short enough to never get one) must still reach the page.
        sendWheel(result.dx, result.dy, touch.clientX, touch.clientY);
      } else if (result.type === 'tap') {
        // A swipe that never crossed the tap threshold is a tap: click at
        // the (start ≈ end) position.
        //
        // #401（キーボードトグル導入）までの暫定対応: iOS 等はイベントハンドラの
        // 同期スタック内で呼ばれた focus() でしかソフトキーボードを開けないため、
        // ここで同期的に anchorImeInput()+focus() する。タップ先が実際に編集可能
        // でなければ、直後に送る queryEditable の応答で blur して閉じる
        // （touchFocusPendingRef 経由、ws.onmessage の {type:'editable'} 分岐）。
        // requestId は連打時の取り違え防止（古いタップの応答が新しいタップの
        // pending 状態を誤って処理しないよう、一致する応答だけを処理する）。
        // キーボードが一瞬開いて閉じるチラつきは許容 — canvas コンテナの resize
        // は 300ms debounce なので、素早い blur ならリモート viewport resize は
        // 発生しない。
        anchorImeInput(touch.clientX, touch.clientY);
        hiddenInputRef.current?.focus();
        const requestId = ++queryEditableSeqRef.current;
        touchFocusPendingRef.current = requestId;
        sendTap('mousePressed', touch.clientX, touch.clientY);
        sendTap('mouseReleased', touch.clientX, touch.clientY);
        const sent = sendMessage({ type: 'queryEditable', requestId });
        if (!sent) {
          // WS が閉じていて問い合わせが送れなかった — 応答は永遠に来ないので、
          // 先に focus してしまった分をここで即座に取り消す。
          touchFocusPendingRef.current = null;
          hiddenInputRef.current?.blur();
        }
      }
      // Issue #403: a swipe (not a tap) hands off to inertia, using the
      // release velocity estimated from the samples gathered during the
      // gesture. Runs after the final flush/tap send above so ordering on
      // the wire matches the finger's actual motion.
      if (wasScrolling) {
        startInertia(e.timeStamp, touch.clientX, touch.clientY);
      }
      lastTouchEndAtRef.current = Date.now();
      // Suppresses the browser's synthetic compatibility mouse events
      // (mousedown/mouseup/click) that would otherwise re-fire this same
      // tap/gesture through onMouseDown/onMouseUp — everything here is
      // already sent explicitly above. isWithinTouchMouseGuard() is a
      // secondary guard for engines that still emit them despite this.
      if (e.cancelable) e.preventDefault();
    };

    const onTouchCancel = () => {
      // Discard in-flight gesture state so the (now-aborted) sequence
      // produces neither a wheel flush nor a tap, and stop any inertia coast
      // in progress (explicit stop condition, alongside a new touchstart).
      gesture.cancel();
      cancelMoveFlush();
      stopInertia();
      activeTouchId = null;
    };

    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    // passive:false so preventDefault() (above) can suppress the browser's
    // synthetic compatibility mouse events following this touch sequence.
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);
      cancelMoveFlush();
      stopInertia();
      if (stopInertiaRef.current === stopInertia) stopInertiaRef.current = null;
    };
  }, [canvasEl, sendMessage, anchorImeInput]);

  const devtoolsUrl = `/api/browser/devtools?server=${encodeURIComponent(serverName)}&group=${encodeURIComponent(groupId)}&page=${encodeURIComponent(activeTabId)}`;

  // Only show the start page once we actually know the tab is blank — never
  // during the initial connecting gap before any {type:'url'} has arrived.
  const showStartPage = receivedUrl !== null && (receivedUrl === '' || receivedUrl === 'about:blank');

  const statusColor = connectionState === 'connected' ? 'var(--success)'
    : connectionState === 'connecting' ? 'var(--warning)'
    : 'var(--danger)';

  const statusLabel = connectionState === 'connected' ? 'Connected'
    : connectionState === 'connecting' ? 'Connecting...'
    : connectionState === 'error' ? 'Error'
    : 'Disconnected';

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      {/* Chromium tab strip (grouped by browser window / groupId) */}
      <div style={{
        display: 'flex', alignItems: 'stretch', flexShrink: 0,
        background: 'var(--bg-card)', overflowX: 'auto',
      }}>
        <MiniTabBar
          tabs={tabs.map((tab) => ({
            key: tab.tabId,
            label: tabLabel(tab.url, tab.title, t('newTab')),
            title: tabTooltip(tab.url, t('newTab')),
            prefix: tab.loading
              ? <span className="browser-tab-spinner" aria-hidden="true" />
              : <TabFavicon />,
            extra: tabs.length > 1 ? (
              <span
                role="button"
                tabIndex={0}
                title={t('closeTab')}
                aria-label={t('closeTabLabel', { name: tabLabel(tab.url, tab.title, t('newTab')) })}
                onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.tabId); }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  handleCloseTab(tab.tabId);
                }}
                className="icon-btn"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16,
                  color: 'var(--text-dim)', cursor: 'pointer', fontSize: 'var(--font-sm)', lineHeight: 1,
                }}
              >
                <Icon name="close" size={14} />
              </span>
            ) : undefined,
          }))}
          activeKey={activeTabId}
          onSelect={setActiveTabId}
        />
        <IconButton
          title={t('newTab')}
          aria-label={t('newTab')}
          onClick={handleOpenTab}
          style={{ flexShrink: 0, alignSelf: 'center', margin: '0 var(--space-2)' }}
        >
          <Icon name="plus" size={16} />
        </IconButton>
      </div>

      {/* URL Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
        padding: 'var(--space-2) var(--space-3)',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-card)',
        flexShrink: 0,
        position: 'relative',
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor, flexShrink: 0,
        }} title={statusLabel} />
        <IconButton
          title="Back"
          aria-label="Back"
          onClick={handleBack}
          disabled={connectionState !== 'connected'}
        >
          <svg viewBox="0 0 16 16" style={{ width: 15, height: 15 }} aria-hidden="true">
            <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
        <IconButton
          title="Forward"
          aria-label="Forward"
          onClick={handleForward}
          disabled={connectionState !== 'connected'}
        >
          <svg viewBox="0 0 16 16" style={{ width: 15, height: 15 }} aria-hidden="true">
            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
        <IconButton
          title={isLoading ? 'Stop loading' : 'Reload'}
          aria-label={isLoading ? 'Stop loading' : 'Reload'}
          onClick={handleReloadOrStop}
          disabled={connectionState !== 'connected'}
          style={{ position: 'relative', width: 28, height: 28 }}
        >
          {isLoading && <span className="browser-reload-ring" aria-hidden="true" />}
          {isLoading ? (
            <svg viewBox="0 0 16 16" style={{ width: 9, height: 9 }} aria-hidden="true">
              <path d="M3 3h10v10H3z" fill="currentColor" />
            </svg>
          ) : (
            <Icon name="refresh" size={14} />
          )}
        </IconButton>
        <input
          type="text"
          value={url}
          onChange={handleUrlChange}
          onFocus={handleUrlFocus}
          onBlur={handleUrlBlur}
          onKeyDown={handleUrlKeyDown}
          placeholder="Enter URL..."
          style={{
            flex: 1, background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', padding: '4px 8px',
            color: 'var(--text)', fontSize: 'var(--font-sm)',
            outline: 'none',
          }}
          aria-label="URL"
        />
        <button
          onClick={handleNavigate}
          style={{
            background: 'var(--accent-a15)', border: '1px solid var(--accent)',
            borderRadius: 'var(--radius-sm)', padding: '4px 12px',
            color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--font-sm)',
            flexShrink: 0,
          }}
        >
          Go
        </button>
        <IconButton
          title="History"
          aria-label="History"
          aria-expanded={historyOpen}
          aria-haspopup="true"
          onClick={() => setHistoryOpen((v) => !v)}
          disabled={history.length === 0}
        >
          <svg viewBox="0 0 16 16" style={{ width: 14, height: 14 }} aria-hidden="true">
            <path d="M8 3v5l3 3" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeWidth={1.4} />
          </svg>
        </IconButton>
        <a
          href={devtoolsUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: 'var(--text-dim)', fontSize: 'var(--font-xs)',
            textDecoration: 'none', flexShrink: 0,
          }}
          title="Open DevTools"
        >
          DevTools
        </a>
        <div
          className={`browser-progress-track${isLoading ? ' is-loading' : ''}`}
          aria-hidden="true"
        />
        {historyOpen && (
          <BrowserHistoryDropdown
            history={history}
            onSelect={(item) => { navigateTo(item); setHistoryOpen(false); }}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      {/* Browser Canvas */}
      <div ref={canvasContainerRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {showStartPage ? (
          <BrowserStartPage serverName={serverName} onQuickLink={navigateTo} />
        ) : connectionState === 'error' && errorMessage ? (
          <div style={{
            color: 'var(--danger)', padding: 'var(--space-4)',
            textAlign: 'center', fontSize: 'var(--font-sm)',
          }}>
            {errorMessage}
          </div>
        ) : (
          <canvas
            ref={setCanvasRef}
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              cursor: cursorStyle,
              background: 'var(--bg-card)',
              // Belt-and-suspenders alongside touchmove's preventDefault():
              // stops the browser from ever starting its own native
              // scroll/zoom gesture on this canvas.
              touchAction: 'none',
            }}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
            onWheel={handleWheel}
            onContextMenu={handleContextMenu}
          />
        )}
        <BrowserDialog dialog={pendingDialog} onResponse={handleDialogResponse} onAuthResponse={handleAuthResponse} />
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          tabIndex={-1}
          aria-hidden="true"
        />
        {Array.from(peerCursors.entries()).map(([id, cursor]) => (
          <PeerCursorMarker
            key={id}
            id={id}
            leftPct={(cursor.x / frameDimensions.cssW) * 100}
            topPct={(cursor.y / frameDimensions.cssH) * 100}
          />
        ))}

        {/* Hidden input for IME/keyboard — kept 1x16px and invisible, but tracked to
            the last click/tap point (relative to this container) so the OS IME
            candidate window anchors near the caret instead of off-screen. */}
        <input
          ref={hiddenInputRef}
          style={{
            position: 'absolute',
            left: imeAnchor.left, top: imeAnchor.top,
            width: 1, height: 16, opacity: 0, pointerEvents: 'none', zIndex: 20,
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onCompositionStart={handleCompositionStart}
          onCompositionUpdate={handleCompositionUpdate}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleInput}
          onPaste={handlePaste}
          autoComplete="off"
          aria-label={t('keyboardInputAriaLabel')}
        />
      </div>
    </div>
  );
}

// 12px line-art globe favicon shown for tabs that aren't currently loading
// (loading tabs show browser-tab-spinner instead). Renders in the tab's
// text-dim color via currentColor.
function TabFavicon() {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>
      <circle cx={6} cy={6} r={5} fill="none" stroke="currentColor" strokeWidth={1.2} />
      <path d="M6 1c-2 2-2 8 0 10M1 6h10" fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  );
}

interface StartPageTip {
  icon: React.ReactNode;
  titleKey: string;
  descriptionKey: string;
}

const START_PAGE_TIPS: StartPageTip[] = [
  {
    icon: (
      <path d="M7 15l3-3 2 2 4-4" />
    ),
    titleKey: 'startPage.tips.localhost.title',
    descriptionKey: 'startPage.tips.localhost.description',
  },
  {
    icon: (
      <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />
    ),
    titleKey: 'startPage.tips.devtools.title',
    descriptionKey: 'startPage.tips.devtools.description',
  },
  {
    icon: (
      <path d="M4 4l7 16 2-7 7-2z" />
    ),
    titleKey: 'startPage.tips.cursor.title',
    descriptionKey: 'startPage.tips.cursor.description',
  },
  {
    icon: (
      <path d="M12 17.5v.01" />
    ),
    titleKey: 'startPage.tips.touch.title',
    descriptionKey: 'startPage.tips.touch.description',
  },
];

interface BrowserStartPageProps {
  serverName: string;
  onQuickLink: (url: string) => void;
}

// Shown in place of the screencast canvas while the active tab is blank
// (empty URL / about:blank) — mirrors the approved UI mock's `.startpage`.
function BrowserStartPage({ serverName, onQuickLink }: BrowserStartPageProps) {
  const { t } = useTranslation('browser');
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 22,
      background: 'var(--bg)', color: 'var(--text)', padding: 'var(--space-6)', textAlign: 'center',
      overflowY: 'auto',
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 'var(--radius-lg)',
        background: 'var(--accent-a15)', border: '1px solid var(--accent-a35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }} aria-hidden="true">
        <svg viewBox="0 0 24 24" width={26} height={26}>
          <circle cx={12} cy={12} r={9} fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeLinecap="round" />
          <path
            d="M3.5 12h17M12 3.5c-4.5 4.8-4.5 12.2 0 17M12 3.5c4.5 4.8 4.5 12.2 0 17"
            fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeLinecap="round"
          />
        </svg>
      </div>
      <div>
        <h4 style={{ fontSize: 'var(--font-md)', fontWeight: 600, margin: 0 }}>
          {t('startPage.title', { serverName })}
        </h4>
        <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', margin: '6px 0 0', maxWidth: '46ch' }}>
          {t('startPage.description')}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
        {QUICK_LINKS.map((link) => (
          <button
            key={link.url}
            onClick={() => onQuickLink(link.url)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-full)', color: 'var(--text)', fontSize: 'var(--font-sm)',
              cursor: 'pointer', fontFamily: 'ui-monospace, "SF Mono", monospace',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)';
              e.currentTarget.style.color = 'var(--accent)';
              e.currentTarget.style.background = 'var(--accent-a08)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border)';
              e.currentTarget.style.color = 'var(--text)';
              e.currentTarget.style.background = 'var(--bg-card)';
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: link.dotColor ?? 'var(--success)', flexShrink: 0,
            }} />
            {link.label}
          </button>
        ))}
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 'var(--space-2)', width: 'min(560px, 100%)', marginTop: 4,
      }}>
        {START_PAGE_TIPS.map((tip) => (
          <div
            key={tip.titleKey}
            style={{
              display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', textAlign: 'left',
              padding: '9px 11px', background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <svg viewBox="0 0 24 24" width={14} height={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true">
              <g fill="none" stroke="var(--accent)" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                {tip.icon}
              </g>
            </svg>
            <div>
              <b style={{ display: 'block', fontSize: 'var(--font-xs)', fontWeight: 600 }}>{t(tip.titleKey)}</b>
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', lineHeight: 1.5 }}>{t(tip.descriptionKey)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PeerCursorMarkerProps {
  id: number;
  leftPct: number;
  topPct: number;
}

interface BrowserHistoryDropdownProps {
  history: string[];
  onSelect: (url: string) => void;
  onClose: () => void;
}

function BrowserHistoryDropdown({ history, onSelect, onClose }: BrowserHistoryDropdownProps) {
  const { t } = useTranslation('browser');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const reversed = [...history].reverse();

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('historyAriaLabel')}
      style={{
        position: 'absolute',
        top: '100%',
        right: 'var(--space-3)',
        zIndex: 50,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
        maxHeight: 280,
        overflowY: 'auto',
        minWidth: 240,
        maxWidth: 420,
        padding: 4,
      }}
    >
      {reversed.map((item, i) => (
        <button
          key={`${item}-${i}`}
          role="menuitem"
          onClick={() => onSelect(item)}
          style={{
            display: 'block',
            width: '100%',
            border: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontSize: 'var(--font-xs)',
            fontFamily: 'ui-monospace, "SF Mono", monospace',
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            textAlign: 'left',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-a08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function PeerCursorMarker({ id, leftPct, topPct }: PeerCursorMarkerProps) {
  const color = PEER_CURSOR_COLORS[id % PEER_CURSOR_COLORS.length];
  return (
    <div
      style={{
        position: 'absolute',
        left: `${leftPct}%`,
        top: `${topPct}%`,
        pointerEvents: 'none',
        transform: 'translate(-2px, -2px)',
        zIndex: 10,
      }}
    >
      <svg width="12" height="16" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M1 1L1 13.5L4.3 10.4L6.3 15L8.4 14.1L6.4 9.5L11 9.4L1 1Z"
          fill={color}
          stroke="var(--bg)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
