import { useTranslation } from 'react-i18next';
import type { LiveStatus } from './liveStatus';
import { LIVE_THINKING_ICON_COLOR } from './styles/mockupColors';
import type { TranscriptStyle } from './transcriptStyle';

const MONO_FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace";
// TUI スタイルの ⏺ 列（22px グリッド）に揃えるためのインデント。
const TUI_INDENT_PX = 22;

interface LiveStatusRowProps {
  status: LiveStatus;
  elapsedSeconds: number;
  style: TranscriptStyle;
}

/**
 * 会話ビュー末尾の「いま起きていること」ライブインジケータ（承認済みモックアップ C1）。
 * シマーテキスト＋経過秒で、エージェントが応答準備中/ツール実行中であることを示す。
 * 全表示スタイル共通（tui のみ等幅フォント＋インデントで ⏺ 列に揃える）。
 */
export function LiveStatusRow({ status, elapsedSeconds, style }: LiveStatusRowProps) {
  const { t } = useTranslation('transcript');
  const isTui = style === 'tui';

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
    </div>
  );
}

export default LiveStatusRow;
