import { useCallback, useRef } from 'react';

interface ColorSwatchInputProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ColorSwatchInput({ label, value, onChange }: ColorSwatchInputProps) {
  const colorRef = useRef<HTMLInputElement>(null);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (HEX_RE.test(v)) onChange(v);
  }, [onChange]);

  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  }, [onChange]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px' }}>
      <button
        type="button"
        onClick={() => colorRef.current?.click()}
        aria-label={label ? `${label}の色を選択` : 'Pick color'}
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: 'var(--radius-sm)',
          border: '1px solid rgba(255,255,255,0.14)',
          background: value,
          cursor: 'pointer',
          padding: 0,
          position: 'relative',
        }}
      >
        <input
          ref={colorRef}
          type="color"
          value={value}
          onChange={handleColorChange}
          aria-label={label}
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
        />
      </button>
      <div style={{ minWidth: 0 }}>
        {label && <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600 }}>{label}</div>}
        <input
          type="text"
          value={value}
          onChange={handleTextChange}
          style={{
            fontFamily: "'JetBrainsMono Nerd Font', monospace",
            fontSize: 'var(--font-2xs)',
            color: 'var(--text-dim)',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            padding: 0,
            width: 70,
          }}
        />
      </div>
    </div>
  );
}
