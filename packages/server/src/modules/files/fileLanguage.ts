export const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.json': 'json', '.css': 'css', '.html': 'html',
  '.md': 'markdown', '.py': 'python',
  '.sh': 'shell', '.bash': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.sql': 'sql', '.toml': 'toml',
};


const TEXT_MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.txt': 'text/plain',
};

export function textMimeType(path: string): string {
  const extension = /\.[^./\\]+$/.exec(path)?.[0].toLowerCase();
  return (extension && TEXT_MIME[extension]) || 'text/plain; charset=utf-8';
}
