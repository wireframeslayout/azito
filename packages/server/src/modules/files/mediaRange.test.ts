import { describe, expect, it } from 'vitest';
import { parseMediaRange } from './mediaRange';

describe('media ranges', () => {
  it('handles bounded, open and suffix ranges', () => {
    expect(parseMediaRange('bytes=2-99', 10)).toEqual({ kind: 'partial', start: 2, end: 9 });
    expect(parseMediaRange('bytes=2-', 10)).toEqual({ kind: 'partial', start: 2, end: 9 });
    expect(parseMediaRange('bytes=-2', 10)).toEqual({ kind: 'partial', start: 8, end: 9 });
  });
  it('rejects unsatisfiable and empty ranges, and ignores multiple ranges', () => {
    expect(parseMediaRange('bytes=10-', 10)).toEqual({ kind: 'invalid' });
    expect(parseMediaRange('bytes=0-', 0)).toEqual({ kind: 'invalid' });
    expect(parseMediaRange('bytes=-0', 10)).toEqual({ kind: 'invalid' });
    expect(parseMediaRange('bytes=0-1,3-4', 10)).toEqual({ kind: 'full' });
  });
  it('ignores malformed units and clamps huge suffixes and ends', () => {
    expect(parseMediaRange('items=1-2', 10)).toEqual({ kind: 'full' });
    expect(parseMediaRange('bytes=bad', 10)).toEqual({ kind: 'full' });
    expect(parseMediaRange('bytes=1-999999999999999999999999999999', 10)).toEqual({ kind: 'partial', start: 1, end: 9 });
    expect(parseMediaRange('bytes=-999999999999999999999999999999', 10)).toEqual({ kind: 'partial', start: 0, end: 9 });
    expect(parseMediaRange('bytes=999999999999999999999999999999-', 10)).toEqual({ kind: 'invalid' });
  });
});
