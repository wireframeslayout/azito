import { describe, it, expect } from 'vitest';
import { mapAppError } from './mapAppError';
import { HostProfileError } from '../shared/os/hostProfile';
import { AgentUnreachableError } from '../modules/servers/transport/AgentUnreachableError';

describe('mapAppError', () => {
  it('maps AgentUnreachableError to 503 agent_unreachable', () => {
    expect(mapAppError(new AgentUnreachableError('srv7', 'circuit_open'))).toEqual({
      status: 503,
      body: { error: 'agent_unreachable', server: 'srv7', reason: 'circuit_open' },
    });
  });

  it('maps a HostProfileError to 501 with the reason in error and its code', () => {
    expect(mapAppError(new HostProfileError('unsupported_os', 'installing tmux is a POSIX shell script, which this server (win32) does not have.'))).toEqual({
      status: 501,
      body: { error: 'installing tmux is a POSIX shell script, which this server (win32) does not have.', code: 'unsupported_os' },
    });
    expect(mapAppError(new HostProfileError('unsupported_host', 'Unsupported host freebsd/x64'))?.body.code).toBe('unsupported_host');
  });

  it('returns null for unrelated errors', () => {
    expect(mapAppError(new Error('boom'))).toBeNull();
  });
});
