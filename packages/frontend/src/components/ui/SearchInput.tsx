import type React from 'react';
import { FormInput } from './FormInput';
import { Icon } from './Icon';

interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Style of the wrapper that positions the icon (margins, width). */
  containerStyle?: React.CSSProperties;
}

/** A text input with a leading search icon. */
export function SearchInput({ containerStyle, style, ...rest }: SearchInputProps): React.ReactElement {
  return <div style={{ position: 'relative', minWidth: 0, ...containerStyle }}>
    <span aria-hidden="true" style={{ position: 'absolute', left: 'var(--space-2)', top: '50%', transform: 'translateY(-50%)', display: 'flex', color: 'var(--text-dim)', pointerEvents: 'none' }}><Icon name="search" size={16} /></span>
    <FormInput style={{ paddingLeft: 'calc(var(--space-6) + var(--space-2))', ...style }} {...rest} />
  </div>;
}
