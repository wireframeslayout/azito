import type { MuxRef, PaneHandle, PaneOrdinal } from '@azito/shared';
import { asPaneHandle } from '@azito/shared';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IWindowRepository } from '../windows/Window';
import type { IServerRepository } from '../servers/Server';

export interface ResolvedWindow {
  windowId: number;
  ref: MuxRef;
  ordinal: PaneOrdinal;
  tmuxTarget: string;
}

interface CacheEntry {
  result: ResolvedWindow | null;
  expiresAt: number;
}

const POSITIVE_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 5_000;

function cacheKey(serverName: string, handle: string): string {
  return `${serverName}::${handle}`;
}

export class PaneHandleResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private muxDriverRegistry: MuxDriverRegistry,
    private windowRepo: IWindowRepository,
    private serverRepo: IServerRepository,
  ) {}

  async resolveWindowByPaneHandle(serverName: string, handle: PaneHandle): Promise<ResolvedWindow | null> {
    const key = cacheKey(serverName, handle);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.result;

    const server = this.serverRepo.findByName(serverName);
    if (!server) {
      this.cache.set(key, { result: null, expiresAt: now + NEGATIVE_TTL_MS });
      return null;
    }

    const driver = this.muxDriverRegistry.resolve(server);
    const paneResult = await driver.refFromPaneHandle(server, handle);
    if (!paneResult) {
      this.cache.set(key, { result: null, expiresAt: now + NEGATIVE_TTL_MS });
      return null;
    }

    const win = this.windowRepo.findByServerAndRef(serverName, paneResult.ref);
    if (!win) {
      this.cache.set(key, { result: null, expiresAt: now + NEGATIVE_TTL_MS });
      return null;
    }

    const result: ResolvedWindow = {
      windowId: win.id,
      ref: paneResult.ref,
      ordinal: paneResult.ordinal,
      tmuxTarget: win.tmuxTarget,
    };
    this.cache.set(key, { result, expiresAt: now + POSITIVE_TTL_MS });
    return result;
  }

  getCached(serverName: string, handle: PaneHandle): ResolvedWindow | null | undefined {
    const key = cacheKey(serverName, handle);
    const cached = this.cache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) return undefined;
    return cached.result;
  }

  warm(serverName: string, muxPaneRef: string): void {
    const handle = asPaneHandle(muxPaneRef);
    this.resolveWindowByPaneHandle(serverName, handle).catch((err) => {
      console.warn('[PaneHandleResolver] warm failed for %s::%s: %s', serverName, muxPaneRef, (err as Error).message);
    });
  }

  invalidate(serverName: string): void {
    const prefix = `${serverName}::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clearServer(serverName: string): void {
    this.invalidate(serverName);
  }
}
