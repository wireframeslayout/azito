import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readInitialWindow, readIncrementalWindow, readBeforeWindow } from './jsonlWindowReader';

function tmpFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-window-test-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

function parseLine(line: string): string | null {
  return line.length > 0 ? line : null;
}

describe('jsonlWindowReader', () => {
  let file: string;

  afterEach(() => {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  beforeEach(() => {
    file = '';
  });

  describe('readInitialWindow / readBeforeWindow roundtrip', () => {
    it('reconstructs the full file with no duplicates or gaps via repeated before reads (small maxBytes)', () => {
      const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        // maxBytes much smaller than the file forces the initial read to be byte-capped.
        const initial = readInitialWindow(fd, size, 60, parseLine, 1000);
        expect(initial.hasOlder).toBe(true);

        const collected: string[] = [...initial.entries];
        let before = initial.startOffset;
        let iterations = 0;
        let hasOlder = initial.hasOlder;
        while (hasOlder && iterations < 100) {
          const page = readBeforeWindow(fd, size, before, 60, parseLine);
          // Every page must move strictly backward (progress) while there's older data.
          expect(page.prevOffset).toBeLessThan(before);
          collected.unshift(...page.entries);
          before = page.prevOffset;
          hasOlder = page.hasOlder;
          iterations++;
        }

        expect(hasOlder).toBe(false);
        expect(before).toBe(0);
        expect(collected).toEqual(lines);
        expect(iterations).toBeGreaterThan(1); // proves multiple backward pages were required
      } finally {
        fs.closeSync(fd);
      }
    });

    it('skips a line straddling the window boundary and starts from the next full line', () => {
      // Craft lines so a small maxBytes window will land mid-line.
      const lines = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd'];
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        // Each line is 11 bytes (10 + \n). before = size, maxBytes = 15 lands mid-line within the
        // second-to-last line.
        const page = readBeforeWindow(fd, size, size, 15, parseLine);
        // Only the last complete line ("dddddddddd") should be included; the straddled line is skipped.
        expect(page.entries).toEqual(['dddddddddd']);
        expect(page.hasOlder).toBe(true);
        expect(page.prevOffset % 11).toBe(0); // lands exactly on a line boundary
      } finally {
        fs.closeSync(fd);
      }
    });

    it('reports hasOlder=false once the start of the file is reached', () => {
      const lines = ['x', 'y', 'z'];
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const page = readBeforeWindow(fd, size, size, 1024, parseLine);
        expect(page.entries).toEqual(lines);
        expect(page.prevOffset).toBe(0);
        expect(page.hasOlder).toBe(false);

        // Paging further back from offset 0 yields nothing new and stays non-older.
        const further = readBeforeWindow(fd, size, page.prevOffset, 1024, parseLine);
        expect(further.entries).toEqual([]);
        expect(further.hasOlder).toBe(false);
        expect(further.prevOffset).toBe(0);
      } finally {
        fs.closeSync(fd);
      }
    });

    it('marks hasOlder=true when the initial read is byte-capped', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `entry-${i}`);
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const initial = readInitialWindow(fd, size, 40, parseLine, 1000);
        expect(initial.truncated).toBe(true);
        expect(initial.hasOlder).toBe(true);
        expect(initial.startOffset).toBeGreaterThan(0);
      } finally {
        fs.closeSync(fd);
      }
    });

    it('marks hasOlder=true when only the entry-count tail limit clips (not byte-capped), and startOffset lets the clipped entries be recovered', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `e${i}`);
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        // maxBytes generous enough to read the whole file (not byte-capped), tailLimit clips to 5.
        const initial = readInitialWindow(fd, size, size + 1000, parseLine, 5);
        expect(initial.entries).toEqual(['e5', 'e6', 'e7', 'e8', 'e9']);
        expect(initial.hasOlder).toBe(true);
        // startOffset should point exactly at the start of "e5"'s line, not offset 0.
        expect(initial.startOffset).toBeGreaterThan(0);

        const page = readBeforeWindow(fd, size, initial.startOffset, 1024, parseLine);
        expect(page.entries).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
        expect(page.hasOlder).toBe(false);
      } finally {
        fs.closeSync(fd);
      }
    });

    it('expands the search window across multiple maxBytes-sized pages to find a newline before an oversized line, and still finds earlier records afterward', () => {
      // "huge" alone is far bigger than maxBytes (10), forcing readBeforeWindow to expand its
      // search window backward multiple times before it finds the newline that starts "huge".
      const hugeLine = 'H'.repeat(500);
      const lines = ['before-1', 'before-2', hugeLine, 'after-1'];
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const before = size; // start paging back from EOF
        const maxBytes = 10; // much smaller than hugeLine, forces multi-window expansion

        // First page: reads back from EOF; since "after-1\n" (8 bytes) fits but the preceding
        // hugeLine is huge, the window must expand across several maxBytes-sized steps to find
        // the newline right before "after-1".
        const page1 = readBeforeWindow(fd, size, before, maxBytes, parseLine);
        expect(page1.entries).toEqual(['after-1']);
        expect(page1.hasOlder).toBe(true);
        expect(page1.prevOffset).toBeLessThan(before);

        // Second page: now paging back from right after hugeLine's own newline; must expand
        // across many windows (hugeLine is 500 bytes, maxBytes is 10) to find the start of hugeLine.
        const page2 = readBeforeWindow(fd, size, page1.prevOffset, maxBytes, parseLine);
        expect(page2.prevOffset).toBeLessThan(page1.prevOffset);
        // cursor must strictly decrease and progress must eventually reach the very front of the file.
        expect(page2.prevOffset).toBeGreaterThanOrEqual(0);

        // Keep paging backward; cursor must monotonically decrease and eventually reach offset 0
        // with hasOlder=false, recovering all earlier records (possibly skipping the oversized one).
        let cursor = page2.prevOffset;
        let hasOlder = page2.hasOlder;
        let iterations = 0;
        const collected: string[] = [...page2.entries];
        while (hasOlder && iterations < 50) {
          const prevCursor = cursor;
          const page = readBeforeWindow(fd, size, cursor, maxBytes, parseLine);
          expect(page.prevOffset).toBeLessThan(prevCursor);
          collected.unshift(...page.entries);
          cursor = page.prevOffset;
          hasOlder = page.hasOlder;
          iterations++;
        }

        expect(hasOlder).toBe(false);
        expect(cursor).toBe(0);
        // The oversized line itself is unparseable within the window budget and is skipped, but
        // the earlier normal-sized records must still be reachable.
        expect(collected).toEqual(expect.arrayContaining(['before-1', 'before-2']));
      } finally {
        fs.closeSync(fd);
      }
    });

    it('does not expand past the requested window when maxExpandWindows is 1 (strict read budget)', () => {
      const hugeLine = 'H'.repeat(500);
      const lines = ['before-1', hugeLine];
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const maxBytes = 10;
        // EOF の直前レコードは 500 バイトの巨大行。拡張なしでは窓内に改行が無いので、この呼び出しは
        // 要求した maxBytes ぶんだけ遡って諦める（entries 空、cursor は厳密に減少）。
        const page = readBeforeWindow(fd, size, size, maxBytes, parseLine, { maxExpandWindows: 1 });
        expect(page.entries).toEqual([]);
        expect(page.prevOffset).toBe(size - maxBytes);
        expect(page.hasOlder).toBe(true);
      } finally {
        fs.closeSync(fd);
      }
    });

    it('marks hasOlder=false and startOffset=0 when nothing is clipped', () => {
      const lines = ['only-one'];
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const initial = readInitialWindow(fd, size, size + 1000, parseLine, 1000);
        expect(initial.hasOlder).toBe(false);
        expect(initial.startOffset).toBe(0);
      } finally {
        fs.closeSync(fd);
      }
    });
  });

  describe('readIncrementalWindow startOffset/hasOlder', () => {
    it('reports startOffset equal to the clamped offset and hasOlder based on offset > 0', () => {
      const lines = ['a', 'b', 'c'];
      file = tmpFile(lines);
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const fromZero = readIncrementalWindow(fd, size, 0, 1024, parseLine);
        expect(fromZero.startOffset).toBe(0);
        expect(fromZero.hasOlder).toBe(false);

        const fromMid = readIncrementalWindow(fd, size, 2, 1024, parseLine);
        expect(fromMid.startOffset).toBe(2);
        expect(fromMid.hasOlder).toBe(true);
      } finally {
        fs.closeSync(fd);
      }
    });
  });
});
