import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { CodexSessionStrategy } from './SessionStrategy';

const server: ServerConfig = {
  name: 'local',
  type: 'local',
  host: null,
  agentPort: null,
  agentToken: null,
  agentVersion: null,
  sshHost: null,
  muxRuntime: 'system',
  sshHostFingerprint: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function createStrategy(output: string): { strategy: CodexSessionStrategy; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn().mockResolvedValue({ stdout: output, stderr: '', code: 0 });
  const transportFactory = { getTransport: vi.fn().mockReturnValue({ exec }) } as unknown as TransportFactory;
  return { strategy: new CodexSessionStrategy(transportFactory), exec };
}

function meta(filePath: string, sessionId: string, cwd: string | null, originator: string | null): string {
  return [
    `FILE:${filePath}`,
    JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId, cwd, originator } }),
  ].join('\n');
}

describe('CodexSessionStrategy.scanSessionId', () => {
  it('returns a session with a matching cwd', async () => {
    const { strategy } = createStrategy(meta('/tmp/rollout.jsonl', 'session-1', '/work', 'codex'));
    await expect(strategy.scanSessionId(server, '/work')).resolves.toBe('session-1');
  });

  it('excludes a mismatched cwd', async () => {
    const { strategy } = createStrategy(meta('/tmp/rollout.jsonl', 'session-1', '/other', 'codex'));
    await expect(strategy.scanSessionId(server, '/work')).resolves.toBeNull();
  });

  it('excludes codex_exec sessions', async () => {
    const { strategy } = createStrategy(meta('/tmp/rollout.jsonl', 'session-1', '/work', 'codex_exec'));
    await expect(strategy.scanSessionId(server, '/work')).resolves.toBeNull();
  });

  it('selects the oldest candidate after filtering', async () => {
    const output = [
      meta('/tmp/old.jsonl', 'old', '/work', 'codex'),
      meta('/tmp/new.jsonl', 'new', '/work', 'codex'),
    ].join('\n');
    const { strategy } = createStrategy(output);
    await expect(strategy.scanSessionId(server, '/work')).resolves.toBe('old');
  });

  it('skips cwd filtering when workingDirectory is null', async () => {
    const output = [
      meta('/tmp/other.jsonl', 'other', '/other', 'codex'),
      meta('/tmp/exec.jsonl', 'exec', '/work', 'codex_exec'),
    ].join('\n');
    const { strategy } = createStrategy(output);
    await expect(strategy.scanSessionId(server, null)).resolves.toBe('other');
  });

  it('normalizes trailing slashes before comparing cwd', async () => {
    const { strategy } = createStrategy(meta('/tmp/rollout.jsonl', 'session-1', '/work/', 'codex'));
    await expect(strategy.scanSessionId(server, '/work///')).resolves.toBe('session-1');
  });

  it('skips candidates with invalid session metadata', async () => {
    const { strategy } = createStrategy('FILE:/tmp/bad.jsonl\nnot json');
    await expect(strategy.scanSessionId(server, '/work')).resolves.toBeNull();
  });

  it('skips excluded session IDs and returns the next candidate', async () => {
    const output = [
      meta('/tmp/old.jsonl', 'assigned', '/work', 'codex'),
      meta('/tmp/new.jsonl', 'unassigned', '/work', 'codex'),
    ].join('\n');
    const { strategy } = createStrategy(output);
    strategy.excludeSessionId('assigned');
    await expect(strategy.scanSessionId(server, '/work')).resolves.toBe('unassigned');
  });
});
