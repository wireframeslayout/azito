import type { AgentBundler } from './AgentBundler';
import type { AgentInstaller } from './AgentInstaller';
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
  status: 'up_to_date' | 'updated' | 'deferred' | 'error';
  currentVersion?: string;
  message?: string;
}

export class AgentUpdater {
  constructor(
    private bundler: AgentBundler,
    private installer: AgentInstaller,
    private serverRepo: IServerRepository,
    private taskRepo: SqliteTaskRepository,
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
        await this.installer.recoverAgent(sshHost, server.host, server.agentToken, server.muxRuntime);
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
      return { name: server.name, status: 'up_to_date', currentVersion: remoteVersion };
    }

    if (this.hasRunningTasks(server.name)) {
      return {
        name: server.name,
        status: 'deferred',
        currentVersion: remoteVersion,
        message: 'Update deferred: running tasks on this server',
      };
    }

    const sshHost = this.findSshHost(server);
    if (!sshHost) {
      return { name: server.name, status: 'error', message: 'Cannot determine SSH host for update' };
    }

    const result = await this.installer.update(sshHost, server.host, server.agentToken, server.muxRuntime);
    if (result.success) {
      this.serverRepo.updateAgentVersion(server.name, result.version);
      return { name: server.name, status: 'updated', currentVersion: result.version };
    }

    return { name: server.name, status: 'error', currentVersion: remoteVersion, message: result.error };
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
