import { WindowActivityIndicator } from '@azito/frontend';

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)', width: 280 };
const name: React.CSSProperties = { fontFamily: 'var(--mono, ui-monospace, monospace)', color: 'var(--text-dim)', width: 120 };

export const AllStatuses = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <span style={row}>
      <span style={name}>working</span>
      <WindowActivityIndicator status="working" />
      <span>task-482-implementing</span>
    </span>
    <span style={row}>
      <span style={name}>blocked</span>
      <WindowActivityIndicator status="blocked" />
      <span>codex-review</span>
    </span>
    <span style={row}>
      <span style={name}>finished</span>
      <WindowActivityIndicator status="finished" finishedAt={Date.now() - 12 * 60000} />
      <span>task-478-pushing</span>
    </span>
    <span style={row}>
      <span style={name}>finished (no ts)</span>
      <WindowActivityIndicator status="finished" />
      <span>dev-server</span>
    </span>
  </div>
);
