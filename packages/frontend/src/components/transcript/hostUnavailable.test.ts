import { describe, it, expect } from 'vitest';
import { hostUnavailableReason } from './hostUnavailable';

describe('hostUnavailableReason', () => {
  it('recognises the reasons that mean the agent server\'s conversation log cannot be reached', () => {
    expect(hostUnavailableReason('agent_unreachable')).toBe('agent_unreachable');
    expect(hostUnavailableReason('agent_outdated')).toBe('agent_outdated');
    expect(hostUnavailableReason('agent_bad_response')).toBe('agent_bad_response');
  });

  it('does not treat other reasons or free-form errors as host problems', () => {
    expect(hostUnavailableReason('unsupported_server')).toBeNull();
    expect(hostUnavailableReason('no_recent_session')).toBeNull();
    expect(hostUnavailableReason('HTTP 500')).toBeNull();
    expect(hostUnavailableReason(undefined)).toBeNull();
  });
});
