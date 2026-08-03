import { MetadataField, Badge, Chip, IconButton, PixelIcon } from '@azito/frontend';

export const TaskMetadata = () => (
  <div style={{ maxWidth: 320, display: 'grid', gap: 'var(--space-4)' }}>
    <MetadataField label="Status">
      <Badge tone="accent">implementing</Badge>
    </MetadataField>
    <MetadataField label="Unit">
      <Chip tone="purple">Robin — claude sonnet</Chip>
    </MetadataField>
    <MetadataField label="Base branch">
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>master</span>
    </MetadataField>
  </div>
);

export const WithAction = () => (
  <div style={{ maxWidth: 320 }}>
    <MetadataField
      label="Worktree"
      action={<IconButton size="sm" title="Open in files"><PixelIcon name="extlink" size={12} mono /></IconButton>}
    >
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>
        .worktrees/task-212-worktree-recovery
      </span>
    </MetadataField>
  </div>
);
