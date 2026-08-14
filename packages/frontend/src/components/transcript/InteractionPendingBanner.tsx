import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import type { WindowViewMode } from '../ui/TerminalChatToggle';

interface InteractionPendingBannerProps {
  /** ターミナル⇄チャットの表示切替（TerminalChatToggle と共有、Issue #69 S8）。省略時は
   * ボタン自体を出さない（デスクトップ等、WindowChatPanel 経由で viewMode 管理されない経路）。 */
  onChangeViewMode?: (mode: WindowViewMode) => void;
}

/**
 * 会話ビュー末尾の「エージェントが入力を待っている」バナー（Phase B リアルタイム未回答検出）。
 * LiveStatusRow と同じ視覚階層（末尾行、カード化しない）に置くが、経過秒のカウントアップは行わない
 * — こちらは「質問内容」ではなく「待機している」という存在シグナルのみを表す（質問内容自体は
 * 回答確定後に TranscriptEntry type: 'interaction' として遅れて到着する、Phase A 実装済み）。
 * 左ボーダーによる強調はこのプロジェクトでは禁止（AI slop として却下済み）のため、アイコンを
 * チップ状の塗り面（--accent-a15 背景）に載せて強調する。
 */
export function InteractionPendingBanner({ onChangeViewMode }: InteractionPendingBannerProps) {
  const { t } = useTranslation('transcript');

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: '6px 0',
        padding: '8px 10px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-elevated)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          flexShrink: 0,
          borderRadius: 'var(--radius-full)',
          background: 'var(--accent-a15)',
          color: 'var(--accent)',
        }}
      >
        <Icon name="question" size={14} />
      </span>
      <span style={{ flex: 1, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
        {t('conversation.pendingInteraction.message')}
      </span>
      {onChangeViewMode && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onChangeViewMode('terminal')}
        >
          <Icon name="terminal" size={14} />
          {t('conversation.pendingInteraction.openTerminal')}
        </button>
      )}
    </div>
  );
}

export default InteractionPendingBanner;
