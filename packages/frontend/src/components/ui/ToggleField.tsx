import { useId } from 'react';
import type { ReactNode } from 'react';

interface ToggleFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** What switching it on does, under the label. Linked to the switch with aria-describedby. */
  description?: ReactNode;
  disabled?: boolean;
}

/**
 * A switch (the `.toggle` control) with its label and an explanation, as one labelled checkbox: the label is clickable, the
 * explanation is announced with it, and a disabled switch keeps its explanation visible (say why in `description`).
 */
export function ToggleField({ checked, onChange, label, description, disabled = false }: ToggleFieldProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
      <label className="toggle" style={{ flexShrink: 0, marginTop: 'var(--space-1)' }}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={description != null ? descriptionId : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-slider" aria-hidden="true" />
      </label>
      <div style={{ flex: 1, minWidth: 0 }}>
        <label
          htmlFor={id}
          style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: disabled ? 'var(--text-dim)' : 'var(--text)', cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
          {label}
        </label>
        {description != null && (
          <div id={descriptionId} style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)', lineHeight: 'var(--leading-body)' }}>
            {description}
          </div>
        )}
      </div>
    </div>
  );
}
