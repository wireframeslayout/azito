import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { Button, EmptyState, LoadingState } from '../ui';
import ConversationView from './ConversationView';
import PromptInputBar from './PromptInputBar';
import type { ResolveWindowResult, TranscriptErrorResponse } from './transcriptTypes';

interface WindowChatPanelProps {
  windowId: number;
}

type ResolveState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'session'; sessionId: string; agentType: string; paneId: string; agentDetected: boolean }
  // セッション JSONL がまだ無い（会話履歴が発生する前）が、送信先ペインだけは best-effort で
  // 解決できているケース（Issue #69 仕様調整3）。チャットは開始できる。
  | { kind: 'pane-only'; paneId: string; agentDetected: boolean }
  | { kind: 'unresolved'; reason: 'unsupported_server' | 'no_recent_session' };

const POST_SEND_POLL_INTERVAL_MS = 3000;
const POST_SEND_POLL_MAX_ATTEMPTS = 10;

/**
 * ワークスペースのウィンドウ表示における「チャット」モード本体（Issue #69 Phase E-2、仕様調整3で
 * セッション未確立でも送信できるよう拡張）。resolve-window API でこのウィンドウが動かしている
 * エージェント会話セッションを自動解決する:
 * - セッションが見つかれば埋め込み ConversationView を表示する。
 * - セッションが見つからなくても pane が best-effort で解決できていれば、空の会話 + 入力バーを
 *   表示してチャットを開始できるようにする（送信は window-input API、セッション不要）。送信後は
 *   セッションが生成されるのを見越して resolve-window を数秒間隔で再試行し、見つかり次第
 *   embedded 表示（ConversationView、以後は既存のポーリング）へ昇格する。
 * - pane すら解決できない場合のみ、従来通りのエラー空状態＋再試行を表示する。
 * 設計確定: 手動セッション選択はサポートしない（選択中ウィンドウ単位の自動解決のみ）。windowId が
 * 切り替わるたびに解決をやり直す。
 */
export default function WindowChatPanel({ windowId }: WindowChatPanelProps) {
  const { t } = useTranslation('transcript');
  const [state, setState] = useState<ResolveState>({ kind: 'loading' });
  const [retryTick, setRetryTick] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollAttemptsRef.current = 0;
  }, []);

  const resolve = useCallback(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    apiWithStatus<ResolveWindowResult | TranscriptErrorResponse>(`/transcripts/resolve-window?windowId=${windowId}`)
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status !== 200 || 'error' in body) {
          setState({ kind: 'error' });
          return;
        }
        if (body.resolved) {
          setState({ kind: 'session', sessionId: body.sessionId, agentType: body.agentType, paneId: body.paneId, agentDetected: body.agentDetected });
        } else if (body.paneId) {
          setState({ kind: 'pane-only', paneId: body.paneId, agentDetected: body.agentDetected });
        } else {
          setState({ kind: 'unresolved', reason: body.reason });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [windowId]);

  useEffect(() => stopPolling(), [windowId, stopPolling]);
  useEffect(() => resolve(), [resolve, retryTick]);
  useEffect(() => stopPolling, [stopPolling]);

  // 送信直後、セッション JSONL が生成されるのを見越して resolve-window を短い間隔で再試行する。
  // 見つかり次第 embedded 表示へ昇格する。上限回数まで見つからなければ黙って諦める（pane-only の
  // ままチャットは引き続き使える — セッション昇格は表示リッチ化の話であり、送信可否とは無関係）。
  const pollForSession = useCallback(() => {
    stopPolling();
    const tick = () => {
      pollAttemptsRef.current += 1;
      apiWithStatus<ResolveWindowResult | TranscriptErrorResponse>(`/transcripts/resolve-window?windowId=${windowId}`)
        .then(({ status, body }) => {
          if (status === 200 && !('error' in body) && body.resolved) {
            stopPolling();
            setState({ kind: 'session', sessionId: body.sessionId, agentType: body.agentType, paneId: body.paneId, agentDetected: body.agentDetected });
            return;
          }
          if (pollAttemptsRef.current >= POST_SEND_POLL_MAX_ATTEMPTS) {
            stopPolling();
            return;
          }
          pollTimerRef.current = setTimeout(tick, POST_SEND_POLL_INTERVAL_MS);
        })
        .catch(() => {
          if (pollAttemptsRef.current >= POST_SEND_POLL_MAX_ATTEMPTS) {
            stopPolling();
            return;
          }
          pollTimerRef.current = setTimeout(tick, POST_SEND_POLL_INTERVAL_MS);
        });
    };
    pollTimerRef.current = setTimeout(tick, POST_SEND_POLL_INTERVAL_MS);
  }, [windowId, stopPolling]);

  if (state.kind === 'loading') {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingState message={t('windowChat.loading')} />
      </div>
    );
  }

  if (state.kind === 'error' || state.kind === 'unresolved') {
    const reason = state.kind === 'unresolved' ? state.reason : 'error';
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <EmptyState
          title={t(`windowChat.notFound.${reason}`)}
          action={<Button size="sm" onClick={() => setRetryTick((n) => n + 1)}>{t('windowChat.retry')}</Button>}
        />
      </div>
    );
  }

  if (state.kind === 'pane-only') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <EmptyState title={t('windowChat.empty.title')} description={t('windowChat.empty.description')} />
        </div>
        <PromptInputBar
          windowId={windowId}
          paneId={state.paneId}
          draftKey={`window-${windowId}`}
          agentDetected={state.agentDetected}
          contextHistory={[]}
          onSent={pollForSession}
        />
      </div>
    );
  }

  return (
    <ConversationView
      windowId={windowId}
      sessionId={state.sessionId}
      agentType={state.agentType}
      paneId={state.paneId}
      agentDetected={state.agentDetected}
    />
  );
}
