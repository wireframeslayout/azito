import { describe, expect, it } from 'vitest';
import { buildMarkdownHtml } from './markdownHtml';
import { isNumericCell } from './markdownCells';

describe('markdown', () => {
  it('recognizes numeric cells with units but not versions or prose', () => {
    expect(isNumericCell('0.5 日')).toBe(true);
    expect(isNumericCell('123')).toBe(true);
    expect(isNumericCell('日本語')).toBe(false);
    expect(isNumericCell('v1.2')).toBe(false);
    expect(isNumericCell('円')).toBe(false);
  });
  it('right-aligns unaligned numeric column headers only when all rows are numeric', () => {
    const { html } = buildMarkdownHtml('| Name | Amount | Mixed | Empty | Center |\n| --- | --- | --- | --- | :---: |\n| A | 12 | 1 | | 4 |\n| B | 25 | text | | 5 |');
    const headers = [...html.matchAll(/<th(?=[ >])[^>]*>/g)].map((match) => match[0]);
    expect(headers).toEqual(['<th>', '<th class="md-numeric">', '<th>', '<th>', '<th align="center">']);
  });
  it('wraps tables, marks numbers and preserves mermaid blocks', () => {
    const { html, mermaidBlocks } = buildMarkdownHtml('| A | B |\n| --- | ---: |\n| foo | 1 日 |\n\n```mermaid\ngraph TD\n```');
    expect(html).toContain('class="md-table-wrap"');
    expect(html).toContain('class="md-numeric" align="right"');
    expect(html).toContain('class="mermaid-placeholder" data-idx="0"');
    expect(mermaidBlocks).toEqual(['graph TD']);
  });
});
