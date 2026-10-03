import { describe, it, expect } from 'vitest';
import { taskMutationFailure } from './taskMutationResult';

describe('taskMutationFailure', () => {
  it('is null for a 2xx answer', () => {
    expect(taskMutationFailure(200, { ok: true })).toBeNull();
  });

  it('recognises the mux daemon being down (503 mux_driver_unavailable)', () => {
    expect(taskMutationFailure(503, { error: 'mux_driver_unavailable', kind: 'misao', reason: 'daemon_unreachable' })).toEqual({ kind: 'mux_driver_unavailable' });
  });

  it('reports other non-2xx answers with the server message, or the status', () => {
    expect(taskMutationFailure(409, { error: 'conflict' })).toEqual({ kind: 'error', message: 'conflict' });
    expect(taskMutationFailure(500, null)).toEqual({ kind: 'error', message: 'HTTP 500' });
  });
});
