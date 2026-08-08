import { ListRow, ListRowGroup, Chip, StatusDot, IconButton } from '@azito/frontend';

export const ProjectList = () => (
  <div style={{ maxWidth: 520 }}>
    <ListRowGroup>
      <ListRow
        icon="🏗️"
        title="azito-agent-base"
        description="Browser-based tmux session manager"
        chips={<Chip tone="green">3 tasks</Chip>}
        onClick={() => {}}
      />
      <ListRow
        icon="📦"
        title="campaign-radar"
        description="Marketing campaign tracker"
        chips={<Chip tone="default">idle</Chip>}
        onClick={() => {}}
      />
      <ListRow
        icon="🧪"
        title="medica-cms"
        description="Headless CMS for clinics"
        selected
        accentColor="var(--accent)"
        chips={<Chip tone="orange">running</Chip>}
        onClick={() => {}}
      />
    </ListRowGroup>
  </div>
);

export const SmallWithActions = () => (
  <div style={{ maxWidth: 440 }}>
    <ListRowGroup>
      <ListRow
        size="sm"
        icon={<StatusDot status="busy" />}
        title="claude — implementing"
        description="task/263-sidekick-redesign"
        rightActions={<IconButton title="Close" onClick={() => {}}>✕</IconButton>}
      />
      <ListRow
        size="sm"
        icon={<StatusDot status="idle" />}
        title="codex — waiting"
        description="feature/22-task-git-info"
        rightActions={<IconButton title="Close" onClick={() => {}}>✕</IconButton>}
      />
    </ListRowGroup>
  </div>
);
