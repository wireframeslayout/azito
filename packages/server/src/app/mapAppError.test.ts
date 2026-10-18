import { describe, it, expect } from 'vitest';
import { mapAppError } from './mapAppError';
import { AgentUnreachableError } from '../modules/servers/transport/AgentUnreachableError';

describe('mapAppError', () => {
  it('maps AgentUnreachableError to 503 agent_unreachable', () => {
    expect(mapAppError(new AgentUnreachableError('srv7', 'circuit_open'))).toEqual({
      status: 503,
      body: { error: 'agent_unreachable', server: 'srv7', reason: 'circuit_open' },
    });
  });

  it('returns null for unrelated errors', () => {
    expect(mapAppError(new Error('boom'))).toBeNull();
  });
});
