import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { EmptyState, IconButton, LoadingState, PanelHeader } from '../ui';
import { Icon } from '../ui/Icon';
import MessageBubble from './MessageBubble';
import type { ReadSessionResult, TranscriptEntry, TranscriptErrorResponse } from './transcriptTypes';

const POLL_INTERVAL_MS = 2000;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

interface ConversationViewProps {
  sessionId: string;
  onBack: () => void;
}

function isErrorResponse(result: ReadSessionResult | TranscriptErrorResponse): result is TranscriptErrorResponse {
  return 'error' in result;
}

export default function ConversationView({ sessionId, onBack }: ConversationViewProps) {
  const { t } = useTranslation('transcript');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncatedInitial, setTruncatedInitial] = useState(false);
  const [newCount, setNewCount] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const nextOffsetRef = useRef<number | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    nearBottomRef.current = true;
    setNewCount(0);
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX;
    nearBottomRef.current = near;
    if (near) setNewCount(0);
  }, []);

  // 初回読み込み: セッション切り替え毎に全状態をリセットして末尾から取得する。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    setEntries([]);
    setNewCount(0);
    nextOffsetRef.current = null;
    nearBottomRef.current = true;

    apiWithStatus<ReadSessionResult | TranscriptErrorResponse>(`/transcripts/${encodeURIComponent(sessionId)}`)
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        if (status !== 200 || isErrorResponse(body)) {
          setError(isErrorResponse(body) ? body.error : `HTTP ${status}`);
          setLoading(false);
          return;
        }
        setEntries(body.entries);
        setTruncatedInitial(body.truncated);
        nextOffsetRef.current = body.nextOffset;
        setLoading(false);
        requestAnimationFrame(() => scrollToBottom('auto'));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, scrollToBottom]);

  // ライブ追従: 2秒間隔でoffset以降を取得し追記する。タブが非表示の間は取得しない。
  useEffect(() => {
    if (loading || notFound || error) return;

    let disposed = false;
    let inFlight = false;

    const tick = async () => {
      if (disposed || inFlight) return;
      if (document.visibilityState !== 'visible') return;
      if (nextOffsetRef.current === null) return;
      inFlight = true;
      try {
        const { status, body } = await apiWithStatus<ReadSessionResult | TranscriptErrorResponse>(
          `/transcripts/${encodeURIComponent(sessionId)}?offset=${nextOffsetRef.current}`,
        );
        if (disposed) return;
        if (status === 404) {
          setNotFound(true);
          return;
        }
        if (status !== 200 || isErrorResponse(body)) {
          // 一時的なサーバーエラー: 次回tickでリトライする（UIには出さない、ポーリングは継続）
          return;
        }
        nextOffsetRef.current = body.nextOffset;
        if (body.entries.length > 0) {
          setEntries((prev) => [...prev, ...body.entries]);
          if (nearBottomRef.current) {
            requestAnimationFrame(() => scrollToBottom('smooth'));
          } else {
            setNewCount((c) => c + body.entries.length);
          }
        }
      } catch {
        // ネットワーク一時エラー: 次回tickでリトライする（UIには出さない）
      } finally {
        inFlight = false;
      }
    };

    const intervalId = setInterval(tick, POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sessionId, loading, notFound, error, scrollToBottom]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PanelHeader
        icon={
          <IconButton title={t('conversation.backToList')} onClick={onBack} aria-label={t('conversation.backToList')}>
            <Icon name="arrow-left" size={16} />
          </IconButton>
        }
        title={sessionId}
      />

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '16px' }}
        >
          {loading ? (
            <LoadingState />
          ) : notFound ? (
            <EmptyState title={t('conversation.notFound')} />
          ) : error ? (
            <EmptyState title={t('conversation.loadError')} description={error} />
          ) : entries.length === 0 ? (
            <EmptyState title={t('conversation.empty')} />
          ) : (
            <>
              {truncatedInitial && (
                <div style={{ textAlign: 'center', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', margin: '0 0 12px' }}>
                  {t('conversation.olderTruncated')}
                </div>
              )}
              {entries.map((entry) => (
                <MessageBubble key={entry.uuid} entry={entry} />
              ))}
            </>
          )}
        </div>

        {newCount > 0 && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            style={{
              position: 'absolute',
              bottom: 20,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              borderRadius: 'var(--radius-full)',
              border: '1px solid var(--accent-a35)',
              background: 'var(--bg-elevated)',
              color: 'var(--accent)',
              fontSize: 'var(--font-sm)',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <Icon name="scroll-to-bottom" size={14} />
            {t('conversation.jumpToLatestWithCount', { count: newCount })}
          </button>
        )}
      </div>
    </div>
  );
}
