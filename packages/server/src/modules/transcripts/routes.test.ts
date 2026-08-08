import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import transcriptsRoutes from './routes';
import type { TranscriptService } from './TranscriptService';

const SID = '11111111-1111-1111-1111-111111111111';

function buildApp(overrides: Partial<TranscriptService> = {}) {
  const transcriptService = {
    listSessions: () => [],
    readSession: () => ({ entries: [], nextOffset: 0, truncated: false }),
    ...overrides,
  } as unknown as TranscriptService;

  const app = Fastify();
  app.register(transcriptsRoutes, { transcriptService });
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
