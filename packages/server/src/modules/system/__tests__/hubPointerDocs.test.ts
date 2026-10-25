import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseHubPointer } from '../hubPointer';

/**
 * The PowerShell example that docs/{ja,en}/install-and-update.md give for writing `current.txt` by hand must produce a file the in-app update
 * reads: a pointer without its CRLF is refused (`current.txt must end with a CRLF`) by the next update. The string is taken from the docs.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const EXAMPLE = /\[System\.IO\.File\]::WriteAllText\("[^"]*current\.txt", "([^"]*)"\)/g;

/** The string PowerShell makes of a double-quoted literal: `` `r `` and `` `n `` are CR and LF. */
function unquotePowershell(literal: string): string {
  return literal.replace(/`r/g, '\r').replace(/`n/g, '\n');
}

describe.each(['ja', 'en'])('the current.txt example in docs/%s/install-and-update.md', (lang) => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'docs', lang, 'install-and-update.md'), 'utf-8');
  const examples = [...text.matchAll(EXAMPLE)].map((m) => unquotePowershell(m[1]));

  it('is given, and every one of them is a pointer the in-app update accepts', () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const content of examples) expect(parseHubPointer(Buffer.from(content, 'utf8'))).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('has no WriteAllText example for current.txt that the pattern does not cover (single quotes, no CRLF)', () => {
    expect(text.match(/WriteAllText\([^)]*current\.txt[^)]*\)/g)?.length).toBe(text.match(EXAMPLE)?.length);
  });
});
