import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Spinner';
import { useClickOutside } from '../../hooks/useClickOutside';
import { isErrorResponse, pathBasename } from './transcriptFormat';
import type { PaneCandidate, PaneCandidatesResult, TranscriptErrorResponse } from './transcriptTypes';

const TEXTAREA_MIN_HEIGHT = 38;
const TEXTAREA_MAX_HEIGHT = 120;

interface PromptInputBarProps {
  sessionId: string;
  /** 送信成功直後に呼ばれる（最下部へスクロールするため）。新着メッセージ自体はポーリングで反映される。 */
  onSent: () => void;
}

function storageKey(sessionId: string): string {
  return `azito.transcript.selectedPane.${sessionId}`;
}

function paneLabel(pane: PaneCandidate): string {
  return `${pane.sessionName}:${pane.windowName}`;
}

interface PanePopoverProps {
  panes: PaneCandidate[];
  selectedPaneId: string | null;
  onSelect: (paneId: string) => void;
  onClose: () => void;
}

function PanePopover({ panes, selectedPaneId, onSelect, onClose }: PanePopoverProps) {
  const { t } = useTranslation('transcript');
  const ref = useClickOutside<HTMLDivElement>(onClose);
  const matched = panes.filter((p) => p.cwdMatch);
  const others = panes.filter((p) => !p.cwdMatch);

  const renderRow = (pane: PaneCandidate) => (
    <button
      key={pane.paneId}
      type="button"
      onClick={() => {
        onSelect(pane.paneId);
        onClose();
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        width: '100%',
        padding: '7px 10px',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: pane.paneId === selectedPaneId ? 'var(--accent-a08)' : 'none',
        color: 'var(--text)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-sm)', fontWeight: 600 }}>
        {paneLabel(pane)}
        {pane.paneId === selectedPaneId && <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />}
      </span>
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {pane.currentCommand || t('promptBar.noCommand')} · …/{pathBasename(pane.currentPath)}
      </span>
    </button>
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('promptBar.selectPane')}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 6,
        zIndex: 100,
        background: 'var(--bg-solid)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-2)',
        minWidth: 260,
        maxWidth: 'min(360px, calc(100vw - 32px))',
        maxHeight: 320,
        overflowY: 'auto',
        padding: 6,
      }}
    >
      {panes.length === 0 ? (
        <div style={{ padding: '10px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {t('promptBar.noPanes')}
        </div>
      ) : (
        <>
          {matched.length > 0 && (
            <>
              <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '4px 10px' }}>
                {t('promptBar.matchingCwd')}
              </div>
              {matched.map(renderRow)}
            </>
          )}
          {others.length > 0 && (
            <>
              <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '4px 10px', marginTop: matched.length > 0 ? 4 : 0 }}>
                {t('promptBar.otherPanes')}
              </div>
              {others.map(renderRow)}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 会話ビュー下部の固定入力バー。cwd が一致する tmux ペインへプロンプトを送信する。
 * 送信内容自体は既存の JSONL ポーリングで会話に反映される（オプティミスティック表示はしない）。
 */
export default function PromptInputBar({ sessionId, onSent }: PromptInputBarProps) {
  const { t } = useTranslation('transcript');
  const [panes, setPanes] = useState<PaneCandidate[]>([]);
  const [panesLoaded, setPanesLoaded] = useState(false);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 会話ビュー表示時（セッション切り替え時）に候補ペインを取得し、自動選択 or 復元する。
  useEffect(() => {
    let cancelled = false;
    setPanesLoaded(false);
    setPanes([]);
    setSelectedPaneId(null);
    setSendError(null);

    apiWithStatus<PaneCandidatesResult | TranscriptErrorResponse>(`/transcripts/${encodeURIComponent(sessionId)}/panes`)
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status !== 200 || isErrorResponse(body)) {
          setPanesLoaded(true);
          return;
        }
        setPanes(body.panes);
        setPanesLoaded(true);

        const stored = sessionStorage.getItem(storageKey(sessionId));
        const storedValid = stored !== null && body.panes.some((p) => p.paneId === stored);
        if (storedValid) {
          setSelectedPaneId(stored);
          return;
        }
        const matched = body.panes.filter((p) => p.cwdMatch);
        if (matched.length === 1) {
          setSelectedPaneId(matched[0].paneId);
        }
      })
      .catch(() => {
        if (!cancelled) setPanesLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const selectPane = useCallback((paneId: string) => {
    setSelectedPaneId(paneId);
    sessionStorage.setItem(storageKey(sessionId), paneId);
  }, [sessionId]);

  const resizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px';
  };

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
      if (textareaRef.current) {
        textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
      }
      onSent();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : t('promptBar.sendError'));
    } finally {
      setSending(false);
    }
  }, [text, selectedPaneId, sending, sessionId, onSent, t]);

  const selectedPane = panes.find((p) => p.paneId === selectedPaneId) ?? null;
  const canSend = text.trim().length > 0 && selectedPaneId !== null && !sending;

  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-card)',
        padding: '8px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, position: 'relative' }}>
        <button
          type="button"
          onClick={() => setPopoverOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--font-xs)',
            fontWeight: 500,
            padding: '3px 10px',
            borderRadius: 'var(--radius-full)',
            cursor: 'pointer',
            color: selectedPane ? 'var(--accent)' : 'var(--text-dim)',
            background: selectedPane ? 'var(--accent-a08)' : 'var(--bg)',
            border: `1px solid ${selectedPane ? 'var(--accent-a35)' : 'var(--border)'}`,
            maxWidth: '100%',
          }}
        >
          <Icon name="terminal" size={14} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedPane ? paneLabel(selectedPane) : t('promptBar.choosePane')}
          </span>
          <Icon name="chevron-down" size={14} />
        </button>
        {!selectedPaneId && panesLoaded && (
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{t('promptBar.selectPaneHint')}</span>
        )}
        {popoverOpen && (
          <PanePopover
            panes={panes}
            selectedPaneId={selectedPaneId}
            onSelect={selectPane}
            onClose={() => setPopoverOpen(false)}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            resizeTextarea(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
          disabled={sending}
          placeholder={t('promptBar.placeholder')}
          aria-label={t('promptBar.placeholder')}
          style={{
            flex: 1,
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
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          aria-label={t('promptBar.send')}
          title={t('promptBar.send')}
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
