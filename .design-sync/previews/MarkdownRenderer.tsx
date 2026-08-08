import { MarkdownRenderer, mdStyles } from '@azito/frontend';

const planDoc = `# Implementation plan

Add an **unzoom button** to the window header so a zoomed pane can be restored
from the UI.

## Steps

1. Add \`isZoomed\` to the pane state
2. Render the button only when zoomed
3. Call \`POST /api/tmux/unzoom\` on click

> Note: keyboard users can already unzoom with \`prefix + z\`.

\`\`\`ts
const { zoomed } = usePaneState(paneId);
\`\`\`

| Phase | Status |
| --- | --- |
| planning | done |
| implementing | in progress |
`;

export const TaskPlan = () => (
  <div style={{ maxWidth: 560 }}>
    <style>{mdStyles}</style>
    <MarkdownRenderer className="md-content" content={planDoc} />
  </div>
);
