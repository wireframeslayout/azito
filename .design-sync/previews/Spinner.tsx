import { Spinner } from '@azito/frontend';

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
    <Spinner />
    <Spinner size={16} />
    <Spinner size={24} />
  </div>
);

export const States = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
    <Spinner size={16} color="var(--green)" trackColor="var(--green-a15)" />
    <Spinner size={16} color="var(--orange)" trackColor="var(--orange-a15)" />
    <Spinner size={16} paused />
  </div>
);
