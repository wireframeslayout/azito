import { DiffFileList } from '@azito/frontend';

const files = [
  {
    file: 'packages/server/src/modules/tmux/TmuxClient.ts',
    status: 'M' as const,
    additions: 24,
    deletions: 6,
    hunks: [],
    isBinary: false,
  },
  {
    file: 'packages/frontend/src/components/Terminal.tsx',
    status: 'M' as const,
    additions: 12,
    deletions: 3,
    hunks: [],
    isBinary: false,
  },
  {
    file: 'packages/server/src/modules/tmux/PaneZoomService.ts',
    status: 'A' as const,
    additions: 88,
    deletions: 0,
    hunks: [],
    isBinary: false,
  },
  {
    file: 'packages/frontend/src/hooks/usePaneZoom.ts',
    status: 'A' as const,
    additions: 41,
    deletions: 0,
    hunks: [],
    isBinary: false,
  },
  {
    file: 'packages/server/src/modules/tmux/legacyZoom.ts',
    status: 'D' as const,
    additions: 0,
    deletions: 57,
    hunks: [],
    isBinary: false,
  },
];

export const ChangedFiles = () => (
  <div
    style={{
      maxWidth: 320,
      height: 220,
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--bg-card)',
    }}
  >
    <DiffFileList
      files={files}
      activeFile="packages/server/src/modules/tmux/PaneZoomService.ts"
      onFileClick={() => {}}
    />
  </div>
);

export const SingleFile = () => (
  <div
    style={{
      maxWidth: 320,
      height: 90,
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--bg-card)',
    }}
  >
    <DiffFileList
      files={[
        {
          file: 'packages/server/src/main.ts',
          status: 'M' as const,
          additions: 5,
          deletions: 2,
          hunks: [],
          isBinary: false,
        },
      ]}
      activeFile={null}
      onFileClick={() => {}}
    />
  </div>
);
