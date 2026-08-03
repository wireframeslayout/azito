import { QuickActionButtons } from '@azito/frontend';

export const MobileTerminalKeys = () => (
  <QuickActionButtons
    buttons={[
      { label: 'Enter', key: 'enter' },
      { label: 'Tab', key: 'tab' },
      { label: 'Esc', key: 'escape' },
      { label: 'Ctrl+C', key: 'ctrl-c' },
      { label: 'Up', key: 'arrow-up' },
      { label: 'Down', key: 'arrow-down' },
    ]}
    onAction={() => {}}
  />
);

export const WithAccentAction = () => (
  <QuickActionButtons
    buttons={[
      { label: 'y', key: 'yes' },
      { label: 'n', key: 'no' },
      {
        label: 'Approve plan',
        key: 'approve',
        style: { background: 'var(--accent-a15)', borderColor: 'var(--accent)', color: 'var(--accent)' },
      },
    ]}
    onAction={() => {}}
  />
);

export const OverflowScroll = () => (
  <div style={{ maxWidth: 260 }}>
    <QuickActionButtons
      buttons={[
        { label: 'Enter', key: 'enter' },
        { label: 'Tab', key: 'tab' },
        { label: 'Esc', key: 'escape' },
        { label: 'Ctrl+C', key: 'ctrl-c' },
        { label: 'Ctrl+D', key: 'ctrl-d' },
        { label: 'PgUp', key: 'page-up' },
        { label: 'PgDn', key: 'page-down' },
      ]}
      onAction={() => {}}
    />
  </div>
);
