import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import { EmptyState, IconButton, LoadingState, PanelHeader } from '../ui';
import { Icon } from '../ui/Icon';
import { AgentBadge } from './AgentBadge';
import { ConversationMenu } from './ConversationMenu';
import { groupEntries } from './groupEntries';
import { LiveStatusRow } from './LiveStatusRow';
import { deriveLiveStatus } from './liveStatus';
import PromptInputBar from './PromptInputBar';
import { StyleSwitcher } from './StyleSwitcher';
import BubbleEntry from './styles/BubbleEntry';
import FlowEntry from './styles/FlowEntry';
import RailEntry from './styles/RailEntry';
import TuiEntry from './styles/TuiEntry';
import type { StyleGroupProps } from './styles/types';
import { isErrorResponse, pathBasename } from './transcriptFormat';
import { useTranscriptStyle, type TranscriptStyle } from './transcriptStyle';
import type { ReadSessionResult, SessionSummary, TranscriptEntry, TranscriptErrorResponse } from './transcriptTypes';

const STYLE_ENTRY_COMPONENTS: Record<TranscriptStyle, ComponentType<StyleGroupProps>> = {
  bubble: BubbleEntry,
  flow: FlowEntry,
  rail: RailEntry,
  tui: TuiEntry,
};

const POLL_INTERVAL_MS = 2000;
const NEAR_BOTTOM_THRESHOLD_PX = 80;
/** ペイン候補提示・入力送信は tmux ペインとの cwd 突合が前提のため、現状 Claude のみ対応。 */
const PANE_CAPABLE_AGENT_TYPE = 'claude';

interface ConversationViewProps {
  sessionId: string;
  agentType: string;
  onBack: () => void;
}

export default function ConversationView({ sessionId, agentType, onBack }: ConversationViewProps) {
  const { t } = useTranslation('transcript');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncatedInitial, setTruncatedInitial] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [style, setStyle] = useTranscriptStyle();
  const EntryComponent = STYLE_ENTRY_COMPONENTS[style];
  const canSendInput = agentType === PANE_CAPABLE_AGENT_TYPE;

  // ヘッダー1段化（Issue #69）: タイトルはセッションの cwd basename。一覧経由でない直リンク
  // 表示時は一覧未取得のため sessionId 先頭8文字で代替し、一覧取得後に自動で補完する。
  const { data: sessionsData } = useApi<{ sessions: SessionSummary[] }>('/transcripts');
  const matchedCwd = sessionsData?.sessions.find((s) => s.sessionId === sessionId && s.agentType === agentType)?.cwd ?? null;
  const headerTitle = matchedCwd ? pathBasename(matchedCwd) : sessionId.slice(0, 8);

  const containerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const nextOffsetRef = useRef<number | null>(null);

  // ライブ状態インジケータ（C1）: kind/toolName の算出のみ行う。経過秒の1秒毎更新と90秒経過での
  // 非表示化は LiveStatusRow 側の責務（親の再レンダーを entries 更新時のみに抑えるため）。
  const liveStatus = deriveLiveStatus(entries, Date.now());
  const hasLiveStatus = liveStatus !== null;
  const lastEntryTimestamp = liveStatus && entries.length > 0 ? entries[entries.length - 1].timestamp : null;

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

    apiWithStatus<ReadSessionResult | TranscriptErrorResponse>(
      `/transcripts/${encodeURIComponent(agentType)}/${encodeURIComponent(sessionId)}`,
    )
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
  }, [sessionId, agentType, scrollToBottom]);

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
          `/transcripts/${encodeURIComponent(agentType)}/${encodeURIComponent(sessionId)}?offset=${nextOffsetRef.current}`,
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
  }, [sessionId, agentType, loading, notFound, error, scrollToBottom]);

  // ライブ状態行の出現は「新着」バッジのカウント対象にしない。最下部粘着中のみ追従スクロールする。
  useEffect(() => {
    if (hasLiveStatus && nearBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom('auto'));
    }
  }, [hasLiveStatus, scrollToBottom]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PanelHeader
        icon={
          <IconButton title={t('conversation.backToList')} onClick={onBack} aria-label={t('conversation.backToList')}>
            <Icon name="arrow-left" size={16} />
          </IconButton>
        }
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <AgentBadge agentType={agentType} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={matchedCwd ?? sessionId}>
              {headerTitle}
            </span>
          </span>
        }
        actions={
          <>
            <StyleSwitcher value={style} onChange={setStyle} compact />
            <ConversationMenu sessionId={sessionId} />
          </>
        }
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
              {groupEntries(entries).map((group, i, groups) => {
                const prevGroup = i > 0 ? groups[i - 1] : null;
                const prevTimestamp = prevGroup ? prevGroup.entries[prevGroup.entries.length - 1].timestamp : null;
                return <EntryComponent key={group.entries[0].uuid} group={group} prevTimestamp={prevTimestamp} />;
              })}
              {liveStatus && lastEntryTimestamp && (
                <LiveStatusRow status={liveStatus} lastTimestamp={lastEntryTimestamp} style={style} />
              )}
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

      {!loading && !notFound && !error && (
        canSendInput ? (
          <PromptInputBar sessionId={sessionId} onSent={() => scrollToBottom('smooth')} />
        ) : (
          <div
            style={{
              flexShrink: 0,
              borderTop: '1px solid var(--border)',
              background: 'var(--bg-card)',
              padding: '10px 16px calc(10px + env(safe-area-inset-bottom))',
              fontSize: 'var(--font-xs)',
              color: 'var(--text-dim)',
              textAlign: 'center',
            }}
          >
            {t('promptBar.unsupportedAgent', { agentType })}
          </div>
        )
      )}
    </div>
  );
}
