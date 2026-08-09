import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import transcriptsRoutes from './routes';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { TranscriptPaneService } from './TranscriptPaneService';

const SID = '11111111-1111-1111-1111-111111111111';
const PANE_ID = '%3';

function buildClaudeSource(overrides: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    agentType: 'claude',
    listSessions: () => [],
    readSession: () => ({ entries: [], nextOffset: 0, truncated: false, startOffset: 0, hasOlder: false }),
    readSessionBefore: () => ({ entries: [], prevOffset: 0, hasOlder: false }),
    getSessionCwd: () => ({ cwd: null }),
    ...overrides,
  } as unknown as TranscriptSource;
}

function buildCodexSource(overrides: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    agentType: 'codex',
    listSessions: () => [],
    readSession: () => ({ entries: [], nextOffset: 0, truncated: false, startOffset: 0, hasOlder: false }),
    readSessionBefore: () => ({ entries: [], prevOffset: 0, hasOlder: false }),
    getSessionCwd: () => ({ cwd: null }),
    ...overrides,
  } as unknown as TranscriptSource;
}

function buildApp(
  sources: TranscriptSource[] = [buildClaudeSource()],
  paneOverrides: Partial<TranscriptPaneService> = {},
) {
  const transcriptPaneService = {
    listPaneCandidates: async () => ({ cwd: null, panes: [] }),
    sendInput: async () => 'ok' as const,
    sendSignal: async () => 'ok' as const,
    ...paneOverrides,
  } as unknown as TranscriptPaneService;

  const app = Fastify();
  app.register(transcriptsRoutes, { sources, transcriptPaneService });
  return app;
}

describe('GET /api/transcripts', () => {
  it('merges sessions across sources and sorts by mtime descending', async () => {
    const claude = buildClaudeSource({
      listSessions: () => [
        { sessionId: 'a', agentType: 'claude', projectDir: 'p', cwd: null, mtimeMs: 100, sizeBytes: 1, preview: 'a' },
      ],
    });
    const codex = buildCodexSource({
      listSessions: () => [
        { sessionId: 'b', agentType: 'codex', projectDir: 'p', cwd: null, mtimeMs: 200, sizeBytes: 1, preview: 'b' },
      ],
    });
    const app = buildApp([claude, codex]);
    const res = await app.inject({ method: 'GET', url: '/api/transcripts' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['b', 'a']);
    await app.close();
  });

  it('filters by ?agent=', async () => {
    const claude = buildClaudeSource({
      listSessions: () => [
        { sessionId: 'a', agentType: 'claude', projectDir: 'p', cwd: null, mtimeMs: 100, sizeBytes: 1, preview: 'a' },
      ],
    });
    const codex = buildCodexSource({
      listSessions: () => [
        { sessionId: 'b', agentType: 'codex', projectDir: 'p', cwd: null, mtimeMs: 200, sizeBytes: 1, preview: 'b' },
      ],
    });
    const app = buildApp([claude, codex]);
    const res = await app.inject({ method: 'GET', url: '/api/transcripts?agent=codex' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['b']);
    await app.close();
  });
});

describe('GET /api/transcripts/:agent/:id', () => {
  it('returns 404 for an unknown agent type', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/unknown/${SID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a non-integer offset with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?offset=1.5` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a negative offset with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?offset=-1` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('accepts a valid integer offset', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?offset=42` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('reads from the matching agent source', async () => {
    let received: { sessionId: string; offset: number | undefined } | null = null;
    const codex = buildCodexSource({
      readSession: (sessionId: string, offset?: number) => {
        received = { sessionId, offset };
        return { entries: [], nextOffset: 0, truncated: false, startOffset: 0, hasOlder: false };
      },
    });
    const app = buildApp([buildClaudeSource(), codex]);
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/codex/${SID}` });
    expect(res.statusCode).toBe(200);
    expect(received).toEqual({ sessionId: SID, offset: undefined });
    await app.close();
  });

  it('returns 404 when the session is not found', async () => {
    const app = buildApp([buildClaudeSource({ readSession: () => null })]);
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a non-integer before with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?before=1.5` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a negative before with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?before=-1` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects specifying both offset and before with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?offset=1&before=1` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('reads via readSessionBefore when before is given', async () => {
    let received: { sessionId: string; before: number } | null = null;
    const claude = buildClaudeSource({
      readSessionBefore: (sessionId: string, before: number) => {
        received = { sessionId, before };
        return { entries: [], prevOffset: 10, hasOlder: true };
      },
    });
    const app = buildApp([claude]);
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?before=42` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], prevOffset: 10, hasOlder: true });
    expect(received).toEqual({ sessionId: SID, before: 42 });
    await app.close();
  });

  it('returns 404 from readSessionBefore when the session is not found', async () => {
    const app = buildApp([buildClaudeSource({ readSessionBefore: () => null })]);
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?before=42` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/transcripts/:agent/:id/panes', () => {
  it('returns cwd and pane candidates for claude', async () => {
    const app = buildApp([buildClaudeSource()], {
      listPaneCandidates: async () => ({
        cwd: '/home/user/project',
        panes: [
          { paneId: '%1', sessionName: 's', windowIndex: 0, windowName: 'w', paneIndex: 0, currentPath: '/home/user/project', currentCommand: 'claude', cwdMatch: true },
        ],
      }),
    });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}/panes` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      cwd: '/home/user/project',
      panes: [
        { paneId: '%1', sessionName: 's', windowIndex: 0, windowName: 'w', paneIndex: 0, currentPath: '/home/user/project', currentCommand: 'claude', cwdMatch: true },
      ],
    });
    await app.close();
  });

  it('returns 404 when the session is not found', async () => {
    const app = buildApp([buildClaudeSource()], { listPaneCandidates: async () => null });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}/panes` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 501 for a non-claude agent', async () => {
    const app = buildApp([buildClaudeSource(), buildCodexSource()]);
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/codex/${SID}/panes` });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});

describe('POST /api/transcripts/:agent/:id/input', () => {
  it('rejects a malformed paneId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/input`,
      payload: { paneId: 'not-a-pane', text: 'hello' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects empty text with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/input`,
      payload: { paneId: PANE_ID, text: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects text over the max length with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'x'.repeat(32769) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a missing text field with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/input`,
      payload: { paneId: PANE_ID },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when the session is not found', async () => {
    const app = buildApp([buildClaudeSource()], { sendInput: async () => 'session_not_found' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 when the pane no longer exists', async () => {
    const app = buildApp([buildClaudeSource()], { sendInput: async () => 'pane_not_found' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('sends input and returns ok on success', async () => {
    let received: { sessionId: string; paneId: string; text: string } | null = null;
    const app = buildApp([buildClaudeSource()], {
      sendInput: async (sessionId: string, paneId: string, text: string) => {
        received = { sessionId, paneId, text };
        return 'ok';
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'hello world' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(received).toEqual({ sessionId: SID, paneId: PANE_ID, text: 'hello world' });
    await app.close();
  });

  it('returns 501 for a non-claude agent', async () => {
    const app = buildApp([buildClaudeSource(), buildCodexSource()]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/codex/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'hello' },
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});

describe('POST /api/transcripts/:agent/:id/signal', () => {
  it('rejects a malformed paneId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: 'not-a-pane', action: 'interrupt' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an invalid action with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('sends the profile interrupt key for action:"interrupt" and returns ok', async () => {
    let received: { source: unknown; sessionId: string; paneId: string; key: string } | null = null;
    const app = buildApp([buildClaudeSource()], {
      sendSignal: async (source: unknown, sessionId: string, paneId: string, key: string) => {
        received = { source, sessionId, paneId, key };
        return 'ok';
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(received).not.toBeNull();
    expect(received!.sessionId).toBe(SID);
    expect(received!.paneId).toBe(PANE_ID);
    expect(received!.key).toBe('Escape'); // claude profile's interruptKey
    await app.close();
  });

  it('allows action:"interrupt" for a non-claude agent that has a profile (codex)', async () => {
    const app = buildApp([buildClaudeSource(), buildCodexSource()], {
      sendSignal: async () => 'ok',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/codex/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 400 for action:"interrupt" when the agent has no transcript profile', async () => {
    // stub a source with an agentType that has no profile entry in sources/profiles.ts
    const otherSource = buildClaudeSource({ agentType: 'other', getSessionCwd: () => ({ cwd: null }) });
    const app = buildApp([otherSource], { sendSignal: async () => 'ok' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/other/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('sends the given key for action:"key" and returns ok', async () => {
    let receivedKey: string | null = null;
    const app = buildApp([buildClaudeSource()], {
      sendSignal: async (_source: unknown, _sessionId: string, _paneId: string, key: string) => {
        receivedKey = key;
        return 'ok';
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'key', key: 'C-c' },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedKey).toBe('C-c');
    await app.close();
  });

  it('rejects action:"key" with an invalid key value with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'key', key: 'Enter' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects action:"key" with a missing key with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'key' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when the pane no longer exists', async () => {
    const app = buildApp([buildClaudeSource()], { sendSignal: async () => 'pane_not_found' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 when the session is not found', async () => {
    const app = buildApp([buildClaudeSource()], { sendSignal: async () => 'session_not_found' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/claude/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for an unknown agent type', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/unknown/${SID}/signal`,
      payload: { paneId: PANE_ID, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── 後方互換ルート（旧 UUID 直下パス、claude 固定） ──

describe('GET /api/transcripts/:sessionId (legacy)', () => {
  it('rejects a non-integer offset with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}?offset=1.5` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('accepts a valid integer offset', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}?offset=42` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 404 when the session is not found', async () => {
    const app = buildApp([buildClaudeSource({ readSession: () => null })]);
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reads via readSessionBefore when before is given', async () => {
    const app = buildApp([buildClaudeSource({ readSessionBefore: () => ({ entries: [], prevOffset: 0, hasOlder: false }) })]);
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}?before=10` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], prevOffset: 0, hasOlder: false });
    await app.close();
  });

  it('rejects specifying both offset and before with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}?offset=1&before=1` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/transcripts/:sessionId/panes (legacy)', () => {
  it('returns cwd and pane candidates', async () => {
    const app = buildApp([buildClaudeSource()], {
      listPaneCandidates: async () => ({
        cwd: '/home/user/project',
        panes: [
          { paneId: '%1', sessionName: 's', windowIndex: 0, windowName: 'w', paneIndex: 0, currentPath: '/home/user/project', currentCommand: 'claude', cwdMatch: true },
        ],
      }),
    });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}/panes` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 404 when the session is not found', async () => {
    const app = buildApp([buildClaudeSource()], { listPaneCandidates: async () => null });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}/panes` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/transcripts/:sessionId/input (legacy)', () => {
  it('sends input and returns ok on success', async () => {
    let received: { sessionId: string; paneId: string; text: string } | null = null;
    const app = buildApp([buildClaudeSource()], {
      sendInput: async (sessionId: string, paneId: string, text: string) => {
        received = { sessionId, paneId, text };
        return 'ok';
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'hello world' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(received).toEqual({ sessionId: SID, paneId: PANE_ID, text: 'hello world' });
    await app.close();
  });

  it('rejects a malformed paneId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/${SID}/input`,
      payload: { paneId: 'not-a-pane', text: 'hello' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
