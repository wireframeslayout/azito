export interface BrowserFrame {
  type: 'frame';
  data: string;
  cssW: number;
  cssH: number;
}

export type BrowserInput =
  | { type: 'mouse'; kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
      x: number; y: number; button?: 'left' | 'right' | 'middle'; deltaX?: number; deltaY?: number }
  | { type: 'key'; kind: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number; text?: string }
  | { type: 'insertText'; text: string }
  | { type: 'composition'; text: string; selectionStart: number; selectionEnd: number }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'stopLoading' }
  | { type: 'resize'; width: number; height: number }
  // #401（キーボードトグル導入）までの暫定対応: タッチのタップで同期 focus した
  // 直後にクライアントが送る問い合わせ。フォーカス先が実際に編集可能でなければ、
  // クライアント側で hidden input を blur してソフトキーボードを閉じる判断材料
  // にする。dispatchInput には流さず、browserHandler.ts が直接応答する。
  // requestId はクライアントが単調増加カウンタで採番し、応答にそのままエコー
  // される（連打時に古い応答で新しいタップの pending 状態を誤って処理しないため）。
  | { type: 'queryEditable'; requestId: number }
  | { type: 'copySelection' };

// Tab lifecycle messages: handled directly by the WS handler against the
// shared BrowserSession (group-scoped), never forwarded to BrowserPage.dispatchInput.
export type BrowserTabInput =
  | { type: 'openTab'; tabId: string }
  | { type: 'closeTab'; tabId: string };

export interface BrowserTabsMessage {
  type: 'tabs';
  tabs: { tabId: string; url: string | null; loading: boolean; title: string | null }[];
}

export interface BrowserUrlMessage {
  type: 'url';
  url: string;
}

export interface BrowserLoadingMessage {
  type: 'loading';
  loading: boolean;
}

export interface BrowserCursorMessage {
  type: 'cursor';
  cursor: string;
}

export interface BrowserPeerCursorMessage {
  type: 'peerCursor';
  id: number;
  x: number;
  y: number;
}

export interface BrowserPeerLeftMessage {
  type: 'peerLeft';
  id: number;
}

// Response to {type:'queryEditable'} — see the comment on that variant above.
// requestId echoes the request's requestId verbatim so the client can ignore
// a stale response from an earlier tap.
export interface BrowserEditableMessage {
  type: 'editable';
  editable: boolean;
  requestId: number;
}
