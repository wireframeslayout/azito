import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Spinner';
import { TerminalChatToggle, type WindowViewMode } from '../ui/TerminalChatToggle';
import { clearDraft, createDebouncedDraftSaver, loadDraft } from './transcriptDrafts';
import { loadHistory, pushHistory } from './inputHistory';
import { HistoryPopover } from './HistoryPopover';
import { StyleSwitcher } from './StyleSwitcher';
import { useTranscriptStyle } from './transcriptStyle';
import { isErrorResponse } from './transcriptFormat';
import type { TranscriptErrorResponse } from './transcriptTypes';

const TEXTAREA_MIN_HEIGHT = 38;
const TEXTAREA_MAX_HEIGHT = 120;
const DRAFT_SAVE_DEBOUNCE_MS = 300;
const RESTORED_HINT_MS = 1500;

interface PromptInputBarProps {
  windowId: number;
  /** 送信先ペイン。resolve-window が固定で解決した値（ユーザー選択なし、Issue #69 仕様調整3で
   * ペインセレクトを撤去した）。 */
  paneId: string;
  /** 下書き・入力履歴の永続化キー。セッション確立後は sessionId、未確立の会話開始前は
   * `window-${windowId}` のような呼び出し側で用意した安定キーを渡す。 */
  draftKey: string;
  /** false の場合、このウィンドウでエージェントが起動していないかもしれないという注記を出す
   * （フェイルセーフ。送信自体はブロックしない）。 */
  agentDetected: boolean;
  /**
   * ↑↓・🕘 履歴の主ソース（Issue #69 仕様調整4）: 会話トランスクリプトの user 発話（新しい順）。
   * これが0件の場合（セッション未確立の pane-only モード等でトランスクリプトを取得できない場合）
   * のみ、localStorage のローカル送信履歴（inputHistory.ts）にフォールバックする。
   */
  contextHistory: string[];
  /** 送信成功直後に呼ばれる(最下部へスクロールするため)。新着メッセージ自体はポーリングで反映される。 */
  onSent: () => void;
  /** SP 端末⇄チャットのミニトグル（Issue #69 S8）。TerminalContainer/WindowChatPanel/
   * ConversationView 経由で渡された場合のみバー左端に描画する（省略時はトグル自体を出さない
   * — デスクトップ、あるいは呼び出し元が viewMode を管理していない経路）。 */
  viewMode?: WindowViewMode;
  onChangeViewMode?: (mode: WindowViewMode) => void;
}

/**
 * 会話ビュー下部の固定入力バー。resolve-window が固定したペインへプロンプトを送信する
 * （Issue #69 仕様調整3: ペイン選択 UI を撤去し、常に window-input API 経由で送る）。
 * 送信内容自体は既存の JSONL ポーリングで会話に反映される（オプティミスティック表示はしない）。
 * textarea＋履歴🕘＋送信↑ の1行構成（SP実機の高さ節約のため）。
 */
export default function PromptInputBar({ windowId, paneId, draftKey, agentDetected, contextHistory, onSent, viewMode, onChangeViewMode }: PromptInputBarProps) {
  const { t } = useTranslation('transcript');
  const [style, setStyle] = useTranscriptStyle();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [text, setText] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = 履歴を辿っていない
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showRestoredHint, setShowRestoredHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftSaverRef = useRef(createDebouncedDraftSaver(DRAFT_SAVE_DEBOUNCE_MS));

  // セッション切り替え時は前セッションの送信エラー表示を持ち越さない。
  useEffect(() => {
    setSendError(null);
  }, [draftKey]);

  // セッション切り替え時に下書きを復元する（F2）。復元があった場合のみ短時間ヒントを出す。
  // 直前のセッションでタイマーが残っていてもここで必ず setShowRestoredHint を再設定するため、
  // 「復元」表示が次のセッションに残留することはない（クリーンアップでタイマーは毎回破棄される）。
  useEffect(() => {
    const draft = loadDraft(draftKey);
    setText(draft);
    setHistoryIndex(-1);
    setShowRestoredHint(draft !== '');
    if (draft !== '') {
      const timer = setTimeout(() => setShowRestoredHint(false), RESTORED_HINT_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [draftKey]);

  // 入力変更を300msデバウンスして下書き保存する（F2）。
  useEffect(() => {
    draftSaverRef.current.schedule(draftKey, text);
  }, [draftKey, text]);

  // アンマウント時・セッション切り替え時は、保留中の保存を cancel せず flush する
  // （300ms未満での離脱・切り替えによる最新下書きの取りこぼしを防ぐ）。
  useEffect(() => {
    const saver = draftSaverRef.current;
    return () => {
      saver.flush();
    };
  }, [draftKey]);

  // テキスト内容に応じて textarea の高さを追従させる（ユーザー入力・履歴挿入・送信後クリアの全経路）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px';
  }, [text]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setSendError(null);
    try {
      const { status, body } = await apiWithStatus<{ ok: true } | TranscriptErrorResponse>(
        '/transcripts/window-input',
        { method: 'POST', body: JSON.stringify({ windowId, paneId, text: trimmed }) },
      );
      if (status !== 200 || isErrorResponse(body)) {
        setSendError(isErrorResponse(body) ? body.error : t('promptBar.sendError'));
        return;
      }
      setText('');
      setHistoryIndex(-1);
      clearDraft(draftKey);
      pushHistory(trimmed);
      onSent();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : t('promptBar.sendError'));
    } finally {
      setSending(false);
    }
  }, [text, sending, windowId, paneId, draftKey, onSent, t]);

  // 履歴の優先順位（Issue #69 仕様調整4）: 会話トランスクリプトの user 発話（contextHistory）を
  // 主ソースとし、それが0件のとき（セッション未確立の pane-only モード等）のみ localStorage の
  // ローカル送信履歴にフォールバックする。
  const activeHistory = useCallback(
    () => (contextHistory.length > 0 ? contextHistory : loadHistory()),
    [contextHistory],
  );

  const insertFromHistory = useCallback((value: string) => {
    setText(value);
    setHistoryIndex(-1);
    setHistoryOpen(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
      return;
    }
    // IME変換中の矢印キーは候補選択に使われるため履歴ナビゲーションの対象外とする。
    if (e.nativeEvent.isComposing) return;

    if (e.key === 'ArrowUp' && (text.length === 0 || historyIndex !== -1)) {
      const history = activeHistory();
      if (history.length === 0) return;
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      if (nextIndex === historyIndex) return;
      e.preventDefault();
      setHistoryIndex(nextIndex);
      setText(history[nextIndex]);
      return;
    }
    if (e.key === 'ArrowDown' && historyIndex !== -1) {
      e.preventDefault();
      const nextIndex = historyIndex - 1;
      if (nextIndex < 0) {
        setHistoryIndex(-1);
        setText('');
        return;
      }
      const history = activeHistory();
      setHistoryIndex(nextIndex);
      setText(history[nextIndex] ?? '');
    }
  };

  const canSend = text.trim().length > 0 && !sending;

  return (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-card)',
        // safe-area は下段の MobileStatusBar が一括確保する（Issue #338 T13）
        padding: '8px 16px',
      }}
    >
      {/* 復元注記はレイアウト幅に影響させないよう、バー上に絶対配置の1.5秒オーバーレイとして表示する（F2/SP狭幅対策）。 */}
      {showRestoredHint && (
        <div
          role="status"
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 16,
            marginBottom: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-2)',
            fontSize: 'var(--font-2xs)',
            color: 'var(--text-dim)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          <Icon name="edit" size={14} />
          {t('promptBar.draftRestored')}
        </div>
      )}

      {/* SP 端末⇄チャットのミニトグル（Issue #69 S8）— バー左端の独立行。viewMode が渡された
          場合のみ描画する（デスクトップ、あるいは呼び出し元が管理していない経路では出さない）。 */}
      {viewMode !== undefined && onChangeViewMode && (
        <div style={{ marginBottom: 6 }}>
          <TerminalChatToggle value={viewMode} onChange={onChangeViewMode} />
        </div>
      )}

      {/* フェイルセーフ注記（Issue #69 仕様調整3）: pane は解決できているがエージェントらしき
          コマンドが動いていない場合の注意書き。送信自体はブロックしない。 */}
      {!agentDetected && (
        <div
          role="note"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            marginBottom: 6,
            padding: '6px 10px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--warning-a08)',
            border: '1px solid var(--warning-a35)',
            color: 'var(--warning)',
            fontSize: 'var(--font-2xs)',
            lineHeight: 1.4,
          }}
        >
          <Icon name="warning" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t('promptBar.agentNotDetectedWarning')}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHistoryIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={sending}
          placeholder={t('promptBar.placeholder')}
          aria-label={t('promptBar.placeholder')}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 12px',
            color: 'var(--text)',
            fontSize: 'var(--font-base)',
            fontFamily: 'inherit',
            outline: 'none',
            resize: 'none',
            minHeight: TEXTAREA_MIN_HEIGHT,
            maxHeight: TEXTAREA_MAX_HEIGHT,
          }}
        />

        {/* 🎨 表示スタイル切替（Issue #69 S8）: SP コンテンツヘッダーから撤去し、🕘 履歴の隣へ
            移設。viewMode が渡されている＝チャット表示中（TerminalContainer 経由）のときのみ
            描画する — デスクトップの ConversationView 単体埋め込み等、viewMode 制御がない
            経路では従来どおり TerminalContainer 側のツールバーが担う。 */}
        {viewMode !== undefined && onChangeViewMode && (
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <StyleSwitcher value={style} onChange={setStyle} compact />
          </div>
        )}

        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            aria-label={t('promptBar.history')}
            title={t('promptBar.history')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 38,
              height: TEXTAREA_MIN_HEIGHT,
              background: historyOpen ? 'var(--bg-hover)' : 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-dim)',
              cursor: 'pointer',
            }}
          >
            <Icon name="history" size={16} />
          </button>
          {historyOpen && (
            <HistoryPopover entries={activeHistory()} onSelect={insertFromHistory} onClose={() => setHistoryOpen(false)} />
          )}
        </div>

        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          aria-label={t('promptBar.sendWithShortcut')}
          title={t('promptBar.sendWithShortcut')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 38,
            height: TEXTAREA_MIN_HEIGHT,
            flexShrink: 0,
            background: canSend ? 'var(--accent)' : 'var(--bg)',
            border: `1px solid ${canSend ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-md)',
            color: canSend ? 'var(--bg-solid)' : 'var(--text-dim)',
            cursor: canSend ? 'pointer' : 'not-allowed',
            opacity: canSend ? 1 : 0.6,
          }}
        >
          {sending ? <Spinner size={14} color={canSend ? 'var(--bg-solid)' : undefined} /> : <Icon name="arrow-up" size={16} />}
        </button>
      </div>

      {sendError && (
        <div style={{ marginTop: 6, fontSize: 'var(--font-xs)', color: 'var(--danger)' }}>{sendError}</div>
      )}
    </div>
  );
}
