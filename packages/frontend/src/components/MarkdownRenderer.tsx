import { useEffect, useRef } from 'react';
import { buildMarkdownHtml } from './markdownHtml';
import DOMPurify from 'dompurify';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
}

export default function MarkdownRenderer({ content, className, style }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const { html, mermaidBlocks } = buildMarkdownHtml(content);
    containerRef.current.innerHTML = DOMPurify.sanitize(html);

    if (mermaidBlocks.length > 0) {
      import('mermaid').then(({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        const placeholders = containerRef.current?.querySelectorAll('.mermaid-placeholder');
        placeholders?.forEach(async (el) => {
          const idx = parseInt(el.getAttribute('data-idx') || '0', 10);
          const code = mermaidBlocks[idx];
          if (!code) return;
          try {
            const id = `mermaid-${Date.now()}-${idx}`;
            const { svg } = await mermaid.render(id, code);
            el.innerHTML = svg;
          } catch {
            el.innerHTML = `<pre style="color: var(--danger);">Mermaid render error</pre>`;
          }
        });
      });
    }
  }, [content]);

  return (
    <div
      ref={containerRef}
      className={`md-content ${className || ''}`}
      style={{
        ...style,
      }}
    />
  );
}
