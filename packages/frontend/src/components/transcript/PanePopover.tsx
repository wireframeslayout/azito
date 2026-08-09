import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { useClickOutside } from '../../hooks/useClickOutside';
import { pathBasename } from './transcriptFormat';
import type { PaneCandidate } from './transcriptTypes';

/** 同一ウィンドウの分割ペインを一意に識別できるよう window/pane index を含める。 */
function paneLabel(pane: PaneCandidate): string {
  return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} (${pane.windowName})`;
}

interface PanePopoverProps {
  panes: PaneCandidate[];
  selectedPaneId: string | null;
  error: string | null;
  /** バーの1行化に伴いチップ自体には表示しなくなった案内文。未選択時のみ渡す。 */
  hint?: string;
  onSelect: (pane: PaneCandidate) => void;
  onClose: () => void;
  onRetry: () => void;
}

export function PanePopover({ panes, selectedPaneId, error, hint, onSelect, onClose, onRetry }: PanePopoverProps) {
  const { t } = useTranslation('transcript');
  const ref = useClickOutside<HTMLDivElement>(onClose);
  const matched = panes.filter((p) => p.cwdMatch);
  const others = panes.filter((p) => !p.cwdMatch);

  const renderRow = (pane: PaneCandidate) => (
    <button
      key={pane.paneId}
      type="button"
      onClick={() => {
        onSelect(pane);
        onClose();
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        width: '100%',
        padding: '7px 10px',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: pane.paneId === selectedPaneId ? 'var(--accent-a08)' : 'none',
        color: 'var(--text)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--font-sm)', fontWeight: 600 }}>
        {paneLabel(pane)}
        <span style={{ fontSize: 'var(--font-2xs)', fontWeight: 400, color: 'var(--text-dim)' }}>{pane.paneId}</span>
        {pane.paneId === selectedPaneId && <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />}
      </span>
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {pane.currentCommand || t('promptBar.noCommand')} · …/{pathBasename(pane.currentPath)}
      </span>
    </button>
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('promptBar.selectPane')}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 6,
        zIndex: 100,
        background: 'var(--bg-solid)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-2)',
        minWidth: 260,
        maxWidth: 'min(360px, calc(100vw - 32px))',
        maxHeight: 320,
        overflowY: 'auto',
        padding: 6,
      }}
    >
      {hint && !error && (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--warning)', padding: '6px 10px 8px' }}>
          {hint}
        </div>
      )}
      {error ? (
        <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--danger)' }}>{error}</span>
          <Button variant="ghost" size="sm" onClick={onRetry}>{t('promptBar.retry')}</Button>
        </div>
      ) : panes.length === 0 ? (
        <div style={{ padding: '10px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {t('promptBar.noPanes')}
        </div>
      ) : (
        <>
          {matched.length > 0 && (
            <>
              <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '4px 10px' }}>
                {t('promptBar.matchingCwd')}
              </div>
              {matched.map(renderRow)}
            </>
          )}
          {others.length > 0 && (
            <>
              <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '4px 10px', marginTop: matched.length > 0 ? 4 : 0 }}>
                {t('promptBar.otherPanes')}
              </div>
              {others.map(renderRow)}
            </>
          )}
        </>
      )}
    </div>
  );
}

export { paneLabel };
