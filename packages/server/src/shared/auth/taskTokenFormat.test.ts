import { describe, it, expect } from 'vitest';
import { parseTaskTokenHeader, formatTaskToken } from './taskTokenFormat';

const SECRET = 'a'.repeat(64);

describe('parseTaskTokenHeader (Issue #28 review finding 4)', () => {
  it('parses a well-formed token', () => {
    const parsed = parseTaskTokenHeader(`Bearer azt.task.42.${SECRET}`);
    expect(parsed).toEqual({ taskId: 42, secret: SECRET });
  });

  it('rejects a non-Bearer header', () => {
    expect(parseTaskTokenHeader(`Basic azt.task.42.${SECRET}`)).toBeNull();
  });

  it('rejects a missing header', () => {
    expect(parseTaskTokenHeader(undefined)).toBeNull();
  });

  it('rejects a secret of the wrong length', () => {
    expect(parseTaskTokenHeader(`Bearer azt.task.42.${'a'.repeat(63)}`)).toBeNull();
  });

  it('rejects taskId 0 — not a valid task id', () => {
    expect(parseTaskTokenHeader(`Bearer azt.task.0.${SECRET}`)).toBeNull();
  });

  it('rejects a negative-looking taskId (regex requires digits only, so a leading "-" fails to match at all)', () => {
    expect(parseTaskTokenHeader(`Bearer azt.task.-1.${SECRET}`)).toBeNull();
  });

  it('rejects an oversized digit string that would overflow Number.isSafeInteger — this must fail closed (null), never throw', () => {
    // 20 digits: exceeds both the regex's {1,15} bound and MAX_SAFE_INTEGER.
    const hugeTaskId = '9'.repeat(20);
    expect(() => parseTaskTokenHeader(`Bearer azt.task.${hugeTaskId}.${SECRET}`)).not.toThrow();
    expect(parseTaskTokenHeader(`Bearer azt.task.${hugeTaskId}.${SECRET}`)).toBeNull();
  });

  it('rejects a 16-digit taskId even though it is within the regex digit bound only up to 15 — 16 digits never matches', () => {
    const sixteenDigits = '1'.repeat(16);
    expect(parseTaskTokenHeader(`Bearer azt.task.${sixteenDigits}.${SECRET}`)).toBeNull();
  });

  it('accepts the maximum 15-digit taskId as a safe integer', () => {
    const fifteenDigits = '1'.repeat(15);
    const parsed = parseTaskTokenHeader(`Bearer azt.task.${fifteenDigits}.${SECRET}`);
    expect(parsed).toEqual({ taskId: Number(fifteenDigits), secret: SECRET });
    expect(Number.isSafeInteger(parsed?.taskId)).toBe(true);
  });

  it('round-trips with formatTaskToken', () => {
    const token = formatTaskToken(7, SECRET);
    expect(parseTaskTokenHeader(`Bearer ${token}`)).toEqual({ taskId: 7, secret: SECRET });
  });
});
