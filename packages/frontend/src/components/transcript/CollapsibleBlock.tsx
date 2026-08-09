import { useState } from 'react';
import { Icon, type IconName } from '../ui/Icon';

interface CollapsibleBlockProps {
  icon: IconName;
  label: string;
  tone?: 'default' | 'danger';
  /**
   * 確定した結果の成否のみを表す（tool_result 専用）。省略時はグリフを出さない。
   * tool_use は実行中/未確定のため常に省略、thinking もグリフ対象外。
   * 「実行中」の可視化はライブ行（ThinkingChip 等）の責務であり、このチップに
   * pending グリフは出さない方針。
   */
  status?: 'success' | 'error';
  truncatedNote?: string;
  children: string;
}

const CHIP_PREVIEW_LENGTH = 40;

/** チップに表示する内容プレビュー: 先頭行を最大40字に切り詰める。 */
function chipPreview(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.length > CHIP_PREVIEW_LENGTH ? `${firstLine.slice(0, CHIP_PREVIEW_LENGTH)}…` : firstLine;
}

/**
 * thinking / tool_use / tool_result 用の折りたたみブロック。既定閉。
 * 折りたたみ時は1行チップ表示（B2: ツールの密度改善）: アイコン・ラベル・内容プレビュー・
 * 成功/失敗グリフを横並びにする。展開すると内容全文をブロック表示する。
 * ネイティブ <details>/<summary> を使い、キーボード操作・フォーカスを無償で得る。
 */
export function CollapsibleBlock({ icon, label, tone = 'default', status, truncatedNote, children }: CollapsibleBlockProps) {
  const [open, setOpen] = useState(false);
  const statusColor = status === 'error' ? 'var(--danger)' : 'var(--success)';
  const statusGlyph = status === 'error' ? '✗' : '✓';
  const preview = chipPreview(children);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      style={{ margin: '2px 0' }}
    >
      <summary
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          maxWidth: '100%',
          padding: '3px 10px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-hover)',
          fontSize: '11px',
          fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
          color: 'var(--text-dim)',
          cursor: 'pointer',
          userSelect: 'none',
          listStyle: 'none',
        }}
      >
        <Icon name={icon} size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
        {/*
          320px 幅でも状態グリフが常に見えるよう、縮む優先度はラベル > プレビューの順。
          アイコン・状態グリフは flexShrink: 0 で固定幅を維持し、ラベルは flexShrink: 1 +
          minWidth: 0 で ellipsis を効かせつつ縮む（長い翻訳ラベル・MCPツール名の折り返し崩れ対策）。
        */}
        <span
          style={{
            fontWeight: 600,
            color: 'var(--text)',
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        {preview && (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 }}>{preview}</span>
        )}
        {status && (
          <span aria-hidden="true" style={{ color: statusColor, fontWeight: 700, flexShrink: 0 }}>{statusGlyph}</span>
        )}
        {open && truncatedNote && (
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, flexShrink: 0 }}>{truncatedNote}</span>
        )}
      </summary>
      <div
        style={{
          marginTop: 4,
          padding: '8px 10px',
          borderRadius: 'var(--radius-sm)',
          background: tone === 'danger' ? 'var(--danger-a08)' : 'var(--bg)',
          border: `1px solid ${tone === 'danger' ? 'var(--danger-a35)' : 'var(--border)'}`,
          fontSize: 'var(--font-xs)',
          color: 'var(--text-dim)',
          fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
        }}
      >
        {children}
      </div>
    </details>
  );
}
