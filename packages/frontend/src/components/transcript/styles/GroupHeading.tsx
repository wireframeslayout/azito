import { useTranslation } from 'react-i18next';

interface GroupHeadingProps {
  isUser: boolean;
  timeLabel: string;
  /** assistant 見出しに表示するラベル（agentType.toUpperCase() 済み）。isUser=true の場合は無視される。 */
  agentLabel: string;
}

/**
 * ロールグルーピング（B1）の見出し（ドット＋ラベル＋時刻）。グループ先頭で1回だけ描画し、
 * 時刻はグループ末尾エントリのものを渡す。bubble/flow スタイル共通。
 * assistant ラベルはウィンドウの agentType に追随させる（claude→CLAUDE, codex→CODEX）。
 * サーバー側 IAgentProvider の displayName と重複定義しないよう、フロント側では
 * agentType.toUpperCase() のみを使う（呼び出し元 ConversationView で算出）。
 */
export function GroupHeading({ isUser, timeLabel, agentLabel }: GroupHeadingProps) {
  const { t } = useTranslation('transcript');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginBottom: 6 }}>
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          flexShrink: 0,
          background: isUser ? 'var(--accent)' : 'var(--text-dim)',
        }}
      />
      <span
        style={{
          fontSize: 'var(--font-2xs)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
          color: 'var(--text-dim)',
        }}
      >
        {isUser ? t('styleSwitcher.flow.userLabel') : agentLabel}
      </span>
      <span style={{ flex: 1 }} />
      {timeLabel && (
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>{timeLabel}</span>
      )}
    </div>
  );
}
