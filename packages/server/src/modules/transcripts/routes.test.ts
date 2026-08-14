import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import transcriptsRoutes from './routes';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { TranscriptPaneService } from './TranscriptPaneService';
import type { WindowSessionResolver } from './WindowSessionResolver';
import type { WindowInputService } from './WindowInputService';
import type { IWindowRepository, Window } from '../windows/Window';
import type { InteractionMonitor } from '../notifications/InteractionMonitor';

const SID = '11111111-1111-1111-1111-111111111111';
const PANE_ID = '%3';

function buildClaudeSource(overrides: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    agentType: 'claude',
    listSessions: () => [],
    readSession: () => ({ entries: [], nextOffset: 0, truncated: false, startOffset: 0, hasOlder: false }),
    readSessionBefore: () => ({ entries: [], prevOffset: 0, hasOlder: false }),
    getSessionCwd: () => ({ cwd: null }),
    getSessionTailState: async () => ({ state: 'unknown' as const, lastEntryTimestampMs: null }),
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
    getSessionTailState: async () => ({ state: 'unknown' as const, lastEntryTimestampMs: null }),
    ...overrides,
  } as unknown as TranscriptSource;
}

function buildApp(
  sources: TranscriptSource[] = [buildClaudeSource()],
  paneOverrides: Partial<TranscriptPaneService> = {},
  windowOverrides: {
    windowSessionResolver?: Partial<WindowSessionResolver>;
    windowRepo?: Partial<IWindowRepository>;
    windowInputService?: Partial<WindowInputService>;
    interactionMonitor?: Partial<InteractionMonitor>;
  } = {},
) {
  const transcriptPaneService = {
    listPaneCandidates: async () => ({ cwd: null, panes: [] }),
    sendInput: async () => 'ok' as const,
    sendSignal: async () => 'ok' as const,
    ...paneOverrides,
  } as unknown as TranscriptPaneService;

  const windowSessionResolver = {
    resolve: async () => ({ resolved: false, reason: 'unsupported_server' as const }),
    ...windowOverrides.windowSessionResolver,
  } as unknown as WindowSessionResolver;

  const windowRepo = {
    findById: () => undefined,
    ...windowOverrides.windowRepo,
  } as unknown as IWindowRepository;

  const windowInputService = {
    sendInput: async () => 'ok' as const,
    sendSignal: async () => 'ok' as const,
    ...windowOverrides.windowInputService,
  } as unknown as WindowInputService;

  const interactionMonitor = {
    isPending: () => false,
    getOpenedAt: () => undefined,
    getPendingContent: () => undefined,
    consumePendingQuestion: () => false,
    clear: () => {},
    ...windowOverrides.interactionMonitor,
  } as unknown as InteractionMonitor;

  const app = Fastify();
  app.register(transcriptsRoutes, { sources, transcriptPaneService, windowSessionResolver, windowInputService, windowRepo, interactionMonitor });
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

  it('rejects a non-positive windowId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=0` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('omits pendingInteraction when windowId is not given', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBeUndefined();
    await app.close();
  });

  it('includes pendingInteraction:true when the monitor is pending AND tailState is in_progress', async () => {
    const claude = buildClaudeSource({ getSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: null }) });
    const app = buildApp([claude], {}, { interactionMonitor: { isPending: () => true } });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBe(true);
    await app.close();
  });

  it('includes pendingQuestion alongside pendingInteraction when the pending signal carried content', async () => {
    const claude = buildClaudeSource({ getSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: null }) });
    const openedAt = Date.parse('2026-01-01T00:00:00.000Z');
    const questions = [{ question: 'どれ?', header: '選択', multiSelect: false, options: [{ label: 'はい' }, { label: 'いいえ', description: 'やめる' }] }];
    const app = buildApp([claude], {}, {
      interactionMonitor: {
        isPending: () => true,
        getOpenedAt: () => openedAt,
        getPendingContent: () => ({ toolName: 'AskUserQuestion', questions }),
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBe(true);
    expect(res.json().pendingQuestion).toEqual({ questions, openedAt });
    await app.close();
  });

  it('omits pendingQuestion when the pending signal carried no content (banner fallback)', async () => {
    const claude = buildClaudeSource({ getSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: null }) });
    const app = buildApp([claude], {}, { interactionMonitor: { isPending: () => true, getOpenedAt: () => Date.now() } });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBe(true);
    expect(res.json().pendingQuestion).toBeUndefined();
    await app.close();
  });

  it('omits pendingQuestion when tailState is terminal (same gate as pendingInteraction)', async () => {
    const claude = buildClaudeSource({ getSessionTailState: async () => ({ state: 'terminal_final' as const, lastEntryTimestampMs: null }) });
    const getPendingContent = vi.fn(() => ({ toolName: 'AskUserQuestion', questions: [{ question: 'q', multiSelect: false, options: [{ label: 'a' }] }] }));
    const app = buildApp([claude], {}, { interactionMonitor: { isPending: () => true, getOpenedAt: () => Date.now(), getPendingContent } });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBe(false);
    expect(res.json().pendingQuestion).toBeUndefined();
    expect(getPendingContent).not.toHaveBeenCalled();
    await app.close();
  });

  it('reports pendingInteraction:false when the monitor is pending but tailState is terminal_final (idle-notification noise)', async () => {
    const claude = buildClaudeSource({ getSessionTailState: async () => ({ state: 'terminal_final' as const, lastEntryTimestampMs: null }) });
    const app = buildApp([claude], {}, { interactionMonitor: { isPending: () => true } });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBe(false);
    await app.close();
  });

  it('does not read tailState when the monitor reports no pending signal (short-circuit)', async () => {
    const getSessionTailState = vi.fn(async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: null }));
    const claude = buildClaudeSource({ getSessionTailState });
    const app = buildApp([claude], {}, { interactionMonitor: { isPending: () => false } });
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBe(false);
    expect(getSessionTailState).not.toHaveBeenCalled();
    await app.close();
  });

  it('never reports pendingInteraction / never queries the monitor for a codex window (interactionSignal:"none")', async () => {
    const isPending = vi.fn(() => true);
    const getOpenedAt = vi.fn(() => Date.now());
    const clear = vi.fn();
    const getSessionTailState = vi.fn(async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: null }));
    const codex = buildCodexSource({ getSessionTailState });
    const codexWindow: Window = {
      id: 7,
      ownerType: 'project',
      projectId: 1,
      taskId: null,
      serverName: 'local',
      tmuxTarget: 'azito:agent-1',
      label: null,
      isPrimary: true,
      windowType: 'agent',
      workerType: 'codex',
      workerModel: null,
      agentSessionId: null,
      launchCommand: null,
      workingDirectory: null,
      paneLayout: null,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const app = buildApp(
      [codex],
      {},
      { windowRepo: { findById: () => codexWindow }, interactionMonitor: { isPending, getOpenedAt, clear } },
    );
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/codex/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingInteraction).toBe(false);
    expect(isPending).not.toHaveBeenCalled();
    expect(getOpenedAt).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(getSessionTailState).not.toHaveBeenCalled();
    await app.close();
  });

  it('clears the interaction monitor on an initial (offset-less) load when the last timestamped entry is newer than openedAt', async () => {
    const clear = vi.fn();
    const claude = buildClaudeSource({
      readSession: () => ({
        entries: [{ uuid: 'a', type: 'assistant', timestamp: '2026-01-01T00:00:10.000Z', blocks: [] }],
        nextOffset: 5,
        truncated: false,
        startOffset: 0,
        hasOlder: false,
      }),
    });
    const app = buildApp(
      [claude],
      {},
      { interactionMonitor: { clear, getOpenedAt: () => Date.parse('2026-01-01T00:00:00.000Z'), isPending: () => false } },
    );
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(clear).toHaveBeenCalledWith(7);
    await app.close();
  });

  it('clears the interaction monitor on an offset-based poll when the last timestamped entry is newer than openedAt', async () => {
    const clear = vi.fn();
    const claude = buildClaudeSource({
      readSession: () => ({
        entries: [{ uuid: 'a', type: 'assistant', timestamp: '2026-01-01T00:00:10.000Z', blocks: [] }],
        nextOffset: 5,
        truncated: false,
        startOffset: 0,
        hasOlder: false,
      }),
    });
    const app = buildApp(
      [claude],
      {},
      { interactionMonitor: { clear, getOpenedAt: () => Date.parse('2026-01-01T00:00:00.000Z'), isPending: () => false } },
    );
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?offset=1&windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(clear).toHaveBeenCalledWith(7);
    await app.close();
  });

  it('does not clear the interaction monitor when only entries older than openedAt are present, and pending stays true', async () => {
    const clear = vi.fn();
    const claude = buildClaudeSource({
      readSession: () => ({
        entries: [{ uuid: 'a', type: 'assistant', timestamp: '2025-12-31T23:59:00.000Z', blocks: [] }],
        nextOffset: 5,
        truncated: false,
        startOffset: 0,
        hasOlder: false,
      }),
      getSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: null }),
    });
    const app = buildApp(
      [claude],
      {},
      { interactionMonitor: { clear, getOpenedAt: () => Date.parse('2026-01-01T00:00:00.000Z'), isPending: () => true } },
    );
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(clear).not.toHaveBeenCalled();
    expect(res.json().pendingInteraction).toBe(true);
    await app.close();
  });

  it('ignores entries with a missing timestamp when deciding whether to clear (does not treat a missing timestamp as newness)', async () => {
    const clear = vi.fn();
    const claude = buildClaudeSource({
      readSession: () => ({
        entries: [{ uuid: 'a', type: 'user', timestamp: null, blocks: [] }],
        nextOffset: 5,
        truncated: false,
        startOffset: 0,
        hasOlder: false,
      }),
      getSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: null }),
    });
    const app = buildApp(
      [claude],
      {},
      { interactionMonitor: { clear, getOpenedAt: () => Date.parse('2026-01-01T00:00:00.000Z'), isPending: () => true } },
    );
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID}?windowId=7` });
    expect(res.statusCode).toBe(200);
    expect(clear).not.toHaveBeenCalled();
    expect(res.json().pendingInteraction).toBe(true);
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

describe('GET /api/transcripts/resolve-window', () => {
  const WINDOW: Window = {
    id: 42,
    ownerType: 'task',
    projectId: 1,
    taskId: 7,
    serverName: 'local',
    tmuxTarget: 'main:0',
    label: null,
    isPrimary: true,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('rejects a non-numeric windowId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window?windowId=abc' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a missing windowId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when the window does not exist', async () => {
    const app = buildApp([buildClaudeSource()], {}, { windowRepo: { findById: () => undefined } });
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window?windowId=42' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('delegates to the resolver and returns its result for an existing window', async () => {
    const resolve = async (window: Window) => {
      expect(window.id).toBe(42);
      return { resolved: true as const, agentType: 'claude', sessionId: SID, paneId: PANE_ID, agentDetected: true };
    };
    const app = buildApp(
      [buildClaudeSource()],
      {},
      { windowRepo: { findById: () => WINDOW }, windowSessionResolver: { resolve } },
    );
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window?windowId=42' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      resolved: true,
      agentType: 'claude',
      sessionId: SID,
      paneId: PANE_ID,
      agentDetected: true,
      slashCommandsVisibleInLog: true,
    });
    await app.close();
  });

  it('returns the resolver\'s unresolved result as-is when agentType is unknown (no slashCommandsVisibleInLog)', async () => {
    const app = buildApp(
      [buildClaudeSource()],
      {},
      { windowRepo: { findById: () => WINDOW }, windowSessionResolver: { resolve: async () => ({ resolved: false, reason: 'no_recent_session', agentDetected: false }) } },
    );
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window?windowId=42' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: false, reason: 'no_recent_session', agentDetected: false });
    await app.close();
  });

  it('attaches slashCommandsVisibleInLog=false for codex even when unresolved (best-effort agentType)', async () => {
    const app = buildApp(
      [buildClaudeSource()],
      {},
      {
        windowRepo: { findById: () => WINDOW },
        windowSessionResolver: {
          resolve: async () => ({ resolved: false, reason: 'no_recent_session', paneId: PANE_ID, agentType: 'codex', agentDetected: false }),
        },
      },
    );
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window?windowId=42' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agentType: 'codex', slashCommandsVisibleInLog: false });
    await app.close();
  });
});

describe('POST /api/transcripts/window-input', () => {
  const PANE_ID_WINDOW = '%5';

  it('rejects a non-numeric windowId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-input',
      payload: { windowId: 'abc', paneId: PANE_ID_WINDOW, text: 'hello' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a malformed paneId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-input',
      payload: { windowId: 42, paneId: 'not-a-pane', text: 'hello' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects empty text with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-input',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, text: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when the window is not found', async () => {
    const app = buildApp([buildClaudeSource()], {}, { windowInputService: { sendInput: async () => 'window_not_found' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-input',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, text: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 when the pane no longer exists', async () => {
    const app = buildApp([buildClaudeSource()], {}, { windowInputService: { sendInput: async () => 'pane_not_found' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-input',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, text: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('sends input and returns ok on success', async () => {
    let received: { windowId: number; paneId: string; text: string } | null = null;
    const app = buildApp(
      [buildClaudeSource()],
      {},
      {
        windowInputService: {
          sendInput: async (windowId: number, paneId: string, text: string) => {
            received = { windowId, paneId, text };
            return 'ok';
          },
        },
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-input',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, text: 'echo hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(received).toEqual({ windowId: 42, paneId: PANE_ID_WINDOW, text: 'echo hello' });
    await app.close();
  });
});

describe('POST /api/transcripts/window-signal', () => {
  const PANE_ID_WINDOW = '%5';

  it('rejects a non-numeric windowId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 'abc', paneId: PANE_ID_WINDOW, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a malformed paneId with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: 'not-a-pane', action: 'interrupt' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an invalid action with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects action:"key" with an invalid key value with 400', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'key', key: 'Enter' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when the window is not found', async () => {
    const app = buildApp([buildClaudeSource()], {}, { windowInputService: { sendSignal: async () => 'window_not_found' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it.each([['0'], ['10'], ['Enter'], [1], [undefined]])('rejects action:"answer" with key %p with 400, without consuming the pending question', async (key) => {
    const consumePendingQuestion = vi.fn(() => true);
    const sendSignal = vi.fn(async () => 'ok' as const);
    const app = buildApp([buildClaudeSource()], {}, { windowInputService: { sendSignal }, interactionMonitor: { consumePendingQuestion } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'answer', key },
    });
    expect(res.statusCode).toBe(400);
    expect(consumePendingQuestion).not.toHaveBeenCalled();
    expect(sendSignal).not.toHaveBeenCalled();
    await app.close();
  });

  it('sends the digit as a key signal and consumes the pending question on action:"answer"', async () => {
    const consumePendingQuestion = vi.fn(() => true);
    const sendSignal = vi.fn(async () => 'ok' as const);
    const app = buildApp([buildClaudeSource()], {}, { windowInputService: { sendSignal }, interactionMonitor: { consumePendingQuestion } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'answer', key: '3' },
    });
    expect(res.statusCode).toBe(200);
    expect(consumePendingQuestion).toHaveBeenCalledWith(42);
    expect(sendSignal).toHaveBeenCalledWith(42, PANE_ID_WINDOW, 'key', '3');
    await app.close();
  });

  it('returns 409 without sending anything when no pending question is left to answer', async () => {
    const sendSignal = vi.fn(async () => 'ok' as const);
    const app = buildApp([buildClaudeSource()], {}, { windowInputService: { sendSignal }, interactionMonitor: { consumePendingQuestion: () => false } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'answer', key: '1' },
    });
    expect(res.statusCode).toBe(409);
    expect(sendSignal).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 404 when the pane no longer exists', async () => {
    const app = buildApp([buildClaudeSource()], {}, { windowInputService: { sendSignal: async () => 'pane_not_found' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('sends action:"interrupt" without a key and returns ok (interruptKey resolved server-side)', async () => {
    let received: { windowId: number; paneId: string; action: string; key: unknown } | null = null;
    const app = buildApp(
      [buildClaudeSource()],
      {},
      {
        windowInputService: {
          sendSignal: async (windowId: number, paneId: string, action: 'interrupt' | 'key', key?: unknown) => {
            received = { windowId, paneId, action, key };
            return 'ok';
          },
        },
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'interrupt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(received).toEqual({ windowId: 42, paneId: PANE_ID_WINDOW, action: 'interrupt', key: undefined });
    await app.close();
  });

  it('sends the given key for action:"key" and returns ok', async () => {
    let receivedKey: unknown = null;
    const app = buildApp(
      [buildClaudeSource()],
      {},
      {
        windowInputService: {
          sendSignal: async (_windowId: number, _paneId: string, _action: 'interrupt' | 'key', key?: unknown) => {
            receivedKey = key;
            return 'ok';
          },
        },
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/window-signal',
      payload: { windowId: 42, paneId: PANE_ID_WINDOW, action: 'key', key: 'C-c' },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedKey).toBe('C-c');
    await app.close();
  });
});
