import { describe, expect, it } from 'vitest';
import { canCreateBucket } from './bucketAction';
describe('bucket action', () => {
  it('is offered only for a missing bucket', () => {
    expect(canCreateBucket('bucket')).toBe(true);
    for (const reason of ['dns', 'auth', 'refused', 'timeout', 'unknown']) expect(canCreateBucket(reason)).toBe(false);
  });
});
