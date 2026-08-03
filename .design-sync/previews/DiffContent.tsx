import { DiffContent } from '@azito/frontend';

const fileRefs = { current: new Map<string, HTMLDivElement>() };

const files = [
  {
    file: 'packages/frontend/src/hooks/usePaneZoom.ts',
    status: 'M' as const,
    additions: 3,
    deletions: 1,
    isBinary: false,
    hunks: [
      {
        oldStart: 18,
        oldLines: 5,
        newStart: 18,
        newLines: 7,
        header: '@@ -18,5 +18,7 @@ export function usePaneZoom(paneId: string) {',
        lines: [
          { type: 'context' as const, content: '  const [zoomed, setZoomed] = useState(false);', oldLine: 18, newLine: 18 },
          { type: 'del' as const, content: '  const toggle = () => setZoomed(!zoomed);', oldLine: 19, newLine: null },
          { type: 'add' as const, content: '  const toggle = useCallback(() => {', oldLine: null, newLine: 19 },
          { type: 'add' as const, content: '    setZoomed((prev) => !prev);', oldLine: null, newLine: 20 },
          { type: 'add' as const, content: '  }, []);', oldLine: null, newLine: 21 },
          { type: 'context' as const, content: '  return { zoomed, toggle };', oldLine: 20, newLine: 22 },
          { type: 'context' as const, content: '}', oldLine: 21, newLine: 23 },
        ],
      },
    ],
  },
  {
    file: 'docs/assets/pane-zoom-flow.png',
    status: 'A' as const,
    additions: 0,
    deletions: 0,
    isBinary: true,
    hunks: [],
  },
];

export const FileWithHunk = () => (
  <div
    style={{
      maxWidth: 620,
      height: 320,
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--bg)',
    }}
  >
    <DiffContent files={files} activeFile="packages/frontend/src/hooks/usePaneZoom.ts" fileRefs={fileRefs} />
  </div>
);

export const BinaryFileOnly = () => (
  <div
    style={{
      maxWidth: 620,
      height: 110,
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--bg)',
    }}
  >
    <DiffContent
      files={[files[1]]}
      activeFile={null}
      fileRefs={{ current: new Map<string, HTMLDivElement>() }}
    />
  </div>
);
