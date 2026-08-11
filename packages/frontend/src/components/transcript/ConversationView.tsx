import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { EmptyState, LoadingState } from '../ui';
import { Icon } from '../ui/Icon';
import { DateDivider } from './DateDivider';
import { groupEntries, type EntryGroup } from './groupEntries';
import { deriveContextHistory } from './inputHistory';
import { LiveStatusRow } from './LiveStatusRow';
import { deriveLiveStatus } from './liveStatus';
import PromptInputBar from './PromptInputBar';
import type { WindowViewMode } from '../ui/TerminalChatToggle';
import BubbleEntry from './styles/BubbleEntry';
import FlowEntry from './styles/FlowEntry';
import RailEntry from './styles/RailEntry';
import TuiEntry from './styles/TuiEntry';
import type { StyleGroupProps } from './styles/types';
import { dateKeyOf, formatDateSeparator, isErrorResponse } from './transcriptFormat';
import { useTranscriptStyle, type TranscriptStyle } from './transcriptStyle';
import type {
  ReadSessionBeforeResult,
  ReadSessionResult,
  TranscriptEntry,
  TranscriptErrorResponse,
} from './transcriptTypes';

const STYLE_ENTRY_COMPONENTS: Record<TranscriptStyle, ComponentType<StyleGroupProps>> = {
  bubble: BubbleEntry,
  flow: FlowEntry,
  rail: RailEntry,
  tui: TuiEntry,
};

const POLL_INTERVAL_MS = 2000;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

interface ConversationViewProps {
  windowId: number;
  sessionId: string;
  agentType: string;
  /**
   * 送信先ペイン。resolve-window が解決した固定値（Issue #69 仕様調整3でペイン選択 UI を撤去
   * したため、ユーザーによる変更手段はない — 再解決したい場合はウィンドウ側で対応する）。
   */
  paneId: string;
  /** false の場合、PromptInputBar にフェイルセーフ注記を表示する（送信自体はブロックしない）。 */
  agentDetected: boolean;
  /** SP 端末⇄チャットのミニトグル（PromptInputBar 左端、Issue #69 S8）へ渡す現在値。省略時は
   * トグル自体を出さない（デスクトップ等、WindowChatPanel 経由で渡されない場合）。 */
  viewMode?: WindowViewMode;
  onChangeViewMode?: (mode: WindowViewMode) => void;
}

export default function ConversationView({ windowId, sessionId, agentType, paneId, agentDetected, viewMode, onChangeViewMode }: ConversationViewProps) {
  const { t, i18n } = useTranslation('transcript');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [style] = useTranscriptStyle();
  const EntryComponent = STYLE_ENTRY_COMPONENTS[style];
  // assistant 見出しラベル: サーバー側 IAgentProvider の displayName と重複定義しないよう、
  // フロント側では agentType.toUpperCase() のみで十分（claude→CLAUDE, codex→CODEX）。
  const agentLabel = agentType.toUpperCase();

  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const nextOffsetRef = useRef<number | null>(null);

  // 世代トークン（Important #1）: sessionId/agentType が切り替わるたびに発行し直す。飛行中の
  // 非同期応答（初回読み込み・ポーリング・older 読み込み）は、応答受信時にこの値が発行時と一致する
  // 場合のみ state/ref を更新する。不一致（＝別セッションへ切り替え済み、またはアンマウント済み）
  // なら黙って破棄し、旧セッションのエントリが新セッションの表示に混入するのを防ぐ。
  const generationRef = useRef(0);

  // 上方向ページング（Issue #69 Phase C）: startOffsetRef/hasOlderRef が判定の正（UI表示は
  // loadingOlder state のみに依存し、hasOlder 自体は再レンダー不要なため ref だけで持つ）。
  const startOffsetRef = useRef<number | null>(null);
  const hasOlderRef = useRef(false);
  const loadingOlderInFlightRef = useRef(false);
  // 上方向ページングでの prepend 直前のスクロール位置。反映後の useLayoutEffect でアンカー補正する。
  const pendingAnchorRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);

  // ライブ状態インジケータ（C1）: kind/toolName の算出のみ行う。経過秒の1秒毎更新と90秒経過での
  // 非表示化は LiveStatusRow 側の責務（親の再レンダーを entries 更新時のみに抑えるため）。
  // 履歴（Issue #69 仕様調整4）: ↑↓/🕘 履歴の主ソースは会話トランスクリプトの user 発話。
  // entries が更新されるたびに再計算する（新しい発話をすぐ履歴に反映するため）。
  const contextHistory = useMemo(() => deriveContextHistory(entries), [entries]);

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

  // 上方向ページング（Issue #69 Phase C）: センチネルが可視になったら before=startOffset で
  // 過去分を1回だけ取得し、entries の先頭に prepend する。多重発火は inFlight フラグで防ぐ。
  const loadOlder = useCallback(async () => {
    if (loadingOlderInFlightRef.current || !hasOlderRef.current || startOffsetRef.current === null) return;
    const myGeneration = generationRef.current;
    loadingOlderInFlightRef.current = true;
    setLoadingOlder(true);
    try {
      const { status, body } = await apiWithStatus<ReadSessionBeforeResult | TranscriptErrorResponse>(
        `/transcripts/${encodeURIComponent(agentType)}/${encodeURIComponent(sessionId)}?before=${startOffsetRef.current}`,
      );
      if (generationRef.current !== myGeneration) return; // 別セッションへ切替済み: 破棄
      if (status !== 200 || isErrorResponse(body)) return; // 一時的なエラー: 次回のスクロール到達で再試行
      if (body.entries.length > 0) {
        const container = containerRef.current;
        if (container) {
          pendingAnchorRef.current = { prevScrollHeight: container.scrollHeight, prevScrollTop: container.scrollTop };
        }
        setEntries((prev) => [...body.entries, ...prev]);
      }
      startOffsetRef.current = body.prevOffset;
      hasOlderRef.current = body.hasOlder;
    } catch {
      // ネットワーク一時エラー: 次回のスクロール到達で再試行
    } finally {
      if (generationRef.current === myGeneration) {
        loadingOlderInFlightRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [sessionId, agentType]);

  // 初回読み込み: セッション切り替え毎に全状態をリセットして末尾から取得する。
  useEffect(() => {
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    setLoading(true);
    setNotFound(false);
    setError(null);
    setEntries([]);
    setNewCount(0);
    setLoadingOlder(false);
    nextOffsetRef.current = null;
    startOffsetRef.current = null;
    hasOlderRef.current = false;
    loadingOlderInFlightRef.current = false;
    pendingAnchorRef.current = null;
    nearBottomRef.current = true;

    apiWithStatus<ReadSessionResult | TranscriptErrorResponse>(
      `/transcripts/${encodeURIComponent(agentType)}/${encodeURIComponent(sessionId)}`,
    )
      .then(({ status, body }) => {
        if (generationRef.current !== myGeneration) return;
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
        nextOffsetRef.current = body.nextOffset;
        startOffsetRef.current = body.startOffset;
        hasOlderRef.current = body.hasOlder;
        setLoading(false);
        requestAnimationFrame(() => scrollToBottom('auto'));
      })
      .catch((err) => {
        if (generationRef.current !== myGeneration) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      // アンマウント/次セッションへの切替直前にも世代を進め、直後にまだ飛行中の応答を確実に破棄する。
      generationRef.current += 1;
    };
  }, [sessionId, agentType, scrollToBottom]);

  // ライブ追従: 2秒間隔でoffset以降を取得し追記する。タブが非表示の間は取得しない。
  useEffect(() => {
    if (loading || notFound || error) return;

    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      if (document.visibilityState !== 'visible') return;
      if (nextOffsetRef.current === null) return;
      const myGeneration = generationRef.current;
      inFlight = true;
      try {
        const { status, body } = await apiWithStatus<ReadSessionResult | TranscriptErrorResponse>(
          `/transcripts/${encodeURIComponent(agentType)}/${encodeURIComponent(sessionId)}?offset=${nextOffsetRef.current}`,
        );
        if (generationRef.current !== myGeneration) return;
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
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sessionId, agentType, loading, notFound, error, scrollToBottom]);

  // 上方向ページングのトリガー: センチネル（先頭に置いたダミー要素）がスクロールコンテナ内で
  // 可視になったら loadOlder を呼ぶ。hasOlder/inFlight の判定は loadOlder 内部で行う。
  useEffect(() => {
    if (loading || notFound || error) return;
    const sentinel = sentinelRef.current;
    const container = containerRef.current;
    if (!sentinel || !container) return;

    const observer = new IntersectionObserver(
      (observerEntries) => {
        if (observerEntries[0]?.isIntersecting) void loadOlder();
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [loading, notFound, error, loadOlder]);

  // 上方向ページングのスクロール位置アンカー補正: prepend 直前に記録した scrollHeight/scrollTop を
  // 元に、描画後の差分だけ scrollTop を進めて視界を固定する（entries 反映後に同期実行する必要が
  // あるため useLayoutEffect を使う）。
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    pendingAnchorRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = anchor.prevScrollTop + (newScrollHeight - anchor.prevScrollHeight);
  }, [entries]);

  // 連続読み込み（Minor #3）: IntersectionObserver は isIntersecting の遷移（enter/exit）でしか
  // 発火しないため、prepend 後もセンチネルが可視のままだと再発火しない（例: ビューポートが広く
  // 1回の prepend では埋まらない場合）。entries 反映・アンカー補正後のレイアウト確定を待って
  // （rAF）センチネルの可視判定を行い、可視かつ hasOlder ならもう一度 loadOlder を呼ぶ。inFlight
  // ガードは loadOlder 内部で行われる。ネットワークエラー時は loadOlder が hasOlderRef/entries を
  // 更新しないため、この effect は entries の変化でしか再発火せず自然に打ち切られる。
  useEffect(() => {
    if (loading || notFound || error) return;
    const raf = requestAnimationFrame(() => {
      if (loadingOlderInFlightRef.current || !hasOlderRef.current) return;
      const sentinel = sentinelRef.current;
      const container = containerRef.current;
      if (!sentinel || !container) return;
      const sentinelRect = sentinel.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const isVisible = sentinelRect.bottom > containerRect.top && sentinelRect.top < containerRect.bottom;
      if (isVisible) void loadOlder();
    });
    return () => cancelAnimationFrame(raf);
  }, [entries, loading, notFound, error, loadOlder]);

  // ライブ状態行の出現は「新着」バッジのカウント対象にしない。最下部粘着中のみ追従スクロールする。
  useEffect(() => {
    if (hasLiveStatus && nearBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom('auto'));
    }
  }, [hasLiveStatus, scrollToBottom]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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
              <div ref={sentinelRef} style={{ minHeight: 1 }}>
                {loadingOlder && (
                  <div style={{ textAlign: 'center', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', padding: '8px 0 12px' }}>
                    {t('conversation.loadingOlder')}
                  </div>
                )}
              </div>
              {(() => {
                const groups = groupEntries(entries);

                // グループを「日付コンテナ」単位にまとめ直す（Minor #5）: sticky 日付チップの
                // containing block を1グループの高さに閉じ込めず、その日の全グループを包む
                // コンテナに広げることで、スクロール中その日の間ずっとチップが上端に留まるようにする。
                // content-visibility は個々のグループ側に残す（仮想化の粒度は変えない）。
                interface DayContainer {
                  key: string;
                  dateLabel: string | null;
                  items: { group: EntryGroup; prevTimestamp: string | null }[];
                }
                const dayContainers: DayContainer[] = [];
                let currentDateKey: string | null = null;
                groups.forEach((group, i) => {
                  const prevGroup = i > 0 ? groups[i - 1] : null;
                  const prevTimestamp = prevGroup ? prevGroup.entries[prevGroup.entries.length - 1].timestamp : null;
                  const groupDateKey = dateKeyOf(group.entries[0].timestamp);
                  const isNewDateContainer = groupDateKey !== null && groupDateKey !== currentDateKey;
                  if (groupDateKey !== null) currentDateKey = groupDateKey;

                  const lastContainer = dayContainers[dayContainers.length - 1];
                  if (!lastContainer || isNewDateContainer) {
                    dayContainers.push({
                      key: group.entries[0].uuid,
                      dateLabel: isNewDateContainer ? formatDateSeparator(group.entries[0].timestamp!, i18n.language) : null,
                      items: [{ group, prevTimestamp }],
                    });
                  } else {
                    lastContainer.items.push({ group, prevTimestamp });
                  }
                });

                return dayContainers.map((day) => (
                  <div key={day.key}>
                    {day.dateLabel && <DateDivider label={day.dateLabel} />}
                    {day.items.map(({ group, prevTimestamp }) => (
                      <div key={group.entries[0].uuid} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}>
                        <EntryComponent group={group} prevTimestamp={prevTimestamp} agentLabel={agentLabel} />
                      </div>
                    ))}
                  </div>
                ));
              })()}
              {liveStatus && lastEntryTimestamp && (
                <LiveStatusRow
                  status={liveStatus}
                  lastTimestamp={lastEntryTimestamp}
                  style={style}
                  stopTarget={{ windowId, paneId }}
                />
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
        <PromptInputBar
          windowId={windowId}
          paneId={paneId}
          draftKey={sessionId}
          agentDetected={agentDetected}
          contextHistory={contextHistory}
          onSent={() => scrollToBottom('smooth')}
          viewMode={viewMode}
          onChangeViewMode={onChangeViewMode}
        />
      )}
    </div>
  );
}
