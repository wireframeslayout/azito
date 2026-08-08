import { MiniTabBar, IconButton, Spinner, PixelIcon } from '@azito/frontend';

export const PaneTabs = () => (
  <div style={{ maxWidth: 560, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <MiniTabBar
      tabs={[
        { key: 'terminal', label: 'terminal' },
        { key: 'logs', label: 'task logs' },
        { key: 'diff', label: 'diff' },
        { key: 'browser', label: 'browser', disabled: true, title: 'Browser not started' },
      ]}
      activeKey="logs"
      onSelect={() => {}}
    />
    <div style={{ padding: 'var(--space-4)', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>
      [12:14:20] tests passed (vitest, 128 cases)
    </div>
  </div>
);

export const ClosableWithTrailing = () => (
  <div style={{ maxWidth: 560, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <MiniTabBar
      size="md"
      tabs={[
        { key: 'w0', label: 'claude — #212', prefix: <Spinner size={11} /> },
        { key: 'w1', label: 'codex — review' },
        { key: 'w2', label: 'shell', closable: false },
      ]}
      activeKey="w0"
      onSelect={() => {}}
      onClose={() => {}}
      trailing={
        <>
          <IconButton size="sm" title="Split pane"><PixelIcon name="splitV" size={13} mono /></IconButton>
          <IconButton size="sm" title="Close pane"><PixelIcon name="paneClose" size={13} mono /></IconButton>
        </>
      }
    />
  </div>
);
