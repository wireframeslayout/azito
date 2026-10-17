import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import transcriptRoutes from './transcriptRoutes';
import { agentAuthHook } from './authHook';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { ClaudeTranscriptSource } from '../modules/transcripts/sources/ClaudeTranscriptSource';
import { CodexTranscriptSource } from '../modules/transcripts/sources/CodexTranscriptSource';

const TOKEN = 'agent-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SID = '11111111-1111-1111-1111-111111111111';

function userLine(uuid: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', cwd: '/work/proj', message: { role: 'user', content: text } }) + '\n';
}

describe('agent transcript routes', () => {
  let root: string;
  let secretFile: string;
  let sessionFile: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-transcripts-'));
    const projects = path.join(root, 'claude', 'projects');
    fs.mkdirSync(path.join(projects, 'proj-a'), { recursive: true });
    sessionFile = path.join(projects, 'proj-a', `${SID}.jsonl`);
    fs.writeFileSync(sessionFile, userLine('u1', 'hello from the agent host'));
    // A file outside the agent session directories that must stay unreachable.
    secretFile = path.join(root, 'secret.jsonl');
    fs.writeFileSync(secretFile, userLine('s1', 'top secret'));

    app = Fastify();
    app.addHook('onRequest', agentAuthHook(createTokenVerifier(TOKEN)));
    await app.register(transcriptRoutes, {
      readers: [new ClaudeTranscriptSource(projects), new CodexTranscriptSource(path.join(root, 'codex', 'sessions'))],
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('authentication', () => {
    const urls = [
      '/api/transcripts/claude/sessions',
      `/api/transcripts/claude/sessions/${SID}/meta`,
      `/api/transcripts/claude/sessions/${SID}/entries`,
      `/api/transcripts/claude/sessions/${SID}/tail`,
    ];

    it.each(urls)('rejects %s without a token', async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('hello from the agent host');
    });

    it.each(urls)('rejects %s with a wrong token', async (url) => {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer nope' } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('path restriction', () => {
    it.each([
      encodeURIComponent('../../secret'),
      encodeURIComponent('proj-a/../../../secret'),
      encodeURIComponent('/etc/passwd'),
      '..%2F..%2Fsecret',
      'not-a-uuid',
    ])('does not read anything for session id %s', async (id) => {
      for (const leaf of ['meta', 'entries', 'tail']) {
        const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${id}/${leaf}`, headers: AUTH });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('top secret');
      }
    });

    it('has no endpoint that takes a file path', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/x/entries?path=${encodeURIComponent(secretFile)}`, headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('top secret');
    });

    it('rejects an unknown agent type', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/transcripts/..%2F..%2Fetc/sessions', headers: AUTH });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('reading', () => {
    it('lists sessions with their creation time', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/transcripts/claude/sessions', headers: AUTH });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { sessions: { sessionId: string; cwd: string | null; createdMs: number | null }[] };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]).toMatchObject({ sessionId: SID, cwd: '/work/proj' });
      expect(typeof body.sessions[0].createdMs).toBe('number');
    });

    it('returns cwd, mtime and creation time of one session in a single response', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${SID}/meta`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      const meta = res.json() as { cwd: string | null; mtimeMs: number | null; createdMs: number | null };
      expect(meta.cwd).toBe('/work/proj');
      expect(meta.mtimeMs).toBeGreaterThan(0);
    });

    it('answers 404 session_not_found for a well-formed id that does not exist (distinct from a missing route)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/transcripts/claude/sessions/22222222-2222-2222-2222-222222222222/meta', headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'session_not_found' });
    });

    it('reads only the appended part when an offset is given', async () => {
      const first = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${SID}/entries`, headers: AUTH });
      const firstBody = first.json() as { entries: { uuid: string }[]; nextOffset: number };
      expect(firstBody.entries.map((e) => e.uuid)).toEqual(['u1']);

      fs.appendFileSync(sessionFile, userLine('u2', 'appended later'));
      const diff = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${SID}/entries?offset=${firstBody.nextOffset}`, headers: AUTH });
      const diffBody = diff.json() as { entries: { uuid: string }[] };
      expect(diffBody.entries.map((e) => e.uuid)).toEqual(['u2']);
    });

    it('rejects offset together with before, and invalid numbers', async () => {
      const both = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${SID}/entries?offset=1&before=1`, headers: AUTH });
      expect(both.statusCode).toBe(400);
      const bad = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${SID}/entries?offset=-1`, headers: AUTH });
      expect(bad.statusCode).toBe(400);
    });

    it('reports the tail state of a session', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${SID}/tail`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'in_progress' });
    });
  });
});

describe('agent-side directory resolution', () => {
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
  });

  afterEach(() => {
    if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.claude;
    if (saved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.codex;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resolves the session directories from the agent process's own environment (CLAUDE_CONFIG_DIR)", async () => {
    const projects = path.join(home, 'cfg', 'projects', 'p');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${SID}.jsonl`), userLine('u1', 'from CLAUDE_CONFIG_DIR'));
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'cfg');

    const app = Fastify();
    await app.register(transcriptRoutes, { readers: [new ClaudeTranscriptSource()] });
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/claude/sessions' });
    expect((res.json() as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId)).toEqual([SID]);
    await app.close();
  });
});

describe('agent read budgets', () => {
  const SID_BIG = '33333333-3333-3333-3333-333333333333';
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-budget-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function uuid(n: number): string {
    return `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
  }

  function sumRequestedBytes(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.reduce((sum, call) => sum + (call[3] as number), 0);
  }

  async function appWith(reader: ClaudeTranscriptSource | CodexTranscriptSource): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(transcriptRoutes, { readers: [reader] });
    return app;
  }

  it('reads at most one window for a before-read even when the previous line is far larger than the window', async () => {
    const projects = path.join(root, 'projects');
    fs.mkdirSync(path.join(projects, 'p'), { recursive: true });
    const small = userLine('s1', 'small');
    const huge = userLine('huge', 'x'.repeat(40 * 1024));
    fs.writeFileSync(path.join(projects, 'p', `${SID_BIG}.jsonl`), small + huge + userLine('tail', 'tail'));
    const before = Buffer.byteLength(small) + Buffer.byteLength(huge);
    const WINDOW = 1024;
    const reader = new ClaudeTranscriptSource(projects, { incrementalReadMaxBytes: WINDOW });
    const app = await appWith(reader);

    const spy = vi.spyOn(fs, 'readSync');
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/sessions/${SID_BIG}/entries?before=${before}` });
    const viaAgent = sumRequestedBytes(spy);
    expect(res.statusCode).toBe(200);
    // The window is skipped as unreadable but paging can continue (hasOlder), instead of expanding up to 8 windows.
    expect(res.json()).toMatchObject({ entries: [], hasOlder: true });
    expect(viaAgent).toBeLessThanOrEqual(WINDOW);

    spy.mockClear();
    reader.readSessionBefore(SID_BIG, before);
    expect(sumRequestedBytes(spy)).toBeGreaterThan(viaAgent);
    await app.close();
  });

  it('returns the reader\'s default number of sessions when no limit is given, and never more than the cap', async () => {
    const projects = path.join(root, 'projects');
    fs.mkdirSync(path.join(projects, 'p'), { recursive: true });
    for (let i = 1; i <= 130; i++) fs.writeFileSync(path.join(projects, 'p', `${uuid(i)}.jsonl`), userLine(`u${i}`, 'hi'));
    const app = await appWith(new ClaudeTranscriptSource(projects));

    const def = await app.inject({ method: 'GET', url: '/api/transcripts/claude/sessions' });
    expect((def.json() as { sessions: unknown[] }).sessions).toHaveLength(50);
    const big = await app.inject({ method: 'GET', url: '/api/transcripts/claude/sessions?limit=500' });
    expect((big.json() as { sessions: unknown[] }).sessions).toHaveLength(100);
    await app.close();
  });

  it('metadata=1 lists without building previews and reads far less of each file than the preview listing', async () => {
    const sessions = path.join(root, 'sessions', '2026', '01', '01');
    fs.mkdirSync(sessions, { recursive: true });
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: SID, cwd: '/work/proj' } }) + '\n';
    // The first user message (the preview) only appears after a large amount of other records.
    const filler = JSON.stringify({ type: 'turn_context', payload: { pad: 'y'.repeat(200 * 1024) } }) + '\n';
    const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'late preview' }] } }) + '\n';
    fs.writeFileSync(path.join(sessions, `rollout-2026-01-01T00-00-00-${SID}.jsonl`), meta + filler + user);
    const app = await appWith(new CodexTranscriptSource(path.join(root, 'sessions')));

    const spy = vi.spyOn(fs, 'readSync');
    const full = await app.inject({ method: 'GET', url: '/api/transcripts/codex/sessions' });
    const fullBytes = sumRequestedBytes(spy);
    spy.mockClear();
    const light = await app.inject({ method: 'GET', url: '/api/transcripts/codex/sessions?metadata=1' });
    const lightBytes = sumRequestedBytes(spy);

    const lightSession = (light.json() as { sessions: { cwd: string | null; preview: string }[] }).sessions[0];
    expect(lightSession).toMatchObject({ cwd: '/work/proj', preview: '' });
    expect((full.json() as { sessions: { preview: string }[] }).sessions[0].preview).toBe('late preview');
    expect(lightBytes).toBeLessThan(fullBytes);
    await app.close();
  });
});
