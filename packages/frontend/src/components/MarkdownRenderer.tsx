import { useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export const mdStyles = `
.md-content h1, .md-content h2, .md-content h3, .md-content h4 { margin: 1.2em 0 0.4em; font-weight: 600; }
.md-content h1 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.md-content h2 { font-size: 1.2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.md-content h3 { font-size: 1.1em; }
.md-content p { margin: 0.6em 0; }
.md-content ul, .md-content ol { padding-left: 1.5em; margin: 0.5em 0; }
.md-content li { margin: 0.25em 0; }
.md-content code { background: var(--bg-card); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; font-family: 'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace; }
.md-content pre { background: var(--bg-card); padding: 12px 16px; border-radius: 8px; overflow-x: auto; margin: 0.8em 0; border: 1px solid var(--border); }
.md-content pre code { background: none; padding: 0; font-size: 13px; }
.md-content blockquote { border-left: 3px solid var(--accent); margin: 0.8em 0; padding: 0.4em 1em; color: var(--text-dim); }
.md-content a { color: var(--accent); text-decoration: none; }
.md-content a:hover { text-decoration: underline; }
.md-content img { max-width: 100%; border-radius: 6px; margin: 0.5em 0; }
.md-content table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
.md-content th, .md-content td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
.md-content th { background: var(--bg-card); font-weight: 600; }
.md-content hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
.md-content input[type="checkbox"] { margin-right: 6px; }
`;

interface MarkdownRendererProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
}

export default function MarkdownRenderer({ content, className, style }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const renderer = new marked.Renderer();
    const originalCode = renderer.code;
    const mermaidBlocks: string[] = [];

    renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
      if (lang === 'mermaid') {
        const idx = mermaidBlocks.length;
        mermaidBlocks.push(text);
        return `<div class="mermaid-placeholder" data-idx="${idx}"></div>`;
      }
      return originalCode.call(this, { text, lang } as any);
    };

    const html = marked.parse(content, { renderer, async: false }) as string;
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
        fontSize: 'var(--font-base)', lineHeight: 1.7, color: 'var(--text)',
        wordBreak: 'break-word',
        ...style,
      }}
    />
  );
}
