// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import MarkdownRenderer from './MarkdownRenderer';

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('MarkdownRenderer', () => {
  it('keeps table classes after sanitizing and removes dangerous HTML', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<MarkdownRenderer content={'| Value |\n| --- |\n| 12 円 |\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>'} />));
    expect(container.querySelector('.md-table-wrap table td.md-numeric')?.textContent).toBe('12 円');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')?.hasAttribute('onerror')).toBe(false);
  });
});
