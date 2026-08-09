import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { PanePopover, paneLabel } from './PanePopover';
import type { PaneCandidate } from './transcriptTypes';

const CHIP_HEIGHT = 38;

interface PaneChipProps {
  panes: PaneCandidate[];
  panesLoaded: boolean;
  panesError: string | null;
  selectedPane: PaneCandidate | null;
  onSelect: (pane: PaneCandidate) => void;
  onRetry: () => void;
}

/**
 * 入力バー先頭の短縮ペインチップ（例: `▣ %3`）。タップで送信先ペインの選択ポップオーバーを開く。
 * 未選択 or 候補取得エラー時は警告トーンにし、案内文はポップオーバー内に移す（バー高を増やさないため）。
 */
export function PaneChip({ panes, panesLoaded, panesError, selectedPane, onSelect, onRetry }: PaneChipProps) {
  const { t } = useTranslation('transcript');
  const [open, setOpen] = useState(false);
  const hasProblem = panesError !== null || (panesLoaded && !selectedPane);

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={selectedPane ? paneLabel(selectedPane) : t('promptBar.selectPaneHint')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: CHIP_HEIGHT,
          padding: '0 10px',
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
          fontSize: 'var(--font-xs)',
          fontWeight: 600,
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
          color: hasProblem ? 'var(--warning)' : (selectedPane ? 'var(--accent)' : 'var(--text-dim)'),
          background: hasProblem ? 'var(--warning-a08)' : (selectedPane ? 'var(--accent-a08)' : 'var(--bg)'),
          border: `1px solid ${hasProblem ? 'var(--warning-a35)' : (selectedPane ? 'var(--accent-a35)' : 'var(--border)')}`,
        }}
      >
        <Icon name={hasProblem ? 'warning' : 'terminal'} size={14} />
        {selectedPane ? selectedPane.paneId : t('promptBar.choosePane')}
      </button>
      {open && (
        <PanePopover
          panes={panes}
          selectedPaneId={selectedPane?.paneId ?? null}
          error={panesError}
          hint={!selectedPane && panesLoaded ? t('promptBar.selectPaneHint') : undefined}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
          onRetry={onRetry}
        />
      )}
    </div>
  );
}
