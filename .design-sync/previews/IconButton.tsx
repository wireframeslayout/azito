import { IconButton } from '@azito/frontend';

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <IconButton title="Settings">⚙️</IconButton>
    <IconButton title="Refresh">↻</IconButton>
    <IconButton title="Close" size="sm">✕</IconButton>
    <IconButton title="Expand" size="sm">▾</IconButton>
  </div>
);
