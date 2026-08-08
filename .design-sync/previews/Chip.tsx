import { Chip } from '@azito/frontend';

export const Tones = () => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
    <Chip>idle</Chip>
    <Chip tone="accent">review</Chip>
    <Chip tone="green">done</Chip>
    <Chip tone="orange">running</Chip>
    <Chip tone="red">failed</Chip>
    <Chip tone="purple">codex</Chip>
  </div>
);

export const Truncated = () => (
  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
    <Chip tone="accent" maxWidth={140}>task/263-sidekick-redesign-phase-4</Chip>
    <Chip maxWidth={120}>~/workspace/azito-agent-base</Chip>
  </div>
);
