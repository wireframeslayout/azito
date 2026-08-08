import { TaskRefBadges } from '@azito/frontend';

export const Combinations = () => (
  <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
    <TaskRefBadges taskId={495} />
    <TaskRefBadges taskId={263} sourceRef="#263" source="github" />
    <TaskRefBadges
      taskId={500}
      sourceRef="#500"
      source="github"
      prUrl="https://github.com/WireframesJPN/azito/pull/500"
    />
  </div>
);
