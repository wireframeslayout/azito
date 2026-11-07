import { describe, it, expect, vi } from 'vitest';
import { DaemonSessionChecker, attachIdOf, matchBackgroundSession, parseAgentsJson } from './DaemonSessionChecker';
import type { ClaudeAgentsEntry } from './DaemonSessionChecker';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import type { ServerConfig } from '../../servers/Server';

const SESSION_ID = '14b46fcb-1234-4def-8abc-000000000001';

function serverConfig(): ServerConfig {
  return { name: 'local-server', type: 'local', host: null, agentPort: null, agentToken: null, agentVersion: null, sshHost: null, hostProfile: null, sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, defaultMux: 'tmux' as const, muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z' };
}

function transportFactoryWith(run: IServerTransport['run']): TransportFactory {
  return { getTransport: () => ({ run }) as unknown as IServerTransport } as unknown as TransportFactory;
}

function okRun(stdout: string) {
  return vi.fn(async (_spec: unknown) => ({ exitCode: 0, signal: null, stdout, stderr: '' }));
}

describe('parseAgentsJson', () => {
  it('parses the listing the CLI prints', () => {
    const stdout = JSON.stringify([{ id: '14b46fcb', kind: 'background', sessionId: SESSION_ID, state: 'busy' }]);
    expect(parseAgentsJson(stdout)).toHaveLength(1);
  });

  it('rejects output that is not a JSON array', () => {
    expect(() => parseAgentsJson('{"id":"x"}')).toThrow();
    expect(() => parseAgentsJson('not json at all')).toThrow();
  });
});

describe('matchBackgroundSession', () => {
  it('matches the entry whose sessionId equals the recorded one', () => {
    const entries = parseAgentsJson(JSON.stringify([
      { id: 'aaaa1111', kind: 'background', sessionId: 'aaaa1111-2222-4333-8444-555566667777' },
      { id: '14b46fcb', kind: 'background', sessionId: SESSION_ID },
    ]));
    expect(matchBackgroundSession(entries, SESSION_ID)?.id).toBe('14b46fcb');
  });

  it('never matches by prefix or an interactive entry', () => {
    const entries: ClaudeAgentsEntry[] = [
      // A DIFFERENT conversation whose sessionId merely starts with the same 8 characters.
      { id: '14b46fcb', kind: 'background', sessionId: `${SESSION_ID.slice(0, 8)}-ffff-4def-8abc-999999999999` },
      { pid: 1, kind: 'interactive', sessionId: SESSION_ID },
    ];
    expect(matchBackgroundSession(entries, SESSION_ID)).toBeNull();
  });
});

describe('attachIdOf', () => {
  it('takes the id the entry printed', () => {
    expect(attachIdOf({ id: '14b46fcb', kind: 'background', sessionId: SESSION_ID }, SESSION_ID)).toBe('14b46fcb');
  });

  it('falls back to the first 8 characters of the session id when the entry has none', () => {
    expect(attachIdOf({ kind: 'background', sessionId: SESSION_ID }, SESSION_ID)).toBe(SESSION_ID.slice(0, 8));
  });
});

describe('DaemonSessionChecker.check', () => {
  it('answers attach with the printed id when the daemon holds the conversation', async () => {
    const run = okRun(JSON.stringify([{ id: '14b46fcb', kind: 'background', sessionId: SESSION_ID, state: 'busy' }]));
    const verdict = await new DaemonSessionChecker(transportFactoryWith(run)).check(serverConfig(), SESSION_ID);
    expect(verdict).toEqual({ status: 'attach', attachId: '14b46fcb' });
  });

  it('answers resume when the daemon does not hold it (and the listing has an interactive entry of the same id)', async () => {
    const run = okRun(JSON.stringify([{ pid: 7, kind: 'interactive', sessionId: SESSION_ID }]));
    const verdict = await new DaemonSessionChecker(transportFactoryWith(run)).check(serverConfig(), SESSION_ID);
    expect(verdict).toEqual({ status: 'resume' });
  });

  it('answers resume on an empty listing', async () => {
    const verdict = await new DaemonSessionChecker(transportFactoryWith(okRun('[]'))).check(serverConfig(), SESSION_ID);
    expect(verdict).toEqual({ status: 'resume' });
  });

  it('answers unknown when the CLI has no agents subcommand (an old Claude Code)', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, signal: null, stdout: '', stderr: "error: unknown command 'agents'" }));
    const verdict = await new DaemonSessionChecker(transportFactoryWith(run)).check(serverConfig(), SESSION_ID);
    expect(verdict).toEqual({ status: 'unknown', reason: expect.stringContaining("unknown command 'agents'") });
  });

  it('answers unknown on unreadable output', async () => {
    const verdict = await new DaemonSessionChecker(transportFactoryWith(okRun('not json'))).check(serverConfig(), SESSION_ID);
    expect(verdict.status).toBe('unknown');
  });

  it('answers unknown when the program cannot be run at all', async () => {
    const run = vi.fn(async () => { throw new Error('spawn claude ENOENT'); });
    const verdict = await new DaemonSessionChecker(transportFactoryWith(run)).check(serverConfig(), SESSION_ID);
    expect(verdict).toEqual({ status: 'unknown', reason: expect.stringContaining('ENOENT') });
  });

  it('runs the listing with the conversation CLAUDE_CONFIG_DIR when the window records one', async () => {
    const run = okRun('[]');
    const configDir = '/home/me/.claude-project';
    await new DaemonSessionChecker(transportFactoryWith(run)).check(serverConfig(), SESSION_ID, configDir);
    expect(run.mock.calls[0][0]).toMatchObject({ file: 'claude', args: ['agents', '--json'], env: { CLAUDE_CONFIG_DIR: configDir } });
  });

  it('runs the listing without an env override when no config directory is recorded', async () => {
    const run = okRun('[]');
    await new DaemonSessionChecker(transportFactoryWith(run)).check(serverConfig(), SESSION_ID, null);
    expect(run.mock.calls[0][0]).toMatchObject({ file: 'claude', args: ['agents', '--json'] });
    expect((run.mock.calls[0][0] as { env?: unknown }).env).toBeUndefined();
  });
});
