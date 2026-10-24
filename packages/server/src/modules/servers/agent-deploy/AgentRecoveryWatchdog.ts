import type { ServerConfig } from '../Server';
import type { KeyedMutex } from '../../../shared/keyedMutex';

/** How the watchdog sees the world: everything it touches comes in here, so that it can be driven by a clock in a test. */
export interface AgentRecoveryDeps {
  /** The registered servers (re-read on every look, so an edit or a deletion is seen). */
  listServers(): ServerConfig[];
  /** Resolves when the agent answers `/health`; rejects when it cannot be reached (the circuit breaker being open is such a case). */
  checkAgent(server: ServerConfig): Promise<void>;
  /** Starts the agent again (`recoverAgent`: `/Query`, `/End`, `/Run` of its task). Resolves with what it did; `disabled` is a task disabled by hand, which is left alone. */
  recoverAgent(server: ServerConfig): Promise<string>;
  /** Asks the (reachable) agent whether the managed misao it hosts is installed by AZITO and does not answer. Rejects when the agent cannot say (an older one). */
  isMisaoDown(server: ServerConfig): Promise<boolean>;
  /** Starts the misao task again through the agent; resolves with what it did (`started`, or why nothing was done). `force`: the task is still "running" but the daemon does not answer, so end it first. */
  reviveMisao(server: ServerConfig, force: boolean): Promise<string>;
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

/** How many servers are looked at at the same time (one waiting for a lock or an SSH timeout must not hold the others back). */
const MAX_CONCURRENT_LOOKS = 4;

/** What reviveMisao answers when nothing was done and waiting will not change it: warned once per server and answer, not on every attempt. */
const NOTHING_TO_DO_WARNED = new Set(['no_task', 'not_installed', 'other_task']);
/** Nothing to say: the daemon answers again, or someone chose this (a custom pipe, a task disabled by hand). */
const QUIET = new Set(['running', 'custom_socket', 'disabled']);

/** The waiting state of one thing being brought back (an agent, or the misao on it). */
interface Backoff {
  /** When the next attempt may be made. */
  nextAt: number;
  /** The wait that follows the next attempt. */
  waitMs: number;
  attempts: number;
  /** Which address, credentials and OS the waits were for: a server that was edited starts over. */
  identity: string;
}

/**
 * Brings back a Windows agent (and the misao it hosts) that died, for as long as the hub runs.
 *
 * Why the hub does it: the agent's logon task runs `conhost.exe --headless node.exe ...`, and conhost reports exit code 0 whatever
 * its child did, and RestartOnFailure does not fire for a non-zero exit code either (measured on Windows CI, see
 * `shared/os/taskScheduler/restartOnFailure.windows.test.ts`; a repeating trigger was tried and left out: it needs the task disabled
 * for every stop on purpose and the state of that was too easy to leave wrong). Nothing restarts them while the hub is down.
 *
 * Only Windows agents: a Unix agent is a systemd unit with `Restart=`, and the one started with nohup is still brought back only by
 * the version check at the hub's start (`AgentUpdater`).
 *
 * Each server is looked at on its own (a look still going on makes the next tick skip that server, and at most
 * `MAX_CONCURRENT_LOOKS` run at once), so one that waits for its lock does not stop the others. A failure is first waited out for
 * `baseMs` (the agent may be in the middle of an update or a restart), then an attempt is made, then the waits double up to
 * `maxMs`; the state of a server is dropped as soon as the agent answers (which resets the wait) or when it was edited to another
 * address, credentials or OS. An attempt takes the server's lock and looks again, at the server as it is THEN, before it acts: it
 * never runs in the middle of an install / update (which hold the lock), and a server that was deleted, edited or is not a Windows
 * agent any more is left alone. There is no state "stopped by the hub": no hub operation leaves a Windows agent or misao stopped
 * (they stop and start again inside the lock); one stopped by hand (`schtasks /End`) cannot be told from one that died, so it is
 * brought back too. A task disabled by hand is how to keep it stopped: it is skipped without a word.
 */
export class AgentRecoveryWatchdog {
  private readonly agents = new Map<string, Backoff>();
  private readonly misaos = new Map<string, Backoff>();
  private readonly looking = new Set<string>();
  /** The `cannot be started` answers already warned about: `<server>\0<answer>`. */
  private readonly warned = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

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

  /**
   * Starts a look at every Windows agent server that is not being looked at, and resolves when those looks are over (the timer does
   * not wait for that: the next tick starts its own).
   */
  async tick(): Promise<void> {
    const servers = this.deps.listServers().filter(isWindowsAgent);
    const names = new Set(servers.map((s) => s.name));
    for (const map of [this.agents, this.misaos]) for (const name of map.keys()) if (!names.has(name)) map.delete(name);
    for (const key of this.warned) if (!names.has(key.split('\0')[0]!)) this.warned.delete(key);
    const started: Array<Promise<void>> = [];
    for (const server of servers) {
      if (this.looking.size >= MAX_CONCURRENT_LOOKS) break;
      if (this.looking.has(server.name)) continue;
      this.looking.add(server.name);
      started.push(this.look(server)
        .catch((err: unknown) => this.deps.logger.warn(`${server.name}: looking at the server failed: ${describe(err)}`))
        .finally(() => { this.looking.delete(server.name); }));
    }
    await Promise.all(started);
  }

  private reset(name: string): void {
    this.agents.delete(name);
    this.misaos.delete(name);
    for (const key of this.warned) if (key.startsWith(`${name}\0`)) this.warned.delete(key);
  }

  private async look(server: ServerConfig): Promise<void> {
    const known = this.agents.get(server.name) ?? this.misaos.get(server.name);
    if (known !== undefined && known.identity !== identityOf(server)) this.reset(server.name);
    try {
      await this.deps.checkAgent(server);
    } catch {
      this.misaos.delete(server.name);
      await this.attempt(this.agents, server, 'agent', (s) => this.deps.recoverAgent(s), async (s) => !(await this.answers(s)));
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
      for (const key of this.warned) if (key.startsWith(`${server.name}\0`)) this.warned.delete(key);
      return;
    }
    const force = (this.misaos.get(server.name)?.attempts ?? 0) > 0;
    await this.attempt(this.misaos, server, 'misao', (s) => this.deps.reviveMisao(s, force), (s) => this.deps.isMisaoDown(s).catch(() => false));
  }

  private async answers(server: ServerConfig): Promise<boolean> {
    return this.deps.checkAgent(server).then(() => true, () => false);
  }

  /** Waits out the base interval, then tries, with doubling waits. `stillDown` and `act` get the server as it is registered under the lock. */
  private async attempt(waits: Map<string, Backoff>, server: ServerConfig, what: 'agent' | 'misao', act: (current: ServerConfig) => Promise<string>, stillDown: (current: ServerConfig) => Promise<boolean>): Promise<void> {
    const now = this.deps.now();
    const identity = identityOf(server);
    const wait = waits.get(server.name);
    if (wait === undefined) {
      waits.set(server.name, { nextAt: now + this.timing.baseMs, waitMs: this.timing.baseMs, attempts: 0, identity });
      this.deps.logger.info(`${server.name}: the ${what} does not answer; trying to bring it back in ${this.timing.baseMs / 1000}s`);
      return;
    }
    if (now < wait.nextAt) return;
    let outcome: string | undefined;
    try {
      await this.deps.lock.withLock(server.name, async () => {
        // The server may have been edited while this waited for the lock: what is acted on is what is registered now.
        const current = this.deps.listServers().find((s) => s.name === server.name);
        if (current === undefined || !isWindowsAgent(current)) return;
        if (identityOf(current) !== identity) {
          this.reset(server.name);
          return;
        }
        if (!(await stillDown(current))) return;
        outcome = await act(current);
      });
    } catch (err) {
      this.deps.logger.warn(`${server.name}: could not bring the ${what} back: ${describe(err)}`);
    }
    if (waits.get(server.name) !== wait) return; // reset while waiting for the lock
    if (outcome !== undefined) this.report(server.name, what, outcome, wait.attempts + 1);
    waits.set(server.name, { ...wait, nextAt: this.deps.now() + wait.waitMs, waitMs: Math.min(wait.waitMs * 2, this.timing.maxMs), attempts: wait.attempts + 1 });
  }

  private report(name: string, what: 'agent' | 'misao', outcome: string, attempt: number): void {
    if (QUIET.has(outcome)) return;
    if (NOTHING_TO_DO_WARNED.has(outcome)) {
      const key = `${name}\0${outcome}`;
      if (this.warned.has(key)) return;
      this.warned.add(key);
      this.deps.logger.warn(`${name}: the ${what} does not answer and cannot be started again (${outcome}); it will keep being looked at, silently, until that changes`);
      return;
    }
    this.deps.logger.info(`${name}: tried to bring the ${what} back (attempt ${attempt}): ${outcome}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a recovery depends on: where the agent is, how it is reached and what it runs on. */
function identityOf(server: ServerConfig): string {
  return JSON.stringify([server.host, server.agentPort, server.agentToken, server.sshHost, server.hostProfile?.platform, server.muxRuntime]);
}

function isWindowsAgent(server: ServerConfig): boolean {
  return server.type === 'agent' && server.hostProfile?.platform === 'win32';
}
