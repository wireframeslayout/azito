import React from 'react';

type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict';

interface EditorStatusBarProps {
  vimModeDisplay: string;
  line: number;
  col: number;
  vimEnabled: boolean;
  onVimToggle: () => void;
  saveStatus: SaveStatus;
}

const SAVE_LABELS: Record<SaveStatus, string> = {
  clean: '',
  dirty: '● Modified',
  saving: 'Saving…',
  saved: '✓ Saved',
  conflict: 'Conflict',
};

export default function EditorStatusBar({
  vimModeDisplay,
  line,
  col,
  vimEnabled,
  onVimToggle,
  saveStatus,
}: EditorStatusBarProps) {
  const saveLabel = SAVE_LABELS[saveStatus];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 24,
        padding: '0 12px',
        background: 'var(--bg-card)',
        borderTop: '1px solid var(--border)',
        fontSize: 'var(--font-xs)',
        fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'Consolas', monospace",
        color: 'var(--text-dim)',
        gap: 0,
        flexShrink: 0,
        userSelect: 'none',
      }}
      role="status"
      aria-label="Editor status"
    >
      {/* Vim mode display (left) */}
      <span style={{ minWidth: 100, fontWeight: 600, color: vimModeDisplay ? 'var(--accent)' : 'transparent' }}>
        {vimModeDisplay || ' '}
      </span>

      <span style={{ flex: 1 }} />

      {/* Cursor position */}
      <span style={{ marginRight: 12 }}>
        Ln {line}, Col {col}
      </span>

      {/* Separator */}
      <span style={{ margin: '0 4px', color: 'var(--border)' }}>{'│'}</span>

      {/* VIM toggle */}
      <button
        onClick={onVimToggle}
        title={vimEnabled ? 'Disable Vim mode' : 'Enable Vim mode'}
        aria-pressed={vimEnabled}
        style={{
          background: vimEnabled ? 'var(--accent-a15)' : 'transparent',
          border: '1px solid',
          borderColor: vimEnabled ? 'var(--accent)' : 'var(--border)',
          color: vimEnabled ? 'var(--accent)' : 'var(--text-dim)',
          cursor: 'pointer',
          fontSize: 10,
          fontWeight: 600,
          padding: '1px 6px',
          borderRadius: 3,
          lineHeight: '16px',
          margin: '0 4px',
        }}
      >
        VIM
      </button>

      {/* Separator */}
      <span style={{ margin: '0 4px', color: 'var(--border)' }}>{'│'}</span>

      {/* Encoding */}
      <span style={{ marginRight: 12 }}>UTF-8</span>

      {/* Save status */}
      {saveLabel && (
        <>
          <span style={{ margin: '0 4px', color: 'var(--border)' }}>{'│'}</span>
          <span style={{
            color: saveStatus === 'conflict' ? 'var(--orange)' :
                   saveStatus === 'dirty' ? 'var(--text-dim)' :
                   saveStatus === 'saved' ? 'var(--green)' :
                   'var(--text-dim)',
            fontWeight: saveStatus === 'conflict' ? 600 : 400,
          }}>
            {saveLabel}
          </span>
        </>
      )}
    </div>
  );
}
