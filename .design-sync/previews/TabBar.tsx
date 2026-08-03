import { TabBar } from '@azito/frontend';

const tabs = [
  { id: 'projects', label: 'Projects', pinned: true },
  { id: 'term-1', label: 'claude — implementing', closable: true, projectColor: '#4a9eff' },
  { id: 'term-2', label: 'codex — review', closable: true, projectColor: '#b57edc' },
  { id: 'tasks', label: 'Tasks', closable: true },
];

export const Basic = () => (
  <div style={{ maxWidth: 560 }}>
    <TabBar tabs={tabs} activeId="term-1" onSelect={() => {}} onClose={() => {}} />
  </div>
);

export const ManyTabs = () => (
  <div style={{ maxWidth: 480 }}>
    <TabBar
      tabs={[
        ...tabs,
        { id: 'units', label: 'Units', closable: true },
        { id: 'settings', label: 'Settings', closable: true },
        { id: 'term-3', label: 'wakanda: deploy', closable: true, projectColor: '#43b581' },
      ]}
      activeId="units"
      onSelect={() => {}}
      onClose={() => {}}
    />
  </div>
);
