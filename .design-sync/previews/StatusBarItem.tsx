import { StatusBarItem } from '@azito/frontend';

export const HealthLevels = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      maxWidth: 560,
      padding: '4px 8px',
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 8,
    }}
  >
    <StatusBarItem label="server01" dot="healthy" active={false} onClick={() => {}} />
    <StatusBarItem label="wakanda" dot="warning" active={false} onClick={() => {}} />
    <StatusBarItem label="robin" dot="critical" active={false} onClick={() => {}} />
    <StatusBarItem label="v0.3.1" dot="update" active={false} onClick={() => {}} />
  </div>
);

export const ActiveOpen = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      maxWidth: 560,
      padding: '4px 8px',
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 8,
    }}
  >
    <StatusBarItem label="server01" dot="healthy" active onClick={() => {}} />
    <StatusBarItem label="wakanda" dot="warning" active={false} onClick={() => {}} />
  </div>
);
