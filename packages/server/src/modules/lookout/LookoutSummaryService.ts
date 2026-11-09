import { HeadlessCliError, type CliFailureReason } from '../llm/headlessExec';
import { AgentUnreachableError } from '../servers/transport/AgentUnreachableError';
import { TranscriptAgentBadResponseError, TranscriptAgentOutdatedError } from '../transcripts/sources/AgentTranscriptSource';
import { createHash } from 'crypto';
import type { IWindowRepository } from '../windows/Window';
import type { IServerRepository } from '../servers/Server';
import type { WindowSessionResolver } from '../transcripts/WindowSessionResolver';
import type { TranscriptSourceProvider } from '../transcripts/sources/TranscriptSourceProvider';
import { configDirForSession } from '../transcripts/windowConfigDir';
import { buildLookoutPrompt, normalizeLookoutSummary } from './lookoutPrompt';
import { runLookoutLlm } from './LlmClientFactory';
import type { SqliteLookoutSettingsRepository, LookoutSettings } from './SqliteLookoutSettingsRepository';

export type LookoutState = 'blocked' | 'working' | 'finished';
export interface SummaryRequest { windowId: number; state: LookoutState }
export interface SummaryResult { windowId: number; status: 'ready' | 'pending' | 'off' | 'unavailable' | 'none'; text?: string; reason?: CliFailureReason }
interface Cached { status: 'pending' | 'ready' | 'unavailable'; text?: string; reason?: CliFailureReason; retryAt?: number }
interface Job { key: string; base: string; windowId: number; prompt: string; settings: LookoutSettings; generation: number }

export class LookoutSummaryService {
  private readonly cache = new Map<string, Cached>();
  private readonly lastStart = new Map<number, number>();
  private readonly queue: Job[] = [];
  private readonly latest = new Map<number, string>();
  // The last summary made for a window, by `base` (window + state + session + provider + model). While a newer
  // tail of the same conversation is pending it is returned with `pending`, so a window whose log keeps moving
  // (a working agent) still shows a summary instead of a skeleton that never resolves.
  private readonly lastReady = new Map<number, { base: string; text: string }>();
  private readonly resolutions = new Map<number, { window: string; expires: number; result: Awaited<ReturnType<WindowSessionResolver['resolve']>> }>();
  private readonly activeWindows = new Set<number>();
  private generation = 0;
  private active = 0;

  constructor(private readonly settings: SqliteLookoutSettingsRepository, private readonly windows: IWindowRepository,
    private readonly servers: IServerRepository, private readonly resolver: WindowSessionResolver,
    private readonly sources: TranscriptSourceProvider, private readonly run = runLookoutLlm) {}

  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.latest.clear();
    this.lastReady.clear();
    this.resolutions.clear();
    this.queue.length = 0;
  }

  async getSummaries(requests: SummaryRequest[]): Promise<SummaryResult[]> {
    const settings = this.settings.get();
    const generation = this.generation;
    return Promise.all(requests.map((request) => this.getSummary(request, settings, generation).catch((error: unknown) => {
      // One window that cannot be read (its mux daemon down, an unreadable log) must not fail the other windows' summaries.
      console.warn(`[Lookout] summary for window ${request.windowId} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      return { windowId: request.windowId, status: 'unavailable', reason: 'failed' } satisfies SummaryResult;
    })));
  }

  private async getSummary(request: SummaryRequest, settings: LookoutSettings, generation: number): Promise<SummaryResult> {
    const none: SummaryResult = { windowId: request.windowId, status: 'none' };
    if (!settings.enabled) return { windowId: request.windowId, status: 'off' };
    const window = this.windows.findById(request.windowId);
    if (!window) return none;
    const server = this.servers.findByName(window.serverName);
    if (!server) return none;
    try {
      const windowKey = JSON.stringify(window);
      const prior = this.resolutions.get(request.windowId);
      const resolved = prior && prior.window === windowKey && prior.expires > Date.now() ? prior.result : await this.resolver.resolve(window);
      if (resolved.resolved && (!prior || prior.result !== resolved)) {
        this.resolutions.delete(request.windowId);
        this.resolutions.set(request.windowId, { window: windowKey, expires: Date.now() + 10_000, result: resolved });
        while (this.resolutions.size > 200) this.resolutions.delete(this.resolutions.keys().next().value!);
      }
      if (!resolved.resolved) return none;
      const source = this.sources.forServer(server, configDirForSession(window, resolved.sessionId))?.find((item) => item.agentType === resolved.agentType);
      if (!source) return none;
      const page = await source.readSession(resolved.sessionId);
      if (!page) return none;
      let entries = page.entries;
      let offset = page.startOffset;
      let hasOlder = page.hasOlder;
      while (entries.length < 40 && hasOlder && offset > 0) {
        const previous = await source.readSessionBefore(resolved.sessionId, offset);
        if (!previous || previous.prevOffset >= offset) break;
        entries = [...previous.entries, ...entries];
        offset = previous.prevOffset;
        hasOlder = previous.hasOlder;
      }
      const prompt = buildLookoutPrompt(entries);
      if (!prompt) return none;
      const base = JSON.stringify([request.windowId, request.state, resolved.sessionId, settings.provider, settings.model]);
      const key = createHash('sha256').update(JSON.stringify([base, entries.at(-1)?.timestamp, prompt])).digest('hex');
      if (generation !== this.generation) return { windowId: request.windowId, status: 'pending' };
      return this.getCached(request.windowId, key, base, prompt, settings);
    } catch (error) {
      if (error instanceof AgentUnreachableError || error instanceof TranscriptAgentBadResponseError || error instanceof TranscriptAgentOutdatedError) return none;
      throw error;
    }
  }

  private getCached(windowId: number, key: string, base: string, prompt: string, settings: LookoutSettings): SummaryResult {
    this.latest.set(windowId, key);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].windowId === windowId && this.queue[i].key !== key) {
        this.cache.delete(this.queue[i].key);
        this.queue.splice(i, 1);
      }
    }
    const cached = this.cache.get(key);
    if (cached && !(cached.status === 'unavailable' && Date.now() >= (cached.retryAt ?? 0))) {
      this.cache.delete(key); this.cache.set(key, cached);
      if (cached.status === 'pending') this.drain();
      if (cached.status === 'pending') return this.pendingResult(windowId, base);
      return { windowId, status: cached.status, ...(cached.text ? { text: cached.text } : {}), ...(cached.reason ? { reason: cached.reason } : {}) };
    }
    this.cache.set(key, { status: 'pending' });
    while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    this.queue.push({ key, base, windowId, prompt, settings, generation: this.generation });
    this.drain();
    return this.pendingResult(windowId, base);
  }

  private pendingResult(windowId: number, base: string): SummaryResult {
    const previous = this.lastReady.get(windowId);
    return previous?.base === base ? { windowId, status: 'pending', text: previous.text } : { windowId, status: 'pending' };
  }

  private drain(): void {
    while (this.active < 2) {
      const index = this.queue.findIndex((job) => !this.activeWindows.has(job.windowId) && Date.now() - (this.lastStart.get(job.windowId) ?? 0) >= 30_000);
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (!this.cache.has(job.key) || job.generation !== this.generation) continue;
      this.active++; this.activeWindows.add(job.windowId); this.lastStart.delete(job.windowId); this.lastStart.set(job.windowId, Date.now());
      while (this.lastStart.size > 200) this.lastStart.delete(this.lastStart.keys().next().value!);
      void this.run(job.settings, job.prompt).then((output) => {
        const summary = normalizeLookoutSummary(output);
        if (!summary) throw new Error('empty_summary');
        if (job.generation === this.generation) {
          this.lastReady.delete(job.windowId);
          this.lastReady.set(job.windowId, { base: job.base, text: summary });
          while (this.lastReady.size > 200) this.lastReady.delete(this.lastReady.keys().next().value!);
        }
        if (job.generation === this.generation && this.latest.get(job.windowId) === job.key && this.cache.has(job.key)) this.cache.set(job.key, { status: 'ready', text: summary });
      }).catch((error: unknown) => {
        if (job.generation === this.generation && this.latest.get(job.windowId) === job.key && this.cache.has(job.key)) this.cache.set(job.key, { status: 'unavailable', reason: error instanceof HeadlessCliError ? error.reason : 'failed', retryAt: Date.now() + 30_000 });
      }).finally(() => {
        if (job.generation === this.generation && this.latest.get(job.windowId) !== job.key && this.cache.get(job.key)?.status === 'pending') this.cache.delete(job.key);
        this.active--; this.activeWindows.delete(job.windowId); this.drain();
      });
    }
  }
}
