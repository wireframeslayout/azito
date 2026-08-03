import React from 'react';

export const baseInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text)',
  fontSize: 'var(--font-base)',
  fontFamily: 'inherit',
  outline: 'none',
};

export function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { style, ...rest } = props;
  return <input style={{ ...baseInputStyle, ...style }} {...rest} />;
}

export function FormTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { style, ...rest } = props;
  return <textarea style={{ ...baseInputStyle, ...style }} {...rest} />;
}

export function FormSelect(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  const { style, children, ...rest } = props;
  return <select style={{ ...baseInputStyle, ...style }} {...rest}>{children}</select>;
}
