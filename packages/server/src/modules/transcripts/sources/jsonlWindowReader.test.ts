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
