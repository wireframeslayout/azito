import { PanelHeader, IconButton, Badge, PixelIcon } from '@azito/frontend';

export const WithIconAndActions = () => (
  <div style={{ maxWidth: 560, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <PanelHeader
      title="Tasks"
      icon={<PixelIcon name="tasks" size={16} />}
      actions={
        <>
          <IconButton title="Refresh"><PixelIcon name="refresh" size={14} mono /></IconButton>
          <IconButton title="New task"><PixelIcon name="plus" size={14} mono /></IconButton>
        </>
      }
    />
    <div style={{ padding: 'var(--space-4)', fontSize: 12, color: 'var(--text-dim)' }}>
      3 tasks running on server01
    </div>
  </div>
);

export const TitleOnly = () => (
  <div style={{ maxWidth: 560, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <PanelHeader title="Execution Log" />
    <div style={{ padding: 'var(--space-4)', fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
      [12:04:11] planning → implementing (task #212)
    </div>
  </div>
);

export const RichTitle = () => (
  <div style={{ maxWidth: 560, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <PanelHeader
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>azito-agent-base</span>
          <Badge tone="green">running</Badge>
        </span>
      }
      icon={<PixelIcon name="projects" size={16} />}
      actions={<IconButton title="Settings"><PixelIcon name="settings" size={14} mono /></IconButton>}
    />
  </div>
);
