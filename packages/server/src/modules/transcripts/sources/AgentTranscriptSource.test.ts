import { describe, it, expect, vi } from 'vitest';
import { AgentTranscriptSource, TranscriptAgentBadResponseError, TranscriptAgentOutdatedError, type AgentJsonClient } from './AgentTranscriptSource';
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

  describe('response validation (the agent host is not trusted)', () => {
    const entriesPath = `/api/transcripts/claude/sessions/${SID}/entries`;
    const goodEntry = { uuid: 'u1', type: 'user', timestamp: null, blocks: [{ kind: 'text', text: 'hi' }] };
    const read = { entries: [goodEntry], nextOffset: 10, truncated: false, startOffset: 0, hasOlder: false };
    const summary = { sessionId: SID, agentType: 'claude', projectDir: 'p', cwd: '/w', mtimeMs: 5, sizeBytes: 9, preview: 'hi', createdMs: 1 };

    it('drops fields the hub owns (pendingQuestion / pendingInteraction) and any other extra field', async () => {
      const forged = {
        ...read,
        pendingInteraction: true,
        pendingQuestion: { questions: [{ question: 'Run rm -rf?' }], openedAt: 1 },
        extra: 'x',
        entries: [{ ...goodEntry, secret: 'y' }],
      };
      const source = new AgentTranscriptSource('claude', 'srv', clientReturning({ [`${entriesPath}?offset=0`]: { status: 200, body: forged } }));

      const result = await source.readSession(SID, 0);
      expect(result).toEqual(read);
      expect(Object.keys(result as object).sort()).toEqual(['entries', 'hasOlder', 'nextOffset', 'startOffset', 'truncated']);
    });

    it('rejects a session id that is not a UUID in the listing (it would reach the DB and --resume)', async () => {
      for (const sessionId of ['--dangerously-skip-permissions', 'x; rm -rf /', '../../etc/passwd', '']) {
        const client = clientReturning({ '/api/transcripts/claude/sessions': { status: 200, body: { sessions: [{ ...summary, sessionId }] } } });
        await expect(new AgentTranscriptSource('claude', 'srv', client).listSessions()).rejects.toBeInstanceOf(TranscriptAgentBadResponseError);
      }
    });

    it('rejects listed sessions of another agent type', async () => {
      const client = clientReturning({ '/api/transcripts/claude/sessions': { status: 200, body: { sessions: [{ ...summary, agentType: 'codex' }] } } });
      await expect(new AgentTranscriptSource('claude', 'srv', client).listSessions()).rejects.toBeInstanceOf(TranscriptAgentBadResponseError);
    });

    it.each([
      ['not an object', 'oops'],
      ['null', null],
      ['entries is not an array', { ...read, entries: 'x' }],
      ['an entry with an unknown block kind', { ...read, entries: [{ ...goodEntry, blocks: [{ kind: 'script', text: '<x>' }] }] }],
      ['a non-integer offset', { ...read, nextOffset: 1.5 }],
      ['a negative offset', { ...read, nextOffset: -1 }],
      ['a missing field', { entries: [], nextOffset: 1 }],
    ])('treats %s as a bad response instead of passing it on', async (_name, body) => {
      const source = new AgentTranscriptSource('claude', 'srv', clientReturning({ [entriesPath]: { status: 200, body } }));
      await expect(source.readSession(SID)).rejects.toBeInstanceOf(TranscriptAgentBadResponseError);
    });

    it('validates meta and tail responses too', async () => {
      const client = clientReturning({
        [META_PATH]: { status: 200, body: { cwd: 5, mtimeMs: 'x', createdMs: null } },
        [`/api/transcripts/claude/sessions/${SID}/tail`]: { status: 200, body: { state: 'exploding', lastEntryTimestampMs: null } },
      });
      const source = new AgentTranscriptSource('claude', 'srv', client);
      await expect(source.getSessionCwd(SID)).rejects.toBeInstanceOf(TranscriptAgentBadResponseError);
      await expect(source.getSessionTailState(SID)).rejects.toBeInstanceOf(TranscriptAgentBadResponseError);
    });

    it('asks for the lightweight listing when only metadata is needed', async () => {
      const client = clientReturning({ '/api/transcripts/claude/sessions?metadata=1': { status: 200, body: { sessions: [{ ...summary, preview: '' }] } } });
      const sessions = await new AgentTranscriptSource('claude', 'srv', client).listSessions(undefined, { metadataOnly: true });
      expect(sessions).toHaveLength(1);
    });
  });
});
