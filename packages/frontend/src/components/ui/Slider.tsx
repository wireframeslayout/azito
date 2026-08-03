import { useCallback, useRef, useEffect } from 'react';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label?: string;
  formatValue?: (value: number) => string;
}

export function Slider({ value, min, max, step = 1, onChange, label, formatValue }: SliderProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const fill = ((value - min) / (max - min)) * 100;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.setProperty('--fill', `${fill}%`);
    }
  }, [fill]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(Number(e.target.value));
  }, [onChange]);

  const display = formatValue ? formatValue(value) : String(value);

  return (
    <div>
      {label && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>
          <label>{label}</label>
          <output style={{ fontFamily: "'JetBrainsMono Nerd Font', monospace", color: 'var(--text)', fontSize: 'var(--font-xs)' }}>{display}</output>
        </div>
      )}
      <input
        ref={inputRef}
        className="azito-slider"
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={handleChange}
        aria-label={label}
      />
    </div>
  );
}
