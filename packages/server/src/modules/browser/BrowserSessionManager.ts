import { BrowserSession, type BrowserSessionOptions } from './BrowserSession';
import type { SqliteBrowserSnapshotRepository, BrowserTabSnapshot } from './SqliteBrowserSnapshotRepository';
import type { SqliteBrowserGroupRepository } from './SqliteBrowserGroupRepository';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export type { BrowserTabSnapshot };

function snapshotKey(serverName: string, groupId: string): string {
  return `${serverName}/${groupId}`;
}

export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();
  private pending = new Map<string, Promise<BrowserSession>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshots = new Map<string, BrowserTabSnapshot[]>();

  constructor(
    private defaultProfileBaseDir: string,
    private snapshotRepo?: SqliteBrowserSnapshotRepository,
    // Optional: the agent process (agent/main.ts) constructs this class
    // with no browser-group ownership concept at all — ownership tracking
    // is a hub-only concern (Issue #28 Phase E). Same optionality pattern
    // as `snapshotRepo` above.
    private browserGroupRepo?: SqliteBrowserGroupRepository,
  ) {}

  async getOrCreate(serverName: string, opts?: Partial<BrowserSessionOptions>): Promise<BrowserSession> {
    const existing = this.sessions.get(serverName);
    if (existing?.running) return existing;

    const inflight = this.pending.get(serverName);
    if (inflight) return inflight;

    const promise = this.launch(serverName, opts);
    this.pending.set(serverName, promise);

    try {
      return await promise;
    } finally {
      this.pending.delete(serverName);
    }
  }

  private async launch(serverName: string, opts?: Partial<BrowserSessionOptions>): Promise<BrowserSession> {
    const profileDir = `${this.defaultProfileBaseDir}/${serverName}`;
    const session = new BrowserSession({
      profileDir,
      headful: process.env.HEADFUL === '1',
      hubOrigin: opts?.hubOrigin,
    });

    await session.start();
    this.sessions.set(serverName, session);
    this.clearIdleTimer(serverName);

    // Keep the snapshot store in sync with the group's live tab list for as
    // long as it has tabs. Deliberately skipped when the list goes empty
    // (e.g. the sweeper just closed every tab in the group on TTL expiry) —
    // that would overwrite the very snapshot restoration is meant to read
    // back from. The snapshot is only cleared explicitly, by closeGroup()
    // below (an intentional close, not an expiry).
    session.onGroupTabsChanged((groupId) => {
      const tabs = session.listGroupTabs(groupId);
      if (tabs.length === 0) {
        // Issue #28 review fix 4: a group whose tabs just dropped to zero
        // through BrowserSession's OWN idle-TTL sweeper (sweepIdleGroups —
        // a non-forced close BrowserSessionManager.closeGroup() never sees,
        // so its own `browserGroupRepo.remove()` call never runs for this
        // path) still owes this hub's ownership row a cleanup — otherwise a
        // `browser_groups` row for a group nothing references anymore
        // lingers until the whole session eventually stops. Deliberately
        // does NOT touch `this.snapshots`/`snapshotRepo` here (see the
        // comment above this block) — snapshot retention and ownership
        // tracking are separate concerns; restoration must keep working
        // even after ownership is cleared.
        this.browserGroupRepo?.remove(serverName, groupId);
        return;
      }
      this.snapshots.set(snapshotKey(serverName, groupId), tabs);
      this.snapshotRepo?.saveGroup(serverName, groupId, tabs);
    });

    return session;
  }

  /** Records a keepalive receipt for the given groups of a running session (no-op if none). */
  keepalive(serverName: string, groups: string[]): void {
    const session = this.sessions.get(serverName);
    if (!session) return;
    for (const groupId of groups) session.keepaliveGroup(groupId);
  }

  /**
   * Explicit group close (e.g. a workspace browser tab was closed by the
   * user). Forced: the WS disconnect and this REST call race independently
   * from the frontend, so a positive clientCount here doesn't mean a live
   * reconnect — it must close every tab in the group regardless.
   */
  async closeGroup(serverName: string, groupId: string): Promise<void> {
    this.snapshots.delete(snapshotKey(serverName, groupId));
    this.snapshotRepo?.deleteGroup(serverName, groupId);
    const session = this.sessions.get(serverName);
    if (!session) return;
    await session.closeGroup(groupId, { force: true });
    // The group just closed may have been the session's last one; re-check
    // whether the whole session is now idle.
    this.checkIdle(serverName);
  }

  getSnapshot(serverName: string, groupId: string): BrowserTabSnapshot[] | undefined {
    return this.snapshots.get(snapshotKey(serverName, groupId));
  }

  /**
   * Recreates a group's tabs from its last-known snapshot when it currently
   * has none (e.g. the group's tabs were closed by TTL expiry, but the
   * workspace tab is still open and the user came back to it). No-op if the
   * group already has live tabs, or there is no snapshot to restore from.
   */
  async restoreGroupIfEmpty(session: BrowserSession, serverName: string, groupId: string): Promise<void> {
    if (session.listGroupTabs(groupId).length > 0) return;
    const key = snapshotKey(serverName, groupId);
    let snapshot = this.snapshots.get(key);
    if (!snapshot || snapshot.length === 0) {
      const fromDb = this.snapshotRepo?.loadGroup(serverName, groupId);
      if (fromDb && fromDb.length > 0) {
        snapshot = fromDb;
        this.snapshots.set(key, fromDb);
      }
    }
    if (!snapshot || snapshot.length === 0) return;
    for (const { tabId, url } of snapshot) {
      const page = await session.getOrCreatePage(groupId, tabId);
      if (url) {
        await page.dispatchInput({ type: 'navigate', url }).catch(() => {});
      }
    }
  }

  async stop(serverName: string): Promise<void> {
    this.clearIdleTimer(serverName);
    const session = this.sessions.get(serverName);
    if (session) {
      await session.stop();
      this.sessions.delete(serverName);
    }
    // Issue #28 review fix 4: a whole-session stop (explicit `POST
    // /api/browser/stop` or the idle session timeout below) destroys every
    // group that session held, so every `browser_groups` ownership row
    // scoped to this server is stale the instant this completes. Always
    // run — not just when `session` was found above — so a `stop()` call
    // that races after the session already tore itself down still clears
    // any row a slower-to-land `open` left behind.
    this.browserGroupRepo?.removeAllForServer(serverName);
  }

  getStatus(serverName: string): { running: boolean; clientCount: number; pages: { id: string; group: string; clientCount: number; url: string | null }[] } {
    const session = this.sessions.get(serverName);
    return {
      running: session?.running ?? false,
      clientCount: session?.totalClientCount ?? 0,
      pages: session?.pages() ?? [],
    };
  }

  checkIdle(serverName: string): void {
    const session = this.sessions.get(serverName);
    if (!session || session.totalClientCount > 0) {
      this.clearIdleTimer(serverName);
      return;
    }
    if (this.idleTimers.has(serverName)) return;
    this.idleTimers.set(serverName, setTimeout(() => {
      this.stop(serverName).catch(() => {});
    }, IDLE_TIMEOUT_MS));
  }

  private clearIdleTimer(serverName: string): void {
    const timer = this.idleTimers.get(serverName);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(serverName);
    }
  }

  async stopAll(): Promise<void> {
    for (const [name] of this.sessions) {
      await this.stop(name).catch(() => {});
    }
  }
}
