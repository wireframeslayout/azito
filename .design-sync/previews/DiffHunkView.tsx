import { DiffHunkView } from '@azito/frontend';

const hunk = {
  oldStart: 42,
  oldLines: 7,
  newStart: 42,
  newLines: 9,
  header: '@@ -42,7 +42,9 @@ export class PaneZoomService {',
  lines: [
    { type: 'context' as const, content: '  async restoreZoom(sessionName: string): Promise<void> {', oldLine: 42, newLine: 42 },
    { type: 'context' as const, content: '    const pane = await this.tmux.getActivePane(sessionName);', oldLine: 43, newLine: 43 },
    { type: 'del' as const, content: '    if (!pane) return;', oldLine: 44, newLine: null },
    { type: 'add' as const, content: '    if (!pane) {', oldLine: null, newLine: 44 },
    { type: 'add' as const, content: "      throw new Error(`No active pane in session ${sessionName}`);", oldLine: null, newLine: 45 },
    { type: 'add' as const, content: '    }', oldLine: null, newLine: 46 },
    { type: 'context' as const, content: "    await this.tmux.exec(['resize-pane', '-Z', '-t', pane.id]);", oldLine: 45, newLine: 47 },
    { type: 'context' as const, content: '  }', oldLine: 46, newLine: 48 },
    { type: 'context' as const, content: '}', oldLine: 47, newLine: 49 },
  ],
};

export const TypeScriptHunk = () => (
  <div
    style={{
      maxWidth: 620,
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--bg-card)',
    }}
  >
    <DiffHunkView hunk={hunk} language="typescript" />
  </div>
);

export const DeletionHeavy = () => (
  <div
    style={{
      maxWidth: 620,
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--bg-card)',
    }}
  >
    <DiffHunkView
      hunk={{
        oldStart: 10,
        oldLines: 6,
        newStart: 10,
        newLines: 3,
        header: '@@ -10,6 +10,3 @@ import { TmuxClient } from "./TmuxClient";',
        lines: [
          { type: 'context' as const, content: "import { TmuxClient } from './TmuxClient';", oldLine: 10, newLine: 10 },
          { type: 'del' as const, content: "import { legacyZoomState } from './legacyZoom';", oldLine: 11, newLine: null },
          { type: 'del' as const, content: "import { readZoomCache } from './legacyZoom';", oldLine: 12, newLine: null },
          { type: 'del' as const, content: '', oldLine: 13, newLine: null },
          { type: 'add' as const, content: "import { PaneZoomService } from './PaneZoomService';", oldLine: null, newLine: 11 },
          { type: 'context' as const, content: '', oldLine: 14, newLine: 12 },
          { type: 'context' as const, content: 'const DEFAULT_POLL_MS = 500;', oldLine: 15, newLine: 13 },
        ],
      }}
      language="typescript"
    />
  </div>
);
