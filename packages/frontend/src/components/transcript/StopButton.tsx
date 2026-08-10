import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import ContextMenu, { useContextMenu } from '../ContextMenu';
import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Spinner';
import { isErrorResponse } from './transcriptFormat';
import type { TranscriptErrorResponse } from './transcriptTypes';

type SignalKey = 'Escape' | 'C-c';

interface StopButtonProps {
  windowId: number;
  paneId: string;
}

/**
 * ライブ状態行（LiveStatusRow）右端の「停止」ボタン。タップで既定の割り込みキー
 * （ウィンドウの workerType に対応するプロファイル。無い場合は 'C-c' 既定 — サーバー側
 * WindowInputService.resolveInterruptKey が解決する）を送出する。長押し／右クリックで
 * Esc・Ctrl+C を個別に選べるメニューを開く（意味の違いを短い説明文つきで併記する）。
 * Issue #69 仕様調整3: セッションID起点の /transcripts/:agent/:id/signal からウィンドウ起点の
 * /transcripts/window-signal に統一した（ConversationView が埋め込み専用になり、送信先ペインは
 * resolve-window が返す paneId に固定されるため、agentType によるゲーティングは不要になった）。
 */
export function StopButton({ windowId, paneId }: StopButtonProps) {
  const { t } = useTranslation('transcript');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { menu, showAt, hide } = useContextMenu();
  const bindLongPress = useLongPress();

  const sendSignal = useCallback(async (action: 'interrupt' | 'key', key?: SignalKey) => {
    setSending(true);
    setError(null);
    try {
      const { status, body } = await apiWithStatus<{ ok: true } | TranscriptErrorResponse>(
        '/transcripts/window-signal',
        { method: 'POST', body: JSON.stringify({ windowId, paneId, action, key }) },
      );
      if (status !== 200 || isErrorResponse(body)) {
        setError(isErrorResponse(body) ? body.error : t('liveStatus.stopError'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('liveStatus.stopError'));
    } finally {
      setSending(false);
    }
  }, [windowId, paneId, t]);

  const openMenuAt = useCallback((x: number, y: number) => {
    if (sending) return;
    showAt(x, y, [
      { label: t('liveStatus.sendEscape'), title: t('liveStatus.sendEscapeHint'), onClick: () => void sendSignal('key', 'Escape') },
      { label: t('liveStatus.sendCtrlC'), title: t('liveStatus.sendCtrlCHint'), onClick: () => void sendSignal('key', 'C-c') },
    ]);
  }, [sending, showAt, sendSignal, t]);

  return (
    <span style={{ marginLeft: 'auto', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => void sendSignal('interrupt')}
        onContextMenu={(e) => { e.preventDefault(); openMenuAt(e.clientX, e.clientY); }}
        {...bindLongPress((x, y) => openMenuAt(x, y))}
        disabled={sending}
        aria-label={t('liveStatus.stop')}
        title={t('liveStatus.stopHint')}
        style={{ ...longPressStyle, opacity: sending ? 0.7 : 1, cursor: sending ? 'default' : 'pointer' }}
      >
        {sending ? <Spinner size={12} color="var(--danger)" /> : <Icon name="stop" size={14} />}
        {t('liveStatus.stop')}
      </button>
      {error && (
        <div role="alert" style={{ fontSize: 'var(--font-2xs)', color: 'var(--danger)', textAlign: 'right' }}>
          {error}
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={hide} />}
    </span>
  );
}

export default StopButton;
