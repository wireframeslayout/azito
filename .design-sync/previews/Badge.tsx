import { Badge } from '@azito/frontend';

export const Tones = () => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
    <Badge>local</Badge>
    <Badge tone="accent">#495</Badge>
    <Badge tone="green">PR #500</Badge>
    <Badge tone="orange">3 windows</Badge>
    <Badge tone="purple">agent</Badge>
    <Badge tone="red">offline</Badge>
  </div>
);
