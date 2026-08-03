import { EyebrowBack } from '@azito/frontend';

export const AboveTitle = () => (
  <div style={{ maxWidth: 520 }}>
    <EyebrowBack label="Units" onBack={() => {}} />
    <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 600, margin: 0 }}>Edit Unit — Robin</h2>
  </div>
);

export const LongLabel = () => (
  <div style={{ maxWidth: 520 }}>
    <EyebrowBack label="azito-agent-base / Tasks" onBack={() => {}} />
    <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 600, margin: 0 }}>Task #212</h2>
  </div>
);
