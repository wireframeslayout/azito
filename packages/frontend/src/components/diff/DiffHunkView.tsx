import React from 'react';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/github-dark.min.css';
import type { DiffHunk } from './types';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);

function highlightLine(content: string, language: string): string {
  if (!content) return '';
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(content, { language }).value;
    }
    return hljs.highlightAuto(content).value;
  } catch {
    return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

const LINE_STYLES = {
  add: {
    background: 'rgba(46, 160, 67, 0.15)',
    borderLeft: '3px solid var(--success)',
  },
  del: {
    background: 'var(--danger-a15)',
    borderLeft: '3px solid var(--danger)',
  },
  context: {
    background: 'transparent',
    borderLeft: '3px solid transparent',
  },
} as const;

const GUTTER_STYLE: React.CSSProperties = {
  width: '4ch',
  minWidth: '4ch',
  textAlign: 'right',
  color: 'var(--text-dim)',
  fontSize: 'var(--font-xs)',
  fontFamily: 'monospace',
  padding: '0 4px',
  userSelect: 'none',
  flexShrink: 0,
  opacity: 0.7,
};

interface DiffHunkViewProps {
  hunk: DiffHunk;
  language: string;
}

export default function DiffHunkView({ hunk, language }: DiffHunkViewProps) {
  return (
    <div>
      <div
        style={{
          background: 'rgba(56, 139, 253, 0.1)',
          color: 'var(--text-dim)',
          padding: '4px 12px',
          fontSize: 'var(--font-xs)',
          fontFamily: 'monospace',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => {
        const style = LINE_STYLES[line.type];
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'stretch',
              background: style.background,
              borderLeft: style.borderLeft,
              minHeight: 20,
            }}
          >
            <span style={GUTTER_STYLE}>
              {line.oldLine ?? ''}
            </span>
            <span style={GUTTER_STYLE}>
              {line.newLine ?? ''}
            </span>
            <span
              style={{
                flex: 1,
                padding: '0 8px',
                fontFamily: 'monospace',
                fontSize: 'var(--font-sm)',
                lineHeight: '20px',
                whiteSpace: 'pre',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              dangerouslySetInnerHTML={{ __html: highlightLine(line.content, language) }}
            />
          </div>
        );
      })}
    </div>
  );
}
