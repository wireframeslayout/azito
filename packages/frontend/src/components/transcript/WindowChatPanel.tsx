import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { Button, EmptyState, LoadingState } from '../ui';
import ConversationView from './ConversationView';
import type { ResolveWindowResult, TranscriptErrorResponse } from './transcriptTypes';

interface WindowChatPanelProps {
  windowId: number;
}

type ResolveState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'resolved'; result: ResolveWindowResult };

/**
 * ワークスペースのウィンドウ表示における「チャット」モード本体（Issue #69 Phase E-2）。
 * resolve-window API でこのウィンドウが動かしているエージェント会話セッションを自動解決し、見つかれば
 * 埋め込み ConversationView を表示する。設計確定: 手動セッション選択はサポートしない（選択中ウィンドウ
 * 単位の自動解決のみ）。windowId が切り替わるたびに解決をやり直す。
 */
export default function WindowChatPanel({ windowId }: WindowChatPanelProps) {
  const { t } = useTranslation('transcript');
  const [state, setState] = useState<ResolveState>({ kind: 'loading' });
  const [retryTick, setRetryTick] = useState(0);

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
        setState({ kind: 'resolved', result: body });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [windowId]);

  useEffect(() => resolve(), [resolve, retryTick]);

  if (state.kind === 'loading') {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingState message={t('windowChat.loading')} />
      </div>
    );
  }

  if (state.kind === 'error' || !state.result.resolved) {
    const reason = state.kind === 'resolved' && !state.result.resolved ? state.result.reason : 'error';
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <EmptyState
          title={t(`windowChat.notFound.${reason}`)}
          action={<Button size="sm" onClick={() => setRetryTick((n) => n + 1)}>{t('windowChat.retry')}</Button>}
        />
      </div>
    );
  }

  return (
    <ConversationView
      sessionId={state.result.sessionId}
      agentType={state.result.agentType}
      embedded={{ initialPaneId: state.result.paneId }}
    />
  );
}
