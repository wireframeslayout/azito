import { chromium, type BrowserContext } from 'playwright';
import { EventEmitter } from 'node:events';
import { BrowserPage, DEFAULT_CHROME_MAJOR } from './BrowserPage';

export function buildDefaultUserAgent(): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${DEFAULT_CHROME_MAJOR}.0.0.0 Safari/537.36`;
}

// グループの「最終生存確認時刻」(groupLastSeen) からこの時間が経過し、かつ
// clientCount が 0 のままであれば、そのグループの全ページを close する。
// 生存確認は接続 open / 切断 / keepalive 受信のたびに更新されるので、workspace の
// タブバーに当該タブが存在し続ける限り（= keepalive が届き続ける限り）延長される。
const GROUP_TTL_MS = 5 * 60 * 1000;

// GROUP_TTL_MS の期限切れを検出するスイーパーの実行間隔。グループ単位のタイマーを
// 個別に張るのではなく、一定間隔で全グループを一括チェックする方式（前は clientCount
// が 0 になった時点でグループごとに 60 秒の setTimeout を張る方式だった）。
const GROUP_SWEEP_INTERVAL_MS = 60 * 1000;

export interface BrowserSessionOptions {
  profileDir: string;
  headful?: boolean;
  hubOrigin?: string;
}

function makePageKey(groupId: string, tabId: string): string {
  return `${groupId}/${tabId}`;
}

function splitPageKey(key: string): { groupId: string; tabId: string } {
  const idx = key.indexOf('/');
  if (idx < 0) return { groupId: key, tabId: key };
  return { groupId: key.slice(0, idx), tabId: key.slice(idx + 1) };
}

/**
 * One Chromium persistent context per server, shared across multiple tabs
 * (BrowserPage instances) to avoid spawning a new Chromium process per tab.
 *
 * Tabs are grouped by `groupId` (one browser window/workspace tab) and keyed
 * within a group by `tabId` (one Chromium tab inside that window). Idle
 * management operates at the group level: a background sweeper (see
 * sweepIdleGroups) periodically closes any group with no connected client AND
 * no activity (connection open/close or keepalive) for GROUP_TTL_MS, so a
 * browser window being closed — or its workspace tab simply going away —
 * reliably tears down every Chromium tab it opened (zombie prevention), while
 * a tab that's merely backgrounded (but still present in the workspace's tab
 * bar, sending keepalive) survives. Per-page `clientCount` is still tracked
 * for status display, but no longer drives closing on its own.
 */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private pageMap = new Map<string, BrowserPage>();
  private pendingPages = new Map<string, Promise<BrowserPage>>();
  private groupClientCounts = new Map<string, number>();
  private groupLastSeen = new Map<string, number>();
  private groupHoldUntil = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private emitter = new EventEmitter();
  private _running = false;
  private initialPageClaimed = false;

  constructor(private opts: BrowserSessionOptions) {}

  get running(): boolean { return this._running; }

  get pageCount(): number { return this.pageMap.size; }

  get totalClientCount(): number {
    let total = 0;
    for (const page of this.pageMap.values()) total += page.clientCount;
    return total;
  }

  pages(): { id: string; group: string; clientCount: number; url: string | null }[] {
    return Array.from(this.pageMap.entries()).map(([key, page]) => {
      const { groupId, tabId } = splitPageKey(key);
      return { id: tabId, group: groupId, clientCount: page.clientCount, url: page.lastUrl };
    });
  }

  getPage(groupId: string, tabId: string): BrowserPage | undefined {
    return this.pageMap.get(makePageKey(groupId, tabId));
  }

  listGroupTabs(groupId: string): { tabId: string; url: string | null; loading: boolean; title: string | null }[] {
    const prefix = `${groupId}/`;
    const result: { tabId: string; url: string | null; loading: boolean; title: string | null }[] = [];
    for (const [key, page] of this.pageMap.entries()) {
      if (!key.startsWith(prefix)) continue;
      result.push({ tabId: key.slice(prefix.length), url: page.lastUrl, loading: page.loading, title: page.title });
    }
    return result;
  }

  onGroupTabsChanged(listener: (groupId: string) => void): () => void {
    this.emitter.on('group-tabs-changed', listener);
    return () => { this.emitter.off('group-tabs-changed', listener); };
  }

  async start(): Promise<void> {
    if (this._running) return;

    const viewport = { width: 1024, height: 720 };
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
      '--ignore-certificate-errors',
    ];
    if (this.opts.hubOrigin) {
      args.push(`--remote-allow-origins=${this.opts.hubOrigin}`);
    }

    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: !this.opts.headful,
      viewport,
      args,
      userAgent: process.env.AZITO_BROWSER_UA || buildDefaultUserAgent(),
      ignoreHTTPSErrors: true,
      ignoreDefaultArgs: ['--enable-automation'],
      // playwright の自前 SIGTERM/SIGINT/SIGHUP ハンドラを無効化し、シャットダウン制御をアプリ側（agent/main.ts, main.ts の graceful shutdown）に一元化する
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
    });

    this._running = true;

    // unref() lets the Node process exit on shutdown even if this interval is
    // still pending — it's purely a background sweep, not something that
    // should keep the event loop alive.
    this.sweepTimer = setInterval(() => this.sweepIdleGroups(), GROUP_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.groupClientCounts.clear();
    this.groupLastSeen.clear();
    this.groupHoldUntil.clear();

    for (const page of this.pageMap.values()) {
      await page.close().catch(() => {});
    }
    this.pageMap.clear();
    this.initialPageClaimed = false;

    if (this.context) {
      try { await this.context.close(); } catch { /* ignore */ }
      this.context = null;
    }
  }

  async getOrCreatePage(groupId: string, tabId: string): Promise<BrowserPage> {
    const key = makePageKey(groupId, tabId);
    const existing = this.pageMap.get(key);
    if (existing) return existing;

    const inflight = this.pendingPages.get(key);
    if (inflight) return inflight;

    const promise = this.createPage(groupId, tabId, key);
    this.pendingPages.set(key, promise);

    try {
      return await promise;
    } finally {
      this.pendingPages.delete(key);
    }
  }

  private async createPage(groupId: string, tabId: string, key: string): Promise<BrowserPage> {
    if (!this.context) throw new Error('BrowserSession not started');

    // The first page ever requested reuses the persistent context's initial
    // page (launchPersistentContext always opens one); subsequent pages open
    // a fresh tab. The claim on initialPageClaimed must happen synchronously,
    // before any `await`, so two concurrent createPage calls (distinct
    // keys racing in the same microtask) can't both observe "unclaimed"
    // and grab the same underlying page.
    const existingPages = this.context.pages();
    const useInitial = !this.initialPageClaimed && existingPages.length > 0;
    if (useInitial) this.initialPageClaimed = true;
    const rawPage = useInitial
      ? existingPages[0]
      : await this.context.newPage();

    const page = new BrowserPage(rawPage);
    await page.start();
    this.pageMap.set(key, page);
    // Re-broadcast the group's tab list on every navigation so tab strip
    // labels (derived from each tab's URL) stay in sync — including for
    // viewers currently looking at a *different* tab in the same group.
    // No manual unsubscribe is needed: BrowserPage.close() clears the
    // page's own emitter, which drops this listener along with it.
    page.onUrl(() => {
      this.emitter.emit('group-tabs-changed', groupId);
    });
    // Same rationale as onUrl above: re-broadcast the group's tab list on
    // every loading-state change so background tabs' spinner indicators stay
    // in sync for viewers currently looking at a different tab.
    page.onLoading(() => {
      this.emitter.emit('group-tabs-changed', groupId);
    });
    // Same rationale as onUrl above: re-broadcast so tab labels (now
    // title-first, falling back to URL) stay in sync once the page title
    // becomes known/changes.
    page.onTitle(() => {
      this.emitter.emit('group-tabs-changed', groupId);
    });
    // A page can be created ahead of any client connection (e.g. snapshot
    // restoration on reconnect) — record it as "seen now" so the sweeper
    // doesn't treat it as already-expired before a client has had a chance
    // to send its first keepalive.
    this.groupLastSeen.set(groupId, Date.now());
    this.emitter.emit('group-tabs-changed', groupId);
    return page;
  }

  async closePage(groupId: string, tabId: string): Promise<void> {
    const key = makePageKey(groupId, tabId);
    const page = this.pageMap.get(key);
    if (page) {
      // Remove from the map synchronously, before awaiting page.close(), so a
      // getOrCreatePage(groupId, tabId) that races in while the close is
      // still in flight creates a fresh page instead of returning the one
      // being torn down.
      this.pageMap.delete(key);
      await page.close().catch(() => {});
      this.emitter.emit('group-tabs-changed', groupId);
    }
  }

  incrementGroupClient(groupId: string): void {
    this.groupClientCounts.set(groupId, (this.groupClientCounts.get(groupId) ?? 0) + 1);
    this.touchGroupLastSeen(groupId);
  }

  decrementGroupClient(groupId: string): void {
    const next = Math.max(0, (this.groupClientCounts.get(groupId) ?? 0) - 1);
    this.groupClientCounts.set(groupId, next);
    this.touchGroupLastSeen(groupId);
  }

  /**
   * Called by browserHandler around a connection's lifecycle (before the
   * page is ready, and on disconnect). With the sweeper replacing per-group
   * timers, this no longer schedules anything — it just records "seen now"
   * for a group that already has state (a no-op for a group with none, e.g.
   * a connection that closed before ever creating a page).
   */
  checkGroupIdle(groupId: string): void {
    this.touchGroupLastSeen(groupId);
  }

  setGroupHold(groupId: string, untilMs: number): void {
    this.groupHoldUntil.set(groupId, untilMs);
  }

  /** Explicit keepalive receipt (workspace tab still open) — extends the TTL. */
  keepaliveGroup(groupId: string): void {
    this.touchGroupLastSeen(groupId);
  }

  private touchGroupLastSeen(groupId: string): void {
    if (!this.hasGroup(groupId)) return;
    this.groupLastSeen.set(groupId, Date.now());
  }

  private hasGroup(groupId: string): boolean {
    if (this.groupClientCounts.has(groupId)) return true;
    const prefix = `${groupId}/`;
    for (const key of this.pageMap.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Runs on GROUP_SWEEP_INTERVAL_MS. Closes any group that has had no
   * connected client AND no keepalive/connection activity (groupLastSeen)
   * for GROUP_TTL_MS. Replaces the previous per-group "clientCount 0 -> 60s
   * timer" scheme so a group survives brief tab-switches within the
   * workspace (which keep sending keepalive) instead of closing the moment
   * its last viewer navigates away.
   */
  private sweepIdleGroups(): void {
    const now = Date.now();
    const groupIds = new Set<string>(this.groupClientCounts.keys());
    for (const key of this.pageMap.keys()) groupIds.add(splitPageKey(key).groupId);

    for (const groupId of groupIds) {
      const count = this.groupClientCounts.get(groupId) ?? 0;
      if (count > 0) continue;
      const holdUntil = this.groupHoldUntil.get(groupId) ?? 0;
      if (holdUntil > now) continue;
      if (holdUntil > 0) this.groupHoldUntil.delete(groupId);
      const lastSeen = this.groupLastSeen.get(groupId) ?? 0;
      if (now - lastSeen < GROUP_TTL_MS) continue;
      this.closeGroup(groupId).catch(() => {});
    }
  }

  /**
   * @param opts.force When true (an explicit close — the user closed the
   * workspace browser tab, routed through BrowserSessionManager.closeGroup),
   * closes every page in the group unconditionally, ignoring clientCount:
   * the frontend sends its WS close and its close-group REST call
   * independently, so a positive clientCount here may just mean the WS
   * close hasn't landed yet, not a live reconnect. Skipping the reconnect
   * guard in that case previously left later tabs (e.g. t2) stranded open
   * whenever close-group happened to arrive first.
   * When false (the TTL sweeper's own call), the reconnect-abort guard stays
   * in place — a client legitimately reconnecting mid-sweep must not have
   * its pages torn down.
   * The stale-instance guard (comparing the live page against the
   * snapshotted one) always applies, force or not: it's just correctness
   * against a concurrent closePage/reconnect racing on the same key, not
   * part of the reconnect-abort policy this flag controls.
   */
  async closeGroup(groupId: string, opts?: { force?: boolean }): Promise<void> {
    const force = opts?.force ?? false;
    const prefix = `${groupId}/`;
    // Snapshot both the keys *and* the page instances up front: a reconnect
    // racing in between two `await page.close()` calls below can create a
    // brand-new BrowserPage for a key we haven't processed yet (or even
    // reuse the one we're about to process). Comparing against the
    // snapshotted instance — not just the key — ensures we only ever close
    // the exact pages that were live when the idle timer fired.
    const snapshot = Array.from(this.pageMap.entries()).filter(([key]) => key.startsWith(prefix));
    let closedAny = false;
    for (const [key, page] of snapshot) {
      // The page at this key may have already been removed (closed via a
      // concurrent closePage) or replaced (closed-then-recreated via a
      // reconnect) since the snapshot was taken; only close the instance we
      // actually captured.
      if (this.pageMap.get(key) !== page) continue;
      this.pageMap.delete(key);
      await page.close().catch(() => {});
      closedAny = true;
      if (force) continue;
      // A client may have reconnected to this group while the close above
      // was in flight. If so, stop closing further tabs — they belong to a
      // group that is active again — rather than tearing down pages the
      // reconnect may already be using. Only applies to the non-forced
      // (TTL sweeper) path — an explicit close must close everything.
      if ((this.groupClientCounts.get(groupId) ?? 0) > 0) break;
    }
    // Only clear the client-count entry if it's still at zero (or this is a
    // forced/explicit close, which clears it unconditionally): a reconnect
    // that raced in during the loop above must not have its positive count
    // silently discarded on the non-forced path.
    if (force || (this.groupClientCounts.get(groupId) ?? 0) === 0) {
      this.groupClientCounts.delete(groupId);
      this.groupLastSeen.delete(groupId);
      this.groupHoldUntil.delete(groupId);
    }
    if (closedAny) this.emitter.emit('group-tabs-changed', groupId);
  }
}
