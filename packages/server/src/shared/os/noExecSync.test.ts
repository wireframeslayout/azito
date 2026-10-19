import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Ratchet (#379 P4): `execSync(<string>)` runs the string through the OS shell (/bin/sh, cmd.exe on Windows), so quoting
 * differs by OS and a value embedded in the string is an injection risk. Non-test code uses `execFileSync(<file>, <args>)`.
 */

const SRC_ROOT = path.resolve(__dirname, '..', '..');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('execSync ratchet', () => {
  it('has no execSync( call in non-test code', () => {
    const offenders = listSourceFiles(SRC_ROOT)
      .filter((file) => /(?<![A-Za-z])execSync\(/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
