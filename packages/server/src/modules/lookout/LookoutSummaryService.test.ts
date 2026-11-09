import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadlessCliError } from '../llm/headlessExec';
import type { TranscriptEntry } from '../transcripts/sources/TranscriptSource';
import { LookoutSummaryService } from './LookoutSummaryService';
import { buildLookoutPrompt, normalizeLookoutSummary } from './lookoutPrompt';

const settings = { enabled: true, provider: 'claude', model: 'test', updatedAt: '' } as const;
const entry = { uuid: '1', type: 'user', timestamp: null, blocks: [{ kind: 'text', text: 'hello' }] } as const;
function setup(run: () => Promise<string>, readEntries: () => unknown[] = () => [entry]) {
  const repo = { get: () => settings };
  const windows = { findById: (id: number) => ({ id, serverName: 'local' }) };
  const servers = { findByName: () => ({ name: 'local' }) };
  const resolver = { resolve: async () => ({ resolved: true, sessionId: 'session', agentType: 'claude' }) };
  const source = { agentType: 'claude', readSession: async () => ({ entries: readEntries(), startOffset: 0, hasOlder: false }) };
  return new LookoutSummaryService(repo as never, windows as never, servers as never, resolver as never, { forServer: () => [source] } as never, run);
}
const request = [{ windowId: 1, state: 'working' as const }];

afterEach(() => vi.useRealTimers());
describe('Lookout summaries', () => {
  it('limits input and normalizes output', () => {
    const prompt = buildLookoutPrompt([entry as never]);
    expect(prompt).toContain('<conversation_tail>\nuser: hello\n</conversation_tail>');
    expect(normalizeLookoutSummary('one\ntwo\u0000' + 'x'.repeat(100))).toHaveLength(80);
  });
  it('deduplicates the same request and caches the result', async () => {
    let finish!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const service = setup(run);
    expect((await service.getSummaries(request))[0].status).toBe('pending');
    expect((await service.getSummaries(request))[0].status).toBe('pending');
    expect(run).toHaveBeenCalledTimes(1);
    finish('done');
    await vi.waitFor(async () => expect((await service.getSummaries(request))[0]).toMatchObject({ status: 'ready', text: 'done' }));
  });
  it('does not retry failures on each poll', async () => {
    const run = vi.fn(async () => { throw new Error('failure'); });
    const service = setup(run);
    await service.getSummaries(request);
    await vi.waitFor(async () => expect((await service.getSummaries(request))[0].status).toBe('unavailable'));
    await service.getSummaries(request);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('invalidates running results when settings change', async () => {
    let finish!: (value: string) => void;
    const service = setup(() => new Promise<string>((resolve) => { finish = resolve; }));
    await service.getSummaries(request);
    service.invalidate();
    finish('obsolete');
    await Promise.resolve();
    expect((await service.getSummaries(request))[0].status).toBe('pending');
  });
  it('limits simultaneous executions to two', async () => {
    const releases: Array<(value: string) => void> = [];
    const run = vi.fn(() => new Promise<string>((resolve) => { releases.push(resolve); }));
    const service = setup(run);
    await service.getSummaries([1, 2, 3].map((windowId) => ({ windowId, state: 'working' as const })));
    expect(run).toHaveBeenCalledTimes(2);
    releases[0]('first');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    releases[1]('second'); releases[2]('third');
  });
  it('waits at least 30 seconds between starts for one window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const run = vi.fn(async () => 'done');
    const service = setup(run);
    await service.getSummaries(request);
    await vi.advanceTimersByTimeAsync(0);
    await service.getSummaries([{ windowId: 1, state: 'blocked' }]);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    await service.getSummaries([{ windowId: 1, state: 'blocked' }]);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await service.getSummaries([{ windowId: 1, state: 'blocked' }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a window that cannot be resolved as failed without failing the others', async () => {
    const service = setup(async () => 'done');
    const resolver = (service as unknown as { resolver: { resolve: (window: { id: number }) => Promise<unknown> } }).resolver;
    const resolve = resolver.resolve;
    resolver.resolve = async (window) => { if (window.id === 2) throw new Error('mux down'); return resolve(window); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await service.getSummaries([{ windowId: 1, state: 'working' }, { windowId: 2, state: 'working' }]);
    expect(results[0].status).toBe('pending');
    expect(results[1]).toEqual({ windowId: 2, status: 'unavailable', reason: 'failed' });
    warn.mockRestore();
  });

  it('returns the classified failure without exposing process output', async () => {
    const service = setup(async () => { throw new HeadlessCliError('not_logged_in'); });
    await service.getSummaries(request);
    await vi.waitFor(async () => expect((await service.getSummaries(request))[0]).toEqual({ windowId: 1, status: 'unavailable', reason: 'not_logged_in' }));
  });

  it('keeps showing the last summary of a conversation that moved on while it was being made', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let entries: TranscriptEntry[] = [entry as unknown as TranscriptEntry];
    const finishes: Array<(value: string) => void> = [];
    const run = vi.fn(() => new Promise<string>((resolve) => { finishes.push(resolve); }));
    const service = setup(run, () => entries);
    await service.getSummaries(request);
    entries = [entry as unknown as TranscriptEntry, { ...entry, uuid: '2', blocks: [{ kind: 'text', text: 'more' }] }];
    expect((await service.getSummaries(request))[0]).toEqual({ windowId: 1, status: 'pending' });
    finishes[0]('first summary');
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.getSummaries(request))[0]).toEqual({ windowId: 1, status: 'pending', text: 'first summary' });
    expect((await service.getSummaries([{ windowId: 1, state: 'blocked' }]))[0]).toEqual({ windowId: 1, status: 'pending' });
    await vi.advanceTimersByTimeAsync(30_000);
    await service.getSummaries(request);
    expect(run).toHaveBeenCalledTimes(2);
    finishes[1]('second summary');
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.getSummaries(request))[0]).toEqual({ windowId: 1, status: 'ready', text: 'second summary' });
  });
});
