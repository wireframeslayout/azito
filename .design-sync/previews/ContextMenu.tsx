import { ContextMenu } from '@azito/frontend';

export const WindowMenu = () => (
  <div style={{ position: 'relative', width: 260, height: 300 }}>
    <ContextMenu
      menu={{
        x: 16,
        y: 16,
        items: [
          { label: 'Open in new tab', icon: '↗', onClick: () => {} },
          { label: 'Rename window', icon: '✎', onClick: () => {} },
          { label: 'Mark supervised', icon: '👁', selected: true, onClick: () => {} },
          { label: 'Reinstall agent', disabled: true, title: 'Agent servers only', onClick: () => {} },
          { label: '', separator: true, onClick: () => {} },
          { label: 'Kill window', icon: '✕', danger: true, onClick: () => {} },
        ],
      }}
      onClose={() => {}}
    />
  </div>
);
