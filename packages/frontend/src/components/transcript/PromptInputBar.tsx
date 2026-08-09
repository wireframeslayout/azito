import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Spinner';
import { clearDraft, createDebouncedDraftSaver, loadDraft } from './transcriptDrafts';
import { loadHistory, pushHistory } from './inputHistory';
import { HistoryPopover } from './HistoryPopover';
import { PaneChip } from './PaneChip';
import { resolveStoredPaneSelection, writeStoredPaneSelection } from './paneSelectionStorage';
import { isErrorResponse } from './transcriptFormat';
import type { PaneCandidate, PaneCandidatesResult, TranscriptErrorResponse } from './transcriptTypes';

const TEXTAREA_MIN_HEIGHT = 38;
const TEXTAREA_MAX_HEIGHT = 120;
const DRAFT_SAVE_DEBOUNCE_MS = 300;
const RESTORED_HINT_MS = 1500;

interface PromptInputBarProps {
  sessionId: string;
  /** 送信成功直後に呼ばれる(最下部へスクロールするため)。新着メッセージ自体はポーリングで反映される。 */
  onSent: () => void;
}

/**
 * 会話ビュー下部の固定入力バー。cwd が一致する tmux ペインへプロンプトを送信する。
 * 送信内容自体は既存の JSONL ポーリングで会話に反映される（オプティミスティック表示はしない）。
 * ペインチップ＋textarea＋履歴🕘＋送信↑ の1行構成（SP実機の高さ節約のため）。
 */
export default function PromptInputBar({ sessionId, onSent }: PromptInputBarProps) {
  const { t } = useTranslation('transcript');
  const [panes, setPanes] = useState<PaneCandidate[]>([]);
  const [panesLoaded, setPanesLoaded] = useState(false);
  const [panesError, setPanesError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [text, setText] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = 履歴を辿っていない
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showRestoredHint, setShowRestoredHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftSaverRef = useRef(createDebouncedDraftSaver(DRAFT_SAVE_DEBOUNCE_MS));

  // 会話ビュー表示時（セッション切り替え時、または再試行時）に候補ペインを取得し、自動選択 or 復元する。
  useEffect(() => {
    let cancelled = false;
    setPanesLoaded(false);
    setPanesError(null);
    setPanes([]);
    setSelectedPaneId(null);
    setSendError(null);

    apiWithStatus<PaneCandidatesResult | TranscriptErrorResponse>(`/transcripts/${encodeURIComponent(sessionId)}/panes`)
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status !== 200 || isErrorResponse(body)) {
          setPanesLoaded(true);
          setPanesError(isErrorResponse(body) ? body.error : t('promptBar.loadError'));
          return;
        }
        setPanes(body.panes);
        setPanesLoaded(true);

        const storedPane = resolveStoredPaneSelection(sessionId, body.panes);
        if (storedPane) {
          setSelectedPaneId(storedPane.paneId);
          return;
        }
        const matched = body.panes.filter((p) => p.cwdMatch);
        if (matched.length === 1) {
          setSelectedPaneId(matched[0].paneId);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPanesLoaded(true);
          setPanesError(err instanceof Error ? err.message : t('promptBar.loadError'));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadTick, t]);

  // セッション切り替え時に下書きを復元する（F2）。復元があった場合のみ短時間ヒントを出す。
  // 直前のセッションでタイマーが残っていてもここで必ず setShowRestoredHint を再設定するため、
  // 「復元」表示が次のセッションに残留することはない（クリーンアップでタイマーは毎回破棄される）。
  useEffect(() => {
    const draft = loadDraft(sessionId);
    setText(draft);
    setHistoryIndex(-1);
    setShowRestoredHint(draft !== '');
    if (draft !== '') {
      const timer = setTimeout(() => setShowRestoredHint(false), RESTORED_HINT_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [sessionId]);

  // 入力変更を300msデバウンスして下書き保存する（F2）。
  useEffect(() => {
    draftSaverRef.current.schedule(sessionId, text);
  }, [sessionId, text]);

  // アンマウント時・セッション切り替え時は、保留中の保存を cancel せず flush する
  // （300ms未満での離脱・切り替えによる最新下書きの取りこぼしを防ぐ）。
  useEffect(() => {
    const saver = draftSaverRef.current;
    return () => {
      saver.flush();
    };
  }, [sessionId]);

  // テキスト内容に応じて textarea の高さを追従させる（ユーザー入力・履歴挿入・送信後クリアの全経路）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px';
  }, [text]);

  const retryLoadPanes = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  const selectPane = useCallback((pane: PaneCandidate) => {
    setSelectedPaneId(pane.paneId);
    writeStoredPaneSelection(sessionId, pane);
  }, [sessionId]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !selectedPaneId || sending) return;

    setSending(true);
    setSendError(null);
    try {
      const { status, body } = await apiWithStatus<{ ok: true } | TranscriptErrorResponse>(
        `/transcripts/${encodeURIComponent(sessionId)}/input`,
        { method: 'POST', body: JSON.stringify({ paneId: selectedPaneId, text: trimmed }) },
      );
      if (status !== 200 || isErrorResponse(body)) {
        setSendError(isErrorResponse(body) ? body.error : t('promptBar.sendError'));
        return;
      }
      setText('');
      setHistoryIndex(-1);
      clearDraft(sessionId);
      pushHistory(trimmed);
      onSent();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : t('promptBar.sendError'));
    } finally {
      setSending(false);
    }
  }, [text, selectedPaneId, sending, sessionId, onSent, t]);

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
      const history = loadHistory();
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
      const history = loadHistory();
      setHistoryIndex(nextIndex);
      setText(history[nextIndex] ?? '');
    }
  };

  const selectedPane = panes.find((p) => p.paneId === selectedPaneId) ?? null;
  const canSend = text.trim().length > 0 && selectedPaneId !== null && !sending;

  return (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-card)',
        padding: '8px 16px calc(8px + env(safe-area-inset-bottom))',
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

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <PaneChip
          panes={panes}
          panesLoaded={panesLoaded}
          panesError={panesError}
          selectedPane={selectedPane}
          onSelect={selectPane}
          onRetry={retryLoadPanes}
        />

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
            <HistoryPopover onSelect={insertFromHistory} onClose={() => setHistoryOpen(false)} />
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
