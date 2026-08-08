import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import transcriptsRoutes from './routes';
import type { TranscriptService } from './TranscriptService';
import type { TranscriptPaneService } from './TranscriptPaneService';

const SID = '11111111-1111-1111-1111-111111111111';
const PANE_ID = '%3';

function buildApp(
  overrides: Partial<TranscriptService> = {},
  paneOverrides: Partial<TranscriptPaneService> = {},
) {
  const transcriptService = {
    listSessions: () => [],
    readSession: () => ({ entries: [], nextOffset: 0, truncated: false }),
    ...overrides,
  } as unknown as TranscriptService;

  const transcriptPaneService = {
    listPaneCandidates: async () => ({ cwd: null, panes: [] }),
    sendInput: async () => 'ok' as const,
    ...paneOverrides,
  } as unknown as TranscriptPaneService;

  const app = Fastify();
  app.register(transcriptsRoutes, { transcriptService, transcriptPaneService });
  return app;
}

describe('GET /api/transcripts/:sessionId', () => {
  it('rejects a non-integer offset with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}?offset=1.5` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a non-numeric offset with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}?offset=abc` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a negative offset with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}?offset=-1` });
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
    const app = buildApp({ readSession: () => null });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/transcripts/:sessionId/panes', () => {
  it('returns cwd and pane candidates', async () => {
    const app = buildApp({}, {
      listPaneCandidates: async () => ({
        cwd: '/home/user/project',
        panes: [
          { paneId: '%1', sessionName: 's', windowIndex: 0, windowName: 'w', paneIndex: 0, currentPath: '/home/user/project', currentCommand: 'claude', cwdMatch: true },
        ],
      }),
    });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}/panes` });
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
    const app = buildApp({}, { listPaneCandidates: async () => null });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/${SID}/panes` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/transcripts/:sessionId/input', () => {
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

  it('rejects empty text with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/${SID}/input`,
      payload: { paneId: PANE_ID, text: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects text over the max length with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'x'.repeat(32769) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a missing text field with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/${SID}/input`,
      payload: { paneId: PANE_ID },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when the session is not found', async () => {
    const app = buildApp({}, { sendInput: async () => 'session_not_found' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 when the pane no longer exists', async () => {
    const app = buildApp({}, { sendInput: async () => 'pane_not_found' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/transcripts/${SID}/input`,
      payload: { paneId: PANE_ID, text: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('sends input and returns ok on success', async () => {
    let received: { sessionId: string; paneId: string; text: string } | null = null;
    const app = buildApp({}, {
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
});
