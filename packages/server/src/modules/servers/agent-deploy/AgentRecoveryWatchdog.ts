import type { ServerConfig } from '../Server';
import type { KeyedMutex } from '../../../shared/keyedMutex';

/** How the watchdog sees the world: everything it touches comes in here, so that it can be driven by a clock in a test. */
export interface AgentRecoveryDeps {
  /** The registered servers (re-read on every look, so an edit or a deletion is seen). */
  listServers(): ServerConfig[];
  /** Resolves when the agent answers `/health`; rejects when it cannot be reached (the circuit breaker being open is such a case). */
  checkAgent(server: ServerConfig): Promise<void>;
  /** Starts the agent again (`recoverAgent`: `/Query`, `/End`, `/Run` of its task). */
  recoverAgent(server: ServerConfig): Promise<void>;
  /** Asks the (reachable) agent whether the misao it hosts is installed by AZITO and does not answer. Rejects when the agent cannot say (an older one). */
  isMisaoDown(server: ServerConfig): Promise<boolean>;
  /** Starts the misao task again through the agent. `force`: the task is still "running" but the daemon does not answer, so end it first. */
  reviveMisao(server: ServerConfig, force: boolean): Promise<void>;
  /** The lock every install / update / edit of a server takes: a recovery never runs in the middle of one, and looks again once it has the lock. */
  lock: Pick<KeyedMutex, 'withLock'>;
  now(): number;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface AgentRecoveryTiming {
  /** How often the servers are looked at. */
  tickMs: number;
  /** How long a failure has to last before the first attempt, and the first wait after it. */
  baseMs: number;
  /** The longest wait between two attempts. */
  maxMs: number;
}

export const DEFAULT_RECOVERY_TIMING: AgentRecoveryTiming = { tickMs: 15_000, baseMs: 60_000, maxMs: 15 * 60_000 };

/** The waiting state of one thing being brought back (an agent, or the misao on it). */
interface Backoff {
  /** When the next attempt may be made. */
  nextAt: number;
  /** The wait that follows the next attempt. */
  waitMs: number;
  attempts: number;
}

/**
 * Brings back a Windows agent (and the misao it hosts) that died, for as long as the hub runs.
 *
 * Why the hub does it: the agent's logon task runs `conhost.exe --headless node.exe ...`, and conhost reports exit code 0 whatever
 * its child did, so the Task Scheduler's RestartOnFailure never fires (measured on Windows CI, see
 * `shared/os/taskScheduler/restartOnFailure.windows.test.ts`; a repeating trigger was tried and left out: it needs the task disabled
 * for every stop on purpose and the state of that was too easy to leave wrong). Nothing restarts them while the hub is down.
 *
 * Only Windows agents: a Unix agent is a systemd unit with `Restart=`, and the one started with nohup is still brought back only by
 * the version check at the hub's start (`AgentUpdater`).
 *
 * One look per server at a time (a tick that is still running makes the next one skip). A failure is first waited out for `baseMs`
 * (the agent may be in the middle of an update or a restart), then an attempt is made, then the waits double up to `maxMs`; the
 * state of a server is dropped as soon as the agent answers, which also resets the wait. An attempt takes the server's lock and
 * looks again before it acts, so it never runs in the middle of an install / update (which hold the lock) and a deleted server is
 * left alone. There is no state "stopped by the hub": no hub operation leaves a Windows agent or misao stopped (they stop and start
 * again inside the lock); one stopped by hand (`schtasks /End`) cannot be told from one that died, so it is brought back too.
 */
export class AgentRecoveryWatchdog {
  private readonly agents = new Map<string, Backoff>();
  private readonly misaos = new Map<string, Backoff>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private looking = false;

  constructor(private readonly deps: AgentRecoveryDeps, private readonly timing: AgentRecoveryTiming = DEFAULT_RECOVERY_TIMING) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.tick(); }, this.timing.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look at every Windows agent server, in turn. A look that is still going on makes this one a no-op. */
  async tick(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      const servers = this.deps.listServers().filter(isWindowsAgent);
      const names = new Set(servers.map((s) => s.name));
      for (const map of [this.agents, this.misaos]) for (const name of map.keys()) if (!names.has(name)) map.delete(name);
      for (const server of servers) await this.look(server);
    } finally {
      this.looking = false;
    }
  }

  private async look(server: ServerConfig): Promise<void> {
    try {
      await this.deps.checkAgent(server);
    } catch {
      this.misaos.delete(server.name);
      await this.attempt(this.agents, server, 'agent', async () => {
        await this.deps.recoverAgent(server);
      }, async () => !(await this.answers(server)));
      return;
    }
    this.agents.delete(server.name);
    let down: boolean;
    try {
      down = await this.deps.isMisaoDown(server);
    } catch {
      return; // the agent cannot say (older than this hub) or went away between the two calls: nothing to act on
    }
    if (!down) {
      this.misaos.delete(server.name);
      return;
    }
    const force = (this.misaos.get(server.name)?.attempts ?? 0) > 0;
    await this.attempt(this.misaos, server, 'misao', async () => {
      await this.deps.reviveMisao(server, force);
    }, async () => this.deps.isMisaoDown(server).catch(() => false));
  }

  private async answers(server: ServerConfig): Promise<boolean> {
    return this.deps.checkAgent(server).then(() => true, () => false);
  }

  /** Waits out the base interval, then tries, with doubling waits. `stillDown` is asked again under the lock. */
  private async attempt(waits: Map<string, Backoff>, server: ServerConfig, what: 'agent' | 'misao', act: () => Promise<void>, stillDown: () => Promise<boolean>): Promise<void> {
    const now = this.deps.now();
    const wait = waits.get(server.name);
    if (wait === undefined) {
      waits.set(server.name, { nextAt: now + this.timing.baseMs, waitMs: this.timing.baseMs, attempts: 0 });
      this.deps.logger.info(`${server.name}: the ${what} does not answer; trying to bring it back in ${this.timing.baseMs / 1000}s`);
      return;
    }
    if (now < wait.nextAt) return;
    try {
      await this.deps.lock.withLock(server.name, async () => {
        const current = this.deps.listServers().find((s) => s.name === server.name);
        if (current === undefined || !(await stillDown())) return;
        await act();
        this.deps.logger.info(`${server.name}: tried to bring the ${what} back (attempt ${wait.attempts + 1})`);
      });
    } catch (err) {
      this.deps.logger.warn(`${server.name}: could not bring the ${what} back: ${err instanceof Error ? err.message : String(err)}`);
    }
    waits.set(server.name, { nextAt: this.deps.now() + wait.waitMs, waitMs: Math.min(wait.waitMs * 2, this.timing.maxMs), attempts: wait.attempts + 1 });
  }
}

function isWindowsAgent(server: ServerConfig): boolean {
  return server.type === 'agent' && server.hostProfile?.platform === 'win32';
}
