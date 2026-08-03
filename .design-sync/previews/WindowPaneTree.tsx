import { WindowPaneTree } from '@azito/frontend';

const pane = (index: number, command: string, title = '') => ({
  index, title, command, width: 190, height: 48, active: index === 0,
});

const sessionData = {
  server01: [
    {
      name: 'azito',
      windows: [
        { index: 0, name: 'claude-t512', panes: [pane(0, 'claude', 'implementing: fix worktree recovery')] },
        { index: 1, name: 'codex-t498', panes: [pane(0, 'codex', 'reviewing: PR #500')] },
        {
          index: 2,
          name: 'dev',
          panes: [
            pane(0, 'npm', 'npm run dev'),
            pane(1, 'vitest', 'vitest --watch'),
            pane(2, 'zsh'),
          ],
        },
      ],
    },
  ],
};

const windows = [
  { id: 1, serverName: 'server01', tmuxTarget: 'azito:0', label: 'claude — task #512', taskId: 512, windowType: 'agent', workerType: 'claude', isPrimary: true },
  { id: 2, serverName: 'server01', tmuxTarget: 'azito:1', label: 'codex — review', taskId: 498, windowType: 'agent', workerType: 'codex' },
  { id: 3, serverName: 'server01', tmuxTarget: 'azito:2', label: 'dev servers', windowType: 'terminal' },
];

export const AgentAndTerminalWindows = () => (
  <div style={{ maxWidth: 300 }}>
    <WindowPaneTree
      windows={windows}
      sessionData={sessionData}
      isActive={(server, target) => target === 'azito:claude-t512.0'}
      onPaneClick={() => {}}
    />
  </div>
);

export const OfflineAndRespawning = () => (
  <div style={{ maxWidth: 300 }}>
    <WindowPaneTree
      windows={[
        { id: 10, serverName: 'wakanda', tmuxTarget: 'azito:3', label: 'claude — task #520', taskId: 520, windowType: 'agent', workerType: 'claude' },
        { id: 11, serverName: 'wakanda', tmuxTarget: 'azito:4', label: 'supervised worker', windowType: 'agent', workerType: 'codex' },
      ]}
      sessionData={{}}
      onPaneClick={() => {}}
      respawningWindowIds={new Set([11])}
    />
  </div>
);

export const EmptyState = () => (
  <div style={{ maxWidth: 300 }}>
    <WindowPaneTree windows={[]} sessionData={{}} onPaneClick={() => {}} />
  </div>
);
