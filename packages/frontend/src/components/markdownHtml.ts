import { marked } from 'marked';
import { isNumericCell } from './markdownCells';

export function buildMarkdownHtml(content: string): { html: string; mermaidBlocks: string[] } {
  const renderer = new marked.Renderer();
  const originalCode = renderer.code;
  const originalTable = renderer.table;
  const originalCell = renderer.tablecell;
  const mermaidBlocks: string[] = [];
  renderer.code = function (token) {
    if (token.lang === 'mermaid') {
      const idx = mermaidBlocks.push(token.text) - 1;
      return `<div class="mermaid-placeholder" data-idx="${idx}"></div>`;
    }
    return originalCode.call(this, token);
  };
  renderer.table = function (token) {
    return `<div class="md-table-wrap">${originalTable.call(this, token)}</div>`;
  };
  renderer.tablecell = function (token) {
    const html = originalCell.call(this, token);
    return !token.header && isNumericCell(token.text) ? html.replace('<td', '<td class="md-numeric"') : html;
  };
  return { html: marked.parse(content, { renderer, async: false }), mermaidBlocks };
}
