import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LIVE_STATUS_MAX_AGE_SECONDS, type LiveStatus } from './liveStatus';
import { LIVE_THINKING_ICON_COLOR } from './styles/mockupColors';
import { StopButton } from './StopButton';
import type { TranscriptStyle } from './transcriptStyle';

const MONO_FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace";
// TUI スタイルの ⏺ 列（22px グリッド）に揃えるためのインデント。
const TUI_INDENT_PX = 22;

/** 停止ボタンの送信先。resolve-window で pane が解決できていない場合のみ null にし、
 * ボタン自体を出さない（Issue #69 仕様調整3: ウィンドウ起点の window-signal に統一）。 */
export interface StopTarget {
  windowId: number;
  paneId: string;
}

interface LiveStatusRowProps {
  status: LiveStatus;
  lastTimestamp: string;
  style: TranscriptStyle;
  stopTarget: StopTarget | null;
}

/**
 * 会話ビュー末尾の「いま起きていること」ライブインジケータ（承認済みモックアップ C1）。
 * シマーテキスト＋経過秒で、エージェントが応答準備中/ツール実行中であることを示す。
 * 全表示スタイル共通（tui のみ等幅フォント＋インデントで ⏺ 列に揃える）。
 *
 * 経過秒の算出と1秒毎の自己更新はこのコンポーネント内で完結させる（親の再レンダーを避けるため）。
 * 90秒経過での自動消滅もここで判定し、親の再計算を待たずに null を描画して非表示化する。
 */
export function LiveStatusRow({ status, lastTimestamp, style, stopTarget }: LiveStatusRowProps) {
  const { t } = useTranslation('transcript');
  const isTui = style === 'tui';

  const lastMs = new Date(lastTimestamp).getTime();
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - lastMs) / 1000)));

  useEffect(() => {
    setElapsedSeconds(Math.max(0, Math.floor((Date.now() - lastMs) / 1000)));
    const id = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - lastMs) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [lastMs]);

  if (elapsedSeconds > LIVE_STATUS_MAX_AGE_SECONDS) return null;

  const label = status.kind === 'thinking'
    ? t('conversation.liveThinking', { seconds: elapsedSeconds })
    : t('conversation.liveTool', { name: status.toolName, seconds: elapsedSeconds });

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        margin: '6px 0',
        paddingLeft: isTui ? TUI_INDENT_PX : 0,
        fontFamily: isTui ? MONO_FONT : 'inherit',
        fontSize: isTui ? 'var(--font-md)' : 'var(--font-sm)',
      }}
    >
      {status.kind === 'thinking' ? (
        <span aria-hidden="true" className="transcript-live-icon-thinking" style={{ color: LIVE_THINKING_ICON_COLOR }}>
          ✳
        </span>
      ) : (
        <span aria-hidden="true" style={{ color: 'var(--warning)' }}>⚙</span>
      )}
      <span className="transcript-shimmer">{label}</span>
      {stopTarget && (
        <StopButton windowId={stopTarget.windowId} paneId={stopTarget.paneId} />
      )}
    </div>
  );
}

export default LiveStatusRow;
