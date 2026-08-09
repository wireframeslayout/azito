import type { CSSProperties } from 'react';

// セッション一覧・会話ヘッダーで Claude/Codex をひと目で判別するための配色。
// プロジェクトの既存トークン（accent/purple/green/red/orange、packages/frontend/src/styles/global.css）に
// 該当する色相が無いため、他の既存カラー定数と同じ出典（GitHub Primer dark palette）の
// magenta.4 / cyan.4 を定数化して使う。https://primer.style/foundations/color/palettes
const CLAUDE_BADGE_COLOR = '#f778ba'; // Primer dark magenta.4
const CODEX_BADGE_COLOR = '#39c5cf'; // Primer dark cyan.4

const AGENT_BADGE_COLORS: Record<string, string> = {
  claude: CLAUDE_BADGE_COLOR,
  codex: CODEX_BADGE_COLOR,
};

const DEFAULT_BADGE_COLOR = 'var(--text-dim)';

interface AgentBadgeProps {
  agentType: string;
  style?: CSSProperties;
}

/** どのエージェント（Claude/Codex）のトランスクリプトかを示す小さなピル。左ボーダーではなく全周の枠線+塗りで表現する。 */
export function AgentBadge({ agentType, style }: AgentBadgeProps) {
  const color = AGENT_BADGE_COLORS[agentType] ?? DEFAULT_BADGE_COLOR;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        fontSize: 'var(--font-2xs)',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        borderRadius: 'var(--radius-full)',
        // 垂直 2px はピルバッジの視覚的な高さ調整用の微調整値で --space-* (4px 刻み) に一致するものが無いため
        // 既存の他ピルバッジ（Chip.tsx/ThinkingChip.tsx 等）と同じ raw px のまま維持する。水平 8px は
        // --space-2 と厳密に一致するためトークン化する。
        padding: '2px var(--space-2)',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {agentType}
    </span>
  );
}
