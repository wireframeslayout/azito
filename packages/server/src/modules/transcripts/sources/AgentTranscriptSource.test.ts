import { describe, it, expect, vi } from 'vitest';
import { AgentTranscriptSource, TranscriptAgentOutdatedError, type AgentJsonClient } from './AgentTranscriptSource';
import { AgentUnreachableError } from '../../servers/transport/AgentUnreachableError';

const SID = '11111111-1111-1111-1111-111111111111';

function clientReturning(responses: Record<string, { status: number; body: unknown }>): AgentJsonClient & { getJson: ReturnType<typeof vi.fn> } {
  return {
    getJson: vi.fn(async (path: string) => {
      const hit = responses[path];
      if (!hit) return { status: 404, body: { message: `Route GET:${path} not found`, error: 'Not Found' } };
      return hit;
    }),
  };
}

const META_PATH = `/api/transcripts/claude/sessions/${SID}/meta`;

describe('AgentTranscriptSource', () => {
  it('lists sessions without the wire-only createdMs and remembers it for getSessionCreatedMs', async () => {
    const summary = { sessionId: SID, agentType: 'claude', projectDir: 'p', cwd: '/w', mtimeMs: 5, sizeBytes: 9, preview: 'hi' };
    const client = clientReturning({ '/api/transcripts/claude/sessions?limit=10': { status: 200, body: { sessions: [{ ...summary, createdMs: 123 }] } } });
    const source = new AgentTranscriptSource('claude', 'srv', client);

    expect(await source.listSessions(10)).toEqual([summary]);
    expect(await source.getSessionCreatedMs(SID)).toBe(123);
    expect(client.getJson).toHaveBeenCalledTimes(1);
  });

  it('answers cwd, mtime and creation time of one session from a single meta request', async () => {
    const client = clientReturning({ [META_PATH]: { status: 200, body: { cwd: '/w', mtimeMs: 7, createdMs: 3 } } });
    const source = new AgentTranscriptSource('claude', 'srv', client);

    expect(await source.getSessionCwd(SID)).toEqual({ cwd: '/w' });
    expect(await source.getSessionMtimeMs(SID)).toBe(7);
    expect(await source.getSessionCreatedMs(SID)).toBe(3);
    expect(client.getJson).toHaveBeenCalledTimes(1);
  });

  it('passes offset and before to the agent so only the requested range is transferred', async () => {
    const entriesPath = `/api/transcripts/claude/sessions/${SID}/entries`;
    const client = clientReturning({
      [`${entriesPath}?offset=42`]: { status: 200, body: { entries: [], nextOffset: 50, truncated: false, startOffset: 42, hasOlder: true } },
      [`${entriesPath}?before=42`]: { status: 200, body: { entries: [], prevOffset: 10, hasOlder: true } },
      [entriesPath]: { status: 200, body: { entries: [], nextOffset: 1, truncated: false, startOffset: 0, hasOlder: false } },
    });
    const source = new AgentTranscriptSource('claude', 'srv', client);

    expect((await source.readSession(SID, 42))?.nextOffset).toBe(50);
    expect((await source.readSessionBefore(SID, 42))?.prevOffset).toBe(10);
    expect((await source.readSession(SID))?.nextOffset).toBe(1);
  });

  it('returns null / unknown when the agent reports the session missing', async () => {
    const missing = { status: 404, body: { error: 'session_not_found' } };
    const client = clientReturning({
      [META_PATH]: missing,
      [`/api/transcripts/claude/sessions/${SID}/entries`]: missing,
      [`/api/transcripts/claude/sessions/${SID}/tail`]: missing,
    });
    const source = new AgentTranscriptSource('claude', 'srv', client);

    expect(await source.getSessionCwd(SID)).toBeNull();
    expect(await source.getSessionMtimeMs(SID)).toBeNull();
    expect(await source.readSession(SID)).toBeNull();
    expect(await source.getSessionTailState(SID)).toEqual({ state: 'unknown', lastEntryTimestampMs: null });
  });

  it('treats a missing route (an agent without the transcript API) as outdated, not as a missing session', async () => {
    const source = new AgentTranscriptSource('claude', 'srv', clientReturning({}));
    await expect(source.getSessionCwd(SID)).rejects.toBeInstanceOf(TranscriptAgentOutdatedError);
    await expect(source.listSessions()).rejects.toBeInstanceOf(TranscriptAgentOutdatedError);
  });

  it('propagates an unreachable agent', async () => {
    const client: AgentJsonClient = { getJson: async () => { throw new AgentUnreachableError('srv', 'circuit_open'); } };
    const source = new AgentTranscriptSource('claude', 'srv', client);
    await expect(source.readSession(SID)).rejects.toBeInstanceOf(AgentUnreachableError);
  });

  it('fails on other statuses instead of hiding them', async () => {
    const source = new AgentTranscriptSource('claude', 'srv', clientReturning({ [META_PATH]: { status: 500, body: null } }));
    await expect(source.getSessionCwd(SID)).rejects.toThrow('failed (500)');
  });
});
