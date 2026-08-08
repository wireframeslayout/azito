import { PageContainer, SectionHeader, MetadataField, Badge } from '@azito/frontend';

export const CenteredPage = () => (
  <div style={{ height: 300, maxWidth: 640, border: '1px dashed var(--border)', borderRadius: 8, display: 'flex' }}>
    <PageContainer maxWidth={480}>
      <SectionHeader>Task #212 — Fix stale worktree recovery</SectionHeader>
      <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <MetadataField label="Status">
          <Badge tone="accent">implementing</Badge>
        </MetadataField>
        <MetadataField label="Branch">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>azito/task-212-worktree-recovery</span>
        </MetadataField>
      </div>
    </PageContainer>
  </div>
);

export const ScrollableOverflow = () => (
  <div style={{ height: 200, maxWidth: 640, border: '1px dashed var(--border)', borderRadius: 8, display: 'flex' }}>
    <PageContainer maxWidth={480}>
      <SectionHeader>Execution Log</SectionHeader>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', display: 'grid', gap: 6, marginTop: 'var(--space-3)' }}>
        <div>[11:58:02] planning started (unit: robin)</div>
        <div>[12:01:44] plan approved by user</div>
        <div>[12:01:45] implementing started</div>
        <div>[12:14:20] tests passed (vitest, 128 cases)</div>
        <div>[12:15:03] reviewing started</div>
        <div>[12:19:57] pushing: PR #503 opened</div>
        <div>[12:20:01] task moved to review</div>
      </div>
    </PageContainer>
  </div>
);
