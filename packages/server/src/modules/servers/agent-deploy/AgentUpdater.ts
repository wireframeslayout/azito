import type { AgentBundler } from './AgentBundler';
import type { KeyedMutex } from '../../../shared/keyedMutex';
import type { AgentInstaller, AgentUpdateResult } from './AgentInstaller';
import type { AgentHostRecorder } from './AgentHostRecorder';
import type { IServerRepository } from '../Server';
import type { SqliteTaskRepository } from '../../tasks/SqliteTaskRepository';
import type { ServerConfig } from '../Server';

const RUNNING_STATUSES = new Set([
  'running', 'in_progress', 'phase_review', 'waiting_input',
]);

// Wait after a best-effort SSH-side `systemctl --user enable --now` before re-checking health,
// to give the agent process time to bind its port.
const RECOVER_WAIT_MS = 5000;

export interface UpdateCheckResult {
  name: string;
  status: 'up_to_date' | 'updated' | 'deferred' | 'skipped' | 'error';
  currentVersion?: string;
  message?: string;
  /** The agent's host (OS / architecture) could not be recorded after an update; the status above is unaffected. */
  hostError?: string;
}

export class AgentUpdater {
  constructor(
    private bundler: AgentBundler,
    private installer: AgentInstaller,
    private serverRepo: IServerRepository,
    private taskRepo: SqliteTaskRepository,
    private hostRecorder: AgentHostRecorder,
    /**
     * The per-server lock that installs, edits, the harness updates and `AgentRecoveryWatchdog` take: an update holds it from its
     * first command to its end, so none of them runs in the middle of it (the watchdog never sees the agent stopped for the update
     * as one that died and starts it again).
     */
    private serverLock: Pick<KeyedMutex, 'withLock'>,
    private logger: { warn(message: string): void },
  ) {}

  async checkAndUpdate(server: ServerConfig): Promise<UpdateCheckResult> {
    if (server.type !== 'agent' || !server.host || !server.agentPort || !server.agentToken) {
      return { name: server.name, status: 'up_to_date' };
    }

    let remoteVersion: string;
    try {
      remoteVersion = await this.fetchHealthVersion(server);
    } catch (err) {
      // The agent may be unreachable because an earlier update flow (transfer → stop → start)
      // was interrupted before the start step — e.g. the hub restarted (tsx watch) mid-update.
      // Best-effort recover it via SSH before giving up.
      const sshHost = this.findSshHost(server);
      if (!sshHost || !server.agentToken) {
        return { name: server.name, status: 'error', message: `Agent unreachable: ${(err as Error).message}` };
      }

      try {
        await this.installer.recoverAgent(sshHost, server.host, server.agentToken, server.hostProfile, server.muxRuntime);
      } catch {
        // Best-effort: fall through to the health re-check below, which reports the
        // appropriate error status regardless of why recovery failed.
      }
      await new Promise((resolve) => setTimeout(resolve, RECOVER_WAIT_MS));

      try {
        remoteVersion = await this.fetchHealthVersion(server);
      } catch (retryErr) {
        return {
          name: server.name,
          status: 'error',
          message: `Agent unreachable: ${(err as Error).message}; SSH 経由の復旧も失敗: ${(retryErr as Error).message}`,
        };
      }
    }

    // Compare against the local bundle's content hash, not the hub's git SHA — a commit
    // that only touches unrelated code (e.g. the frontend) leaves the agent bundle's
    // content hash unchanged, so it is not needlessly redeployed/restarted.
    let localBundleHash: string;
    try {
      await this.bundler.ensureBuild();
      localBundleHash = this.bundler.getBundleHash();
    } catch (err) {
      return {
        name: server.name,
        status: 'error',
        currentVersion: remoteVersion,
        message: `Local agent bundle unavailable: ${(err as Error).message}`,
      };
    }

    if (remoteVersion === localBundleHash) {
      return this.withHostRecorded(server, { name: server.name, status: 'up_to_date', currentVersion: remoteVersion }, false);
    }

    if (this.hasRunningTasks(server.name)) {
      return this.withHostRecorded(server, {
        name: server.name,
        status: 'deferred',
        currentVersion: remoteVersion,
        message: 'Update deferred: running tasks on this server',
      }, false);
    }

    const sshHost = this.findSshHost(server);
    if (!sshHost) {
      return { name: server.name, status: 'error', message: 'Cannot determine SSH host for update' };
    }

    // The server may have been reinstalled (a new token), edited or deleted while this waited for the lock: what is updated, with
    // which token and where, is what is registered once the lock is held, never what was read before.
    const outcome = await this.serverLock.withLock(server.name, () => this.updateRegistered(server, localBundleHash));
    if (outcome.kind === 'result') return outcome.result;
    const { fresh, update } = outcome;
    if (update.warning) this.logger.warn(`${fresh.name}: the agent was updated, but: ${update.warning}`);
    if (update.success) {
      // The new agent may be the first to know how to report its host: ask again.
      return this.withHostRecorded(fresh, { name: fresh.name, status: 'updated', currentVersion: update.version, ...(update.warning ? { message: update.warning } : {}) }, true);
    }
    this.logger.warn(`${fresh.name}: the agent update failed: ${update.error}`);
    return { name: fresh.name, status: 'error', currentVersion: remoteVersion, message: update.error };
  }

  /** Runs inside the server's lock: re-reads the server and the agent's version, and updates with what is registered now. */
  private async updateRegistered(seen: ServerConfig, localBundleHash: string): Promise<{ kind: 'result'; result: UpdateCheckResult } | { kind: 'updated'; fresh: ServerConfig; update: AgentUpdateResult }> {
    const fresh = this.serverRepo.findByName(seen.name);
    const skipped = (message: string): { kind: 'result'; result: UpdateCheckResult } => ({ kind: 'result', result: { name: seen.name, status: 'skipped', message: `Update skipped: ${message}` } });
    const changed = describeChange(seen, fresh);
    if (changed || !fresh) return skipped(changed ?? 'the server was deleted while the update waited');
    if (!fresh.host || !fresh.agentToken) return skipped('the server has no agent address or token any more');
    const sshHost = this.findSshHost(fresh);
    if (!sshHost) return skipped('the server has no SSH host any more');
    if (this.hasRunningTasks(fresh.name)) {
      return { kind: 'result', result: { name: fresh.name, status: 'deferred', message: 'Update deferred: running tasks on this server' } };
    }
    let current: string;
    try {
      current = await this.fetchHealthVersion(fresh);
    } catch (err) {
      return skipped(`the agent stopped answering while the update waited (${(err as Error).message})`);
    }
    if (current === localBundleHash) return { kind: 'result', result: { name: fresh.name, status: 'up_to_date', currentVersion: current } };
    const update = await this.installer.update(sshHost, fresh.host, fresh.agentToken, fresh.hostProfile, fresh.muxRuntime);
    if (update.success) this.serverRepo.updateAgentVersion(fresh.name, update.version);
    return { kind: 'updated', fresh, update };
  }

  /**
   * Records the agent's host (OS / architecture) now that the agent has answered, so a server registered before it was kept
   * gets one (every reach asks only while it is unrecorded; an update asks again). The version check's status is kept as it
   * is: a failure to record is reported beside it in `hostError` (the unrecorded-host read logs its own failures), and it never
   * stops an update, which has already happened.
   */
  private async withHostRecorded(server: ServerConfig, result: UpdateCheckResult, forceAsk: boolean): Promise<UpdateCheckResult> {
    try {
      await (forceAsk ? this.hostRecorder.record(server) : this.hostRecorder.recordIfUnknown(server));
      return result;
    } catch (err) {
      return { ...result, hostError: (err as Error).message };
    }
  }

  async checkAllServers(): Promise<UpdateCheckResult[]> {
    const servers = this.serverRepo.findAll().filter(s => s.type === 'agent');
    const results: UpdateCheckResult[] = [];
    for (const server of servers) {
      results.push(await this.checkAndUpdate(server));
    }
    return results;
  }

  private async fetchHealthVersion(server: ServerConfig): Promise<string> {
    const res = await fetch(`http://${server.host}:${server.agentPort}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Agent returned HTTP ${res.status}`);
    }
    const body = await res.json() as { version: string };
    return body.version;
  }

  private hasRunningTasks(serverName: string): boolean {
    return this.taskRepo.findAll().some(t => t.serverName === serverName && RUNNING_STATUSES.has(t.status));
  }

  private findSshHost(server: ServerConfig): string | null {
    if (server.sshHost) return server.sshHost;
    return null;
  }
}

/** Why an update planned from `seen` must not run against `fresh` (what is registered under the lock); undefined when nothing it depends on changed. */
function describeChange(seen: ServerConfig, fresh: ServerConfig | null): string | undefined {
  if (!fresh) return 'the server was deleted while the update waited';
  if (fresh.type !== 'agent') return 'the server is not an agent server any more';
  const same = fresh.host === seen.host && fresh.agentPort === seen.agentPort && fresh.agentToken === seen.agentToken
    && fresh.sshHost === seen.sshHost && fresh.hostProfile?.platform === seen.hostProfile?.platform && fresh.muxRuntime === seen.muxRuntime;
  return same ? undefined : 'the server was edited or reinstalled while the update waited (address, token, SSH host or OS changed); it is looked at again at the next start';
}
