import type { ReactNode } from 'react';

interface FormFieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  required?: boolean;
  error?: string;
  /** id of the control the label names. When set, the error text gets the id `<htmlFor>-error` for the control's aria-describedby. */
  htmlFor?: string;
}

export default function FormField({ label, children, hint, required, error, htmlFor }: FormFieldProps) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: 'var(--font-sm)',
          color: 'var(--text-dim)',
          display: 'block',
          marginBottom: 4,
        }}
      >
        {label}
        {required && <span style={{ color: 'var(--danger)', marginLeft: 2 }}>*</span>}
      </label>
      {children}
      {error && (
        <div
          id={htmlFor ? `${htmlFor}-error` : undefined}
          role="alert"
          style={{
            fontSize: 'var(--font-xs)',
            color: 'var(--danger)',
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}
      {hint && !error && (
        <div
          style={{
            fontSize: 'var(--font-xs)',
            color: 'var(--text-dim)',
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
