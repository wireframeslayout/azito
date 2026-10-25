import * as crypto from 'crypto';
import * as fs from 'fs';
import { Readable } from 'stream';
import { Client as Ssh2Client } from 'ssh2';
import type { SshClient } from '../ssh/SshClient';
import type { AgentBundler } from './AgentBundler';
import { AgentTransport } from '../transport/AgentTransport';
import { HOST_PROBE_COMMAND, HostProfileError, parseHostProbe, type HostProfile } from '../../../shared/os/hostProfile';
import { HOST_OS_PROBE_COMMAND, parseHostOsProbe } from './hostOsProbe';
import { buildWindowsPreflightCommand, checkWindowsPreflight, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import { buildSha256VerifyCommand, buildSafeExtractCommand, readSha256FromSumsFile } from './integrityVerifier';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { CLEANUP_LOCK_DIR, CLEANUP_TIMEOUT_MS, INSTALL_ID_FILE, MANUAL_STEPS_ANY_START, SYSTEMD_MANUAL_STEPS, buildCleanupGuardScript, buildCleanupScript, buildNohupSightingScript, cleanupMarkMessage, parseCleanupGuard, nohupManualSteps, parseCleanupOutcome, parseNohupSighting, type NohupSighting } from './unixAgentCleanup';
import { WindowsAgentDeployer, windowsAgentLayout, type WindowsDeployment } from './WindowsAgentDeployer';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, type WindowsAgentOptions } from './windowsAgentConfig';
import { updateWindowsAgent, type AgentUpdateResult } from './windowsAgentUpdate';
import type { WindowsUninstallChoice, WindowsUninstallResult } from './windowsAgentUninstall';

export type InstallStep = 'preflight' | 'transfer' | 'start' | 'health' | 'misao';

export interface InstallProgress {
  step: InstallStep;
  status: 'running' | 'ok' | 'error';
  message: string;
}

/**
 * What puts misao on a freshly installed agent: the hub's own copy, through the agent (see MisaoAgentInstaller). Defined here
 * so this module does not depend on the layer that implements it.
 */
export type AgentMisaoInstallStep = 'inspect' | 'transfer' | 'prepare' | 'stop' | 'start';

const MISAO_STEP_MESSAGES: Record<AgentMisaoInstallStep, string> = {
  inspect: 'Inspecting the host...',
  transfer: 'Transferring misao...',
  prepare: 'Preparing misao...',
  stop: 'Stopping misao...',
  start: 'Starting misao...',
};

export interface AgentMisaoInstaller {
  install(transport: AgentTransport, onProgress?: (step: AgentMisaoInstallStep) => void): Promise<{ version: string; startMethod: 'systemd' | 'nohup' | 'taskscheduler' | 'running'; updateAvailable: boolean }>;
}

export type { AgentUpdateResult };

export interface InstallResult {
  success: boolean;
  host: string;
  port: number;
  token: string;
  version: string;
  /** `taskscheduler`: a Windows agent (a logon task). */
  startMethod: 'systemd' | 'nohup' | 'taskscheduler';
  steps: InstallProgress[];
  error?: string;
  /** The host has tmux (the preflight found one). A host without it can only use misao, so the server must default to it. */
  tmuxFound?: boolean;
  /** The host's OS / architecture as the preflight read it; set when the install succeeded, for the caller to store with the server. */
  hostProfile?: HostProfile;
  /**
   * Why misao could not be put on the agent. The agent itself is installed and healthy (so `success` stays true): this is
   * reported beside it, because the server has no pane server until misao is installed (tmux, if the host has it, still works).
   */
  misaoError?: string;
}

interface PreflightInfo {
  tailscaleIp: string;
  nodeVersion: string;
  hostProfile: HostProfile;
  /** Empty when the host has no tmux: not required, misao is the pane server this hub installs. */
  tmuxVersion: string;
  /** Set for a Windows host: what the preflight read, which the Windows install needs. */
  windows?: WindowsPreflightInfo;
}

const AGENT_PORT = 3002;
const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_RETRY_INTERVAL_MS = 1000;

/** Answers, in the install's first command on a Unix host, whether the mark of a cleanup is on the host (the mark outlasts the SSH call, and is removed only by the cleanup that made it or by a person) and whether the host already has an agent (its unit or its folder), before this install touches anything. */
export const AGENT_PRESENCE_COMMAND = buildCleanupGuardScript('if [ -e ~/.config/systemd/user/azito-agent.service ] || [ -e ~/.azito/agent ]; then echo AZITO_AGENT_PRESENT; else echo AZITO_AGENT_ABSENT; fi');
/** For an update or a recovery, which have no presence question: only whether a cleanup is still running. */
const CLEANUP_GUARD_COMMAND = buildCleanupGuardScript();

/** The mark of a cleanup is on the host: no install, update or recovery may start until a person has looked and removed it. */
class CleanupMarkError extends Error {}

/** The error for a host that has no tmux and no misao: the same text is the API's `error` and what the UI shows. */
function noMuxMessage(host: string, misaoError: string | undefined): string {
  return `no mux is available on ${host}: tmux is not installed and misao could not be installed (${misaoError ?? 'this hub has no misao to install'}).`;
}

export class AgentInstaller {
  /**
   * One install (or update) at a time per host, from its start to the end of its start-up / cleanup, so that no other install of this hub
   * runs between "this folder is mine" and the removal. Keyed by the SSH target, not the server name: two names can reach one host.
   * Updates and recoveries (`AgentUpdater`) take the same lock. (Another hub installing on the same host at the same time is not covered; the install id only keeps a cleanup from removing what
   * is not its own.)
   */
  private readonly hostLocks = new KeyedMutex();

  /**
   * The key two installs of one host share, whatever the spelling: the SSH target as the client resolves it (`user`, address and port,
   * so an alias of ~/.ssh/config, an omitted user and `host:22` are one). Two names for one machine (two addresses) are not recognised;
   * the install id on the host still keeps a cleanup from removing what is not its own.
   */
  private lockKey(sshHost: string): string {
    const { username, host, port } = this.sshClient.resolveHost(sshHost);
    return `${username}@${host.toLowerCase()}:${port}`;
  }

  constructor(
    private sshClient: SshClient,
    private bundler: AgentBundler,
    /** Task name, folder and port of an agent installed on a Windows host (resolved at the entry point). */
    private windowsAgent: WindowsAgentOptions,
    /** Absent for a hub that cannot install misao (no bundled copy): the agent is installed without it. */
    private misaoInstaller?: AgentMisaoInstaller,
  ) {
    // The overrides exist to try a second agent beside the real one; they are not saved per server, so a hub started without them
    // looks for the default task: say so once when they are in use.
    if (JSON.stringify(windowsAgent) !== JSON.stringify(DEFAULT_WINDOWS_AGENT_OPTIONS)) {
      console.warn(`[AgentInstaller] Windows agent settings differ from the defaults (task ${windowsAgent.taskName}, folder ~\\${windowsAgent.dir}, port ${windowsAgent.port}, misao task ${windowsAgent.misaoTaskName}, misao folder ~\\${windowsAgent.misaoDir}): this is for trials, they are not saved per server`);
    }
  }

  install(sshHost: string, onProgress?: (p: InstallProgress) => void, muxRuntime?: string): Promise<InstallResult> {
    return this.hostLocks.withLock(this.lockKey(sshHost), () => this.installLocked(sshHost, onProgress, muxRuntime));
  }

  private async installLocked(
    sshHost: string,
    onProgress?: (p: InstallProgress) => void,
    muxRuntime?: string,
  ): Promise<InstallResult> {
    const steps: InstallProgress[] = [];
    const report = (step: InstallStep, status: InstallProgress['status'], message: string) => {
      const p: InstallProgress = { step, status, message };
      steps.push(p);
      onProgress?.(p);
    };

    await this.bundler.ensureBuild();
    const version = this.bundler.getBundleHash();
    const token = crypto.randomBytes(32).toString('hex');

    // ── Preflight checks ──
    report('preflight', 'running', 'Checking remote environment...');
    let preflight: PreflightInfo;
    try {
      preflight = await this.preflight(sshHost);
      report('preflight', 'ok', `Node ${preflight.nodeVersion}, ${preflight.hostProfile.platform} ${preflight.hostProfile.arch}, ${preflight.tmuxVersion ? `tmux ${preflight.tmuxVersion}` : 'no tmux (optional)'}`);
    } catch (err) {
      const msg = err instanceof HostProfileError ? `${err.code}: ${err.message}` : (err as Error).message;
      report('preflight', 'error', msg);
      return { success: false, host: '', port: AGENT_PORT, token, version, startMethod: 'nohup', steps, error: msg };
    }

    if (preflight.windows) return this.installOnWindows(sshHost, version, token, preflight, preflight.windows, steps, report);

    // Read before anything is changed: an agent that was already here is not this install's to remove.
    let hadAgent: boolean;
    try {
      hadAgent = await this.hostHasAgent(sshHost);
    } catch (err) {
      const msg = err instanceof CleanupMarkError ? err.message : `Could not check the host for an existing agent: ${(err as Error).message}`;
      report('transfer', 'error', msg);
      return { success: false, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod: 'nohup', steps, error: msg };
    }
    const installId = crypto.randomBytes(16).toString('hex');

    // ── Transfer & deploy ──
    report('transfer', 'running', 'Transferring agent bundle...');
    try {
      await this.transferAndDeploy(sshHost, version);
      await this.writeInstallId(sshHost, installId);
      report('transfer', 'ok', 'Agent deployed');
    } catch (err) {
      const msg = (err as Error).message;
      report('transfer', 'error', msg);
      return { success: false, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod: 'nohup', steps, error: msg };
    }

    // ── Stop existing agent (if any) ──
    await this.stopAgent(sshHost);

    // ── Start agent ──
    report('start', 'running', 'Starting agent...');
    let startMethod: 'systemd' | 'nohup';
    try {
      startMethod = await this.startAgent(sshHost, preflight.tailscaleIp, token, muxRuntime);
      report('start', 'ok', `Started via ${startMethod}`);
    } catch (err) {
      const msg = (err as Error).message;
      report('start', 'error', msg);
      return { success: false, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod: 'nohup', steps, error: msg };
    }

    // ── Health check ──
    report('health', 'running', 'Verifying agent health...');
    try {
      await this.healthCheck(preflight.tailscaleIp, AGENT_PORT, version);
      report('health', 'ok', 'Agent healthy');
    } catch (err) {
      const msg = (err as Error).message;
      report('health', 'error', msg);
      return { success: false, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod, steps, error: msg };
    }
    // A nohup agent is not stopped by a cleanup (see unixAgentCleanup.ts): what it looked like now goes into the error if it has to be stopped by hand.
    const nohupSighting = startMethod === 'nohup' ? await this.sightNohupAgent(sshHost) : undefined;

    // ── misao ──
    const misaoError = await this.installMisao(preflight.tailscaleIp, AGENT_PORT, token, preflight.hostProfile, report);
    const tmuxFound = preflight.tmuxVersion !== '';
    // A host with neither tmux nor an installed misao has no mux at all: fail instead of registering a server nothing can run on.
    if (!tmuxFound && (!this.misaoInstaller || misaoError)) {
      const cleanup = await this.discardUnregisteredAgent(sshHost, { hadAgent, installId, startMethod, nohupSighting });
      const msg = `${noMuxMessage(sshHost, misaoError)} ${cleanup}`;
      report('misao', 'error', msg);
      return { success: false, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod, steps, tmuxFound, error: msg };
    }

    return { success: true, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod, steps, tmuxFound, hostProfile: preflight.hostProfile, ...(misaoError ? { misaoError } : {}) };
  }

  /**
   * The agent this install started is not going to be registered (the host has no mux), so it is taken off the host rather than left
   * listening with a token nobody holds. Returns the sentence for the error.
   *
   * Only a systemd agent is stopped and removed here, by unit name, in one remote script that first checks the folder still holds this
   * install's id. A nohup agent is left in place, and the error says how to stop and check it by hand: its only handle is a pid file,
   * and telling the agent from another program that reuses the pid would need per-OS process inspection (/proc on Linux, `ps` output
   * elsewhere) that is not worth its risk for a rare path. Its children (a tmux server) are not touched either way: they outlive it.
   *
   * An agent that was on the host before this install is left alone. Putting it back would take the previous token and the previous
   * release, and there is no way to hand them to this install yet (it overwrites the unit, the settings and the `current` link in
   * place, where the Windows install sets them aside for its commit / rollback): that is outside this change. Removing it would take
   * away an agent the hub may still be using.
   */
  private async discardUnregisteredAgent(sshHost: string, install: { hadAgent: boolean; installId: string; startMethod: 'systemd' | 'nohup'; nohupSighting: NohupSighting | undefined }): Promise<string> {
    if (install.hadAgent) {
      return `An agent was already installed on this host before this install; it was replaced by the new one and left running, nothing was removed. The new agent holds a new token that the hub does not store: run the install again once a mux is available. To remove it by hand: ${MANUAL_STEPS_ANY_START}`;
    }
    if (install.startMethod === 'nohup') {
      return `The agent this install started runs as a plain process (nohup), which is not stopped automatically, so it and ~/.azito/agent were left in place on ${sshHost}. To stop it and remove it: ${nohupManualSteps(install.nohupSighting)}`;
    }
    const result = await this.runOnHost(sshHost, buildCleanupScript(install.installId), CLEANUP_TIMEOUT_MS);
    if (!result.ok) {
      // A timeout or a lost connection does not say whether the script finished (it may still be running on the host), and this hub has no
      // second way to ask while it holds the install lock: nothing is assumed.
      return `The agent this install started could not be checked or removed (${result.error}); it may still be running on ${sshHost}, and the removal script may still be running there (while ${CLEANUP_LOCK_DIR} exists, installs, updates and recoveries of this host are refused). Check systemctl --user is-active azito-agent and whether ~/.azito/agent exists before doing anything, then: ${SYSTEMD_MANUAL_STEPS}`;
    }
    const outcome = parseCleanupOutcome(result.stdout);
    switch (outcome.kind) {
      case 'removed':
        return 'The agent this install started was stopped and removed.';
      case 'busy':
        return `Nothing was removed: another cleanup holds ${CLEANUP_LOCK_DIR} on ${sshHost}, or the mark could not be made. The agent this install started was left in place. Once no cleanup is running there: ${SYSTEMD_MANUAL_STEPS}`;
      case 'not_owner':
        return `Nothing was removed: ~/.azito/agent on ${sshHost} does not hold this install's id${outcome.found ? ' (another install is using it)' : ' (it is gone or has no id)'}. Whatever agent is there is not this install's to remove.`;
      case 'not_stopped':
        return `The agent this install started could not be stopped (${outcome.reason}), so it and ~/.azito/agent were left in place. Stop and remove it by hand: ${SYSTEMD_MANUAL_STEPS}`;
      case 'not_removed':
        return `The agent this install started was stopped, but not fully removed (could not remove ${outcome.reason}). Remove what is left on ${sshHost} by hand: rm -f ~/.config/systemd/user/azito-agent.service; rm -rf ~/.azito/agent`;
    }
  }

  /** What the nohup agent looks like (pid and start time as `ps` prints them), for the operator; undefined when the host does not say. */
  private async sightNohupAgent(sshHost: string): Promise<NohupSighting | undefined> {
    const result = await this.runOnHost(sshHost, buildNohupSightingScript());
    return result.ok ? parseNohupSighting(result.stdout) : undefined;
  }

  private async writeInstallId(sshHost: string, installId: string): Promise<void> {
    const result = await this.sshClient.execIsolated(sshHost, `mkdir -p ~/.azito/agent && printf %s ${installId} > ${INSTALL_ID_FILE}`);
    if (result.code !== 0) throw new Error(`install id write failed: ${result.stderr}`);
  }

  /** One command over SSH as a value: a failed command or connection is `ok: false` with the reason (the caller reports it, never hides it). */
  private async runOnHost(sshHost: string, command: string, timeoutMs?: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
      const result = await this.sshClient.execIsolated(sshHost, command, timeoutMs);
      return result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false, error: result.stderr.trim() || `exit ${result.code}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * True when the host has an agent unit or folder. An answer that is not the expected one counts as "has one": nothing is removed on a
   * guess. Throws {@link CleanupMarkError} while the mark of a cleanup is on the host.
   */
  private async hostHasAgent(sshHost: string): Promise<boolean> {
    const result = await this.sshClient.execIsolated(sshHost, AGENT_PRESENCE_COMMAND);
    if (result.code !== 0) return true;
    const mark = parseCleanupGuard(result.stdout, (line) => line === 'AZITO_AGENT_PRESENT' || line === 'AZITO_AGENT_ABSENT');
    if (mark) throw new CleanupMarkError(cleanupMarkMessage(sshHost, mark));
    return result.stdout.trim().split('\n').pop() !== 'AZITO_AGENT_ABSENT';
  }

  /** Throws {@link CleanupMarkError} while the mark of a cleanup is on the host. The first shell command of an update or a recovery. */
  private async assertNoCleanupRunning(sshHost: string): Promise<void> {
    const result = await this.sshClient.execIsolated(sshHost, CLEANUP_GUARD_COMMAND);
    if (result.code !== 0) throw new Error(`could not check the host for a running cleanup: ${result.stderr.trim() || `exit ${result.code}`}`);
    const mark = parseCleanupGuard(result.stdout, (line) => line === 'AZITO_CLEANUP_IDLE');
    if (mark) throw new CleanupMarkError(cleanupMarkMessage(sshHost, mark));
  }

  /**
   * The Windows install (the Unix sh bootstrap is not used): transfer and unpack over SFTP + PowerShell, settings in an owner-only
   * file, a Task Scheduler logon task as the service, then the same health check. misao is installed beside it (MisaoAgentInstaller, #369 A3).
   */
  private async installOnWindows(
    sshHost: string,
    version: string,
    token: string,
    preflight: PreflightInfo,
    host: WindowsPreflightInfo,
    steps: InstallProgress[],
    report: (step: InstallStep, status: InstallProgress['status'], message: string) => void,
  ): Promise<InstallResult> {
    const port = this.windowsAgent.port;
    const ip = preflight.tailscaleIp;
    const deployer = this.windowsDeployer();
    const failed = (error: string): InstallResult => ({ success: false, host: ip, port, token, version, startMethod: 'taskscheduler', steps, error });

    report('transfer', 'running', 'Transferring agent bundle...');
    let deployment: WindowsDeployment;
    try {
      const tarballPath = this.bundler.getTarballPath();
      if (!fs.existsSync(tarballPath)) throw new Error('Agent tarball not found — run build first');
      deployment = await deployer.deploy({
        sshHost, host, nodePath: host.nodePath!, version, tarballPath, token, bindAddress: ip,
        expectedSha256: readSha256FromSumsFile(this.bundler.getSha256sumsPath(), 'azito-agent.tar.gz'),
      });
      report('transfer', 'ok', 'Agent deployed');
    } catch (err) {
      const msg = (err as Error).message;
      report('transfer', 'error', msg);
      return failed(msg);
    }

    // From here the previous install (if any) is kept aside; it is deleted only after the new agent has answered, and put back if it never does.
    report('start', 'running', 'Starting agent...');
    try {
      await deployer.start(sshHost, host);
      report('start', 'ok', `Started via Task Scheduler (runs while ${host.userId} is logged on)`);
    } catch (err) {
      const msg = `${(err as Error).message} (${await deployment.rollback().catch((e: unknown) => `the previous install could not be restored: ${(e as Error).message}`)})`;
      report('start', 'error', msg);
      return failed(msg);
    }

    report('health', 'running', 'Verifying agent health...');
    try {
      await this.healthCheck(ip, port, version);
    } catch (err) {
      const taskState = await deployer.describeTask(sshHost, host);
      const restored = await deployment.rollback().catch((e: unknown) => `the previous install could not be restored: ${(e as Error).message}`);
      const msg = `${(err as Error).message}. ${taskState}. Check that ${host.userId} is logged on to Windows (the agent starts at logon) and that Windows Firewall allows TCP ${port}; the agent's log is ${windowsAgentLayout(host.home, this.windowsAgent, version).logFile}. Rolled back: ${restored}`;
      report('health', 'error', msg);
      return failed(msg);
    }
    const layout = windowsAgentLayout(host.home, this.windowsAgent, version);
    const leftovers = await deployment.commit().then(() => '', (e: unknown) => ` WARNING: the previous install could not be removed (${(e as Error).message}). The next install on this host stops while ${layout.envFilePrev} or any other *.prev in ${layout.root} exists: once the agent works, delete them by hand.`);
    report('health', 'ok', `Agent healthy.${leftovers}`);

    // A misao that could not be installed is reported beside the install, not as its failure: the agent stays installed and healthy.
    const misaoError = await this.installMisao(ip, port, token, preflight.hostProfile, report);
    return { success: true, host: ip, port, token, version, startMethod: 'taskscheduler', steps, tmuxFound: false, hostProfile: preflight.hostProfile, ...(misaoError ? { misaoError } : {}) };
  }

  /**
   * Takes the agent of a Windows host off the host (task, processes, firewall rule, folder; the misao beside it when asked). Holds the
   * host's lock like an install or an update, so none of them runs in the middle. Only the host is changed: the caller owns the server row.
   * The host is asked who it is (home folder, SystemRoot), not checked for what an install needs (node, Tailscale): a half-installed agent is removable.
   */
  uninstallFromWindowsHost(sshHost: string, choice: WindowsUninstallChoice): Promise<WindowsUninstallResult> {
    return this.hostLocks.withLock(this.lockKey(sshHost), async () => {
      const probe = await this.sshClient.execIsolated(sshHost, buildWindowsPreflightCommand());
      const host = parseWindowsPreflight(probe.stdout, probe.stderr, probe.code);
      return this.windowsDeployer().uninstall(sshHost, host, choice);
    });
  }

  private windowsDeployer(): WindowsAgentDeployer {
    return new WindowsAgentDeployer(
      (host, command, timeoutMs) => this.sshClient.execIsolated(host, command, timeoutMs),
      { putFile: (host, localPath, remote) => this.sftpUpload(host, localPath, remote), putBuffer: (host, data, remote) => this.sftpWrite(host, data, remote) },
      this.windowsAgent,
    );
  }

  /** Puts misao on the agent that just came up. A failure is reported, not thrown: the agent stays installed. */
  private async installMisao(host: string, port: number, token: string, hostProfile: HostProfile, report: (step: InstallStep, status: InstallProgress['status'], message: string) => void): Promise<string | undefined> {
    if (!this.misaoInstaller) return undefined;
    report('misao', 'running', 'Installing misao...');
    try {
      const transport = new AgentTransport(host, port, token, 'system', host, hostProfile);
      const result = await this.misaoInstaller.install(transport, (step) => report('misao', 'running', MISAO_STEP_MESSAGES[step]));
      report('misao', 'ok', `misao ${result.version} (${result.startMethod})`);
      return undefined;
    } catch (err) {
      const message = (err as Error).message;
      report('misao', 'error', message);
      return message;
    }
  }

  /**
   * Redeploys the agent over SSH: a Windows host (`hostProfile`) takes the install's transaction ({@link updateOnWindows}); any
   * other host (null = a Unix agent registered before the OS was recorded) takes the Unix bootstrap (tar, nohup, systemd).
   * `warning` is set when the update worked but left something on the host that a person should know about.
   */
  update(sshHost: string, tailscaleIp: string, existingToken: string, hostProfile: HostProfile | null, muxRuntime?: string): Promise<AgentUpdateResult> {
    return this.hostLocks.withLock(this.lockKey(sshHost), () => this.updateLocked(sshHost, tailscaleIp, existingToken, hostProfile, muxRuntime));
  }

  private async updateLocked(sshHost: string, tailscaleIp: string, existingToken: string, hostProfile: HostProfile | null, muxRuntime?: string): Promise<AgentUpdateResult> {
    await this.bundler.ensureBuild();
    const version = this.bundler.getBundleHash();

    if (hostProfile?.platform === 'win32') return this.updateOnWindows(sshHost, tailscaleIp, existingToken, version);

    try {
      await this.assertNoCleanupRunning(sshHost);
    } catch (err) {
      return { success: false, version, error: (err as Error).message };
    }

    try {
      await this.transferAndDeploy(sshHost, version);
    } catch (err) {
      return { success: false, version, error: `Transfer failed: ${(err as Error).message}` };
    }

    await this.stopAgent(sshHost);

    try {
      await this.startAgent(sshHost, tailscaleIp, existingToken, muxRuntime);
    } catch (err) {
      return { success: false, version, error: `Start failed: ${(err as Error).message}` };
    }

    try {
      await this.healthCheck(tailscaleIp, AGENT_PORT, version);
    } catch (err) {
      return { success: false, version, error: `Health check failed: ${(err as Error).message}` };
    }

    return { success: true, version };
  }

  /**
   * The Windows update: the install's transaction (deploy, start, health, commit / rollback) with the agent's current token, so that
   * the hub's stored token and the host's settings stay the same. The firewall is checked as in the install, for the `node.exe`
   * found now (it may not be the one the running agent uses), before anything is stopped. The misao task is not touched.
   */
  private async updateOnWindows(sshHost: string, tailscaleIp: string, token: string, version: string): Promise<AgentUpdateResult> {
    let host: WindowsPreflightInfo;
    let expectedSha256: string;
    const tarballPath = this.bundler.getTarballPath();
    try {
      const probe = await this.sshClient.execIsolated(sshHost, buildWindowsPreflightCommand());
      host = parseWindowsPreflight(probe.stdout, probe.stderr, probe.code);
      const missing = checkWindowsPreflight(host);
      if (missing.length > 0) throw new Error(`Preflight failed:\n${missing.map(m => `  - ${m}`).join('\n')}`);
      await this.windowsDeployer().ensureFirewall(sshHost, host.nodePath!, tailscaleIp);
      if (!fs.existsSync(tarballPath)) throw new Error('Agent tarball not found — run build first');
      expectedSha256 = readSha256FromSumsFile(this.bundler.getSha256sumsPath(), 'azito-agent.tar.gz');
    } catch (err) {
      return { success: false, version, error: (err as Error).message };
    }
    const port = this.windowsAgent.port;
    return updateWindowsAgent(
      { deployer: this.windowsDeployer(), checkHealth: (expected) => this.healthCheck(tailscaleIp, port, expected) },
      { sshHost, host, nodePath: host.nodePath!, version, tarballPath, expectedSha256, token, bindAddress: tailscaleIp },
      port,
      windowsAgentLayout(host.home, this.windowsAgent, version).logFile,
    );
  }

  private async preflight(sshHost: string): Promise<PreflightInfo> {
    // The login shell of the target is unknown (sh, cmd.exe or PowerShell): the OS is read first, then the matching probes run.
    const osProbe = await this.sshClient.execIsolated(sshHost, HOST_OS_PROBE_COMMAND);
    if (parseHostOsProbe(osProbe.stdout, osProbe.stderr, osProbe.code).os === 'windows') return this.preflightWindows(sshHost);
    return this.preflightPosix(sshHost);
  }

  /** One PowerShell script (EncodedCommand: the same under a cmd.exe and a PowerShell login shell) answers everything. */
  private async preflightWindows(sshHost: string): Promise<PreflightInfo> {
    const result = await this.sshClient.execIsolated(sshHost, buildWindowsPreflightCommand());
    const info = parseWindowsPreflight(result.stdout, result.stderr, result.code);
    const missing = checkWindowsPreflight(info);
    if (missing.length > 0) {
      throw new Error(`Preflight failed:\n${missing.map(m => `  - ${m}`).join('\n')}`);
    }
    // checkWindowsPreflight passed: node, x64 and the Tailscale IP are there.
    await this.windowsDeployer().ensureFirewall(sshHost, info.nodePath!, info.tailscaleIp!);
    return {
      tailscaleIp: info.tailscaleIp!,
      nodeVersion: info.nodeVersion!,
      hostProfile: { platform: 'win32', arch: 'x64' },
      tmuxVersion: '',
      windows: info,
    };
  }

  private async preflightPosix(sshHost: string): Promise<PreflightInfo> {
    const missing: string[] = [];

    const nodeResult = await this.sshClient.execIsolated(sshHost, 'node --version');
    const nodeVersionRaw = nodeResult.stdout.trim().replace(/^v/, '');
    const nodeMajor = parseInt(nodeVersionRaw.split('.')[0], 10);
    if (isNaN(nodeMajor) || nodeMajor < 24) {
      missing.push(`Node.js v24+ required (found: ${nodeResult.stdout.trim() || 'not installed'})`);
    }

    // Without node the probe cannot run; the Node requirement above already says so.
    const hostProfile = nodeMajor >= 24 ? await this.probeHostProfile(sshHost, missing) : undefined;

    // tmux is optional: the pane server this hub installs is misao.
    const tmuxResult = await this.sshClient.execIsolated(sshHost, 'tmux -V');
    const tmuxVersion = tmuxResult.stdout.trim();

    const tsResult = await this.sshClient.execIsolated(sshHost, 'tailscale ip -4');
    const tailscaleIp = tsResult.stdout.trim().split('\n')[0];
    if (!tailscaleIp || !tailscaleIp.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      missing.push(`Tailscale IP not found (got: ${tailscaleIp || 'empty'})`);
    }

    if (missing.length > 0) {
      throw new Error(`Preflight failed:\n${missing.map(m => `  - ${m}`).join('\n')}`);
    }

    // `missing` is empty here, so the probe ran and produced a profile.
    return { tailscaleIp, nodeVersion: nodeVersionRaw, hostProfile: hostProfile!, tmuxVersion };
  }

  /**
   * Reads the host's OS / architecture with node itself (the same text under sh, cmd and PowerShell). The hosts this installer
   * accepts are unchanged: x64 only. A Windows host never gets here (`preflight` sends it to `preflightWindows` by the OS probe),
   * so a win32 answer is refused as `unsupported_os`; an OS or architecture AZITO does not know is `unsupported_host`. A reason
   * is added to `missing` for a host that is refused.
   */
  private async probeHostProfile(sshHost: string, missing: string[]): Promise<HostProfile | undefined> {
    const probe = await this.sshClient.execIsolated(sshHost, HOST_PROBE_COMMAND);
    let profile: HostProfile;
    try {
      profile = parseHostProbe(probe.stdout);
    } catch (err) {
      missing.push(err instanceof HostProfileError ? `${err.code}: ${err.message}` : (err as Error).message);
      return undefined;
    }
    if (profile.platform === 'win32') {
      missing.push('unsupported_os: this host answered as Windows to the Unix preflight; a Windows host is installed through the Windows preflight');
    } else if (profile.arch !== 'x64') {
      missing.push(`x86_64 architecture required (found: ${profile.arch})`);
    }
    return profile;
  }

  private async transferAndDeploy(sshHost: string, version: string): Promise<void> {
    const tarball = this.bundler.getTarballPath();
    if (!fs.existsSync(tarball)) {
      throw new Error('Agent tarball not found — run build first');
    }

    const remoteTmp = `/tmp/azito-agent-${version}.tar.gz`;
    await this.sftpUpload(sshHost, tarball, remoteTmp);

    const expectedHash = readSha256FromSumsFile(this.bundler.getSha256sumsPath(), 'azito-agent.tar.gz');

    const verifyCmd = buildSha256VerifyCommand(remoteTmp);
    const shaResult = await this.sshClient.execIsolated(sshHost, verifyCmd);
    const actualHash = shaResult.stdout.trim();
    if (actualHash !== expectedHash) {
      await this.sshClient.execIsolated(sshHost, `rm -f "${remoteTmp}"`);
      throw new Error(`SHA256 mismatch: expected ${expectedHash}, got ${actualHash}`);
    }

    const deployDir = `~/.azito/agent/${version}`;
    const extractCmd = buildSafeExtractCommand(remoteTmp, deployDir);
    const extractResult = await this.sshClient.execIsolated(sshHost, extractCmd);
    if (extractResult.code !== 0) {
      throw new Error(`Deploy failed: ${extractResult.stderr}`);
    }

    const linkCmd = `ln -sfn ~/.azito/agent/${version} ~/.azito/agent/current`;
    await this.sshClient.execIsolated(sshHost, linkCmd);
  }

  private async startAgent(
    sshHost: string,
    tailscaleIp: string,
    token: string,
    muxRuntime?: string,
  ): Promise<'systemd' | 'nohup'> {
    // Try systemd first
    try {
      return await this.startSystemd(sshHost, tailscaleIp, token, muxRuntime);
    } catch {
      // Fall back to nohup
    }

    await this.startNohup(sshHost, tailscaleIp, token, muxRuntime);
    return 'nohup';
  }

  private async startSystemd(sshHost: string, tailscaleIp: string, token: string, muxRuntime?: string): Promise<'systemd'> {
    const writeEnv = [
      'mkdir -p ~/.azito/agent',
      '( umask 077 && cat > ~/.azito/agent/agent.env << \'ENV_EOF\'',
      'AZITO_AGENT_TOKEN=' + token,
      'ENV_EOF',
      ')',
    ].join('\n');
    const envResult = await this.sshClient.execIsolated(sshHost, writeEnv);
    if (envResult.code !== 0) {
      throw new Error('agent env file write failed: ' + envResult.stderr);
    }

    const unitContent = [
      '[Unit]',
      'Description=AZITO Agent',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=/bin/bash %h/.azito/agent/current/run.sh',
      `Environment=AZITO_AGENT_BIND=${tailscaleIp}`,
      `EnvironmentFile=%h/.azito/agent/agent.env`,
      `Environment=PORT=${AGENT_PORT}`,
      `Environment=AZITO_MUX_RUNTIME=${muxRuntime || 'system'}`,
      // The socket the agent relays to (/ws?mode=misao): where the installed misao listens. Not a setting of the hub's.
      'Environment=MISAO_SOCKET=%h/.azito/misao/misao.sock',
      'Restart=on-failure',
      'RestartSec=10',
      // agent が子として起動する tmux サーバーを stop 時に道連れにしないため、control-group ではなく main PID のみを TERM する
      'KillMode=process',
      '',
      '[Install]',
      'WantedBy=default.target',
    ].join('\n');

    const writeUnit = `mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/azito-agent.service << 'UNIT_EOF'\n${unitContent}\nUNIT_EOF`;
    const writeResult = await this.sshClient.execIsolated(sshHost, writeUnit);
    if (writeResult.code !== 0) {
      throw new Error(`systemd unit write failed: ${writeResult.stderr}`);
    }

    // Allow the user's systemd instance to keep running (and auto-start on boot) without
    // an active login session — otherwise the agent only starts once someone SSHes in
    // after a machine/WSL restart. Not fatal if the platform doesn't support linger
    // (e.g. no polkit) — fall back to the current session-scoped behavior.
    await this.sshClient.execIsolated(sshHost, 'loginctl enable-linger "$(whoami)" || true');

    const enableResult = await this.sshClient.execIsolated(
      sshHost,
      'systemctl --user daemon-reload && systemctl --user enable azito-agent && systemctl --user restart azito-agent',
    );
    if (enableResult.code !== 0) {
      throw new Error(`systemd enable failed: ${enableResult.stderr}`);
    }

    return 'systemd';
  }

  private async startNohup(sshHost: string, tailscaleIp: string, token: string, muxRuntime?: string): Promise<void> {
    await this.sshClient.execIsolated(
      sshHost,
      'test -f ~/.azito/agent/agent.pid && kill $(cat ~/.azito/agent/agent.pid) 2>/dev/null; true',
    );

    const writeEnv = [
      'mkdir -p ~/.azito/agent',
      '( umask 077 && cat > ~/.azito/agent/agent.env << \'ENV_EOF\'',
      'AZITO_AGENT_TOKEN=' + token,
      'ENV_EOF',
      ')',
    ].join('\n');
    const envResult = await this.sshClient.execIsolated(sshHost, writeEnv);
    if (envResult.code !== 0) {
      throw new Error('agent env file write failed: ' + envResult.stderr);
    }

    const cmd = [
      'set -a; . ~/.azito/agent/agent.env; set +a;',
      `AZITO_AGENT_BIND=${tailscaleIp}`,
      `PORT=${AGENT_PORT}`,
      `AZITO_MUX_RUNTIME=${muxRuntime || 'system'}`,
      'MISAO_SOCKET="$HOME/.azito/misao/misao.sock"',
      'nohup bash ~/.azito/agent/current/run.sh',
      '> ~/.azito/agent/agent.log 2>&1 &',
      'echo $! > ~/.azito/agent/agent.pid',
    ].join(' ');

    await this.sshClient.execIsolated(sshHost, cmd);
  }

  /**
   * Start an already-deployed agent, used to recover an agent left stopped after an update
   * flow was interrupted (e.g. by a hub restart between stop and start). Reuses the same
   * systemd→nohup fallback as install/update, rather than a systemd-only shortcut. May throw
   * (e.g. SSH connection failure) — the caller is expected to catch and re-check health
   * afterward regardless of outcome.
   */
  recoverAgent(sshHost: string, tailscaleIp: string, token: string, hostProfile: HostProfile | null, muxRuntime?: string): Promise<'systemd' | 'nohup' | 'taskscheduler' | 'disabled'> {
    return this.hostLocks.withLock(this.lockKey(sshHost), () => this.recoverAgentLocked(sshHost, tailscaleIp, token, hostProfile, muxRuntime));
  }

  private async recoverAgentLocked(sshHost: string, tailscaleIp: string, token: string, hostProfile: HostProfile | null, muxRuntime?: string): Promise<'systemd' | 'nohup' | 'taskscheduler' | 'disabled'> {
    if (hostProfile?.platform === 'win32') {
      // The settings and the task are already on the host: ask it who it is, then restart the logon task.
      const probe = await this.sshClient.execIsolated(sshHost, buildWindowsPreflightCommand());
      const outcome = await this.windowsDeployer().restart(sshHost, parseWindowsPreflight(probe.stdout, probe.stderr, probe.code));
      return outcome === 'disabled' ? 'disabled' : 'taskscheduler';
    }
    await this.assertNoCleanupRunning(sshHost);
    return this.startAgent(sshHost, tailscaleIp, token, muxRuntime);
  }

  private async stopAgent(sshHost: string): Promise<void> {
    await this.sshClient.execIsolated(
      sshHost,
      'systemctl --user disable --now azito-agent 2>/dev/null; test -f ~/.azito/agent/agent.pid && kill $(cat ~/.azito/agent/agent.pid) 2>/dev/null; pkill -f azito-agent.cjs 2>/dev/null; sleep 1; true',
    );
  }

  private async healthCheck(
    host: string,
    port: number,
    /** undefined: any answer counts (the check after a rollback, when the previous version is not known). */
    expectedVersion: string | undefined,
  ): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = '';

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${host}:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const body = await res.json() as { version: string };
          if (expectedVersion === undefined || body.version === expectedVersion) return;
          lastError = `Version mismatch: expected ${expectedVersion}, got ${body.version}`;
        } else {
          lastError = `HTTP ${res.status}`;
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
      await new Promise(r => setTimeout(r, HEALTH_RETRY_INTERVAL_MS));
    }

    throw new Error(`Health check timed out: ${lastError}`);
  }

  private sftpUpload(sshHost: string, localPath: string, remotePath: string): Promise<void> {
    return this.sftpPut(sshHost, () => fs.createReadStream(localPath), remotePath);
  }

  private sftpWrite(sshHost: string, data: Buffer, remotePath: string): Promise<void> {
    return this.sftpPut(sshHost, () => Readable.from([data]), remotePath);
  }

  private sftpPut(sshHost: string, source: () => Readable, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const resolved = this.sshClient.resolveHost(sshHost);
      const conn = new Ssh2Client();
      const connectOpts = this.sshClient.buildConnectOpts(resolved);

      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SFTP transfer timed out'));
      }, 120000);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
          const readStream = source();
          const writeStream = sftp.createWriteStream(remotePath);
          writeStream.on('close', () => {
            clearTimeout(timeout);
            conn.end();
            resolve();
          });
          writeStream.on('error', (e: Error) => {
            clearTimeout(timeout);
            conn.end();
            reject(new Error(`SFTP write failed: ${e.message}`));
          });
          readStream.pipe(writeStream);
        });
      });

      conn.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
      conn.connect(connectOpts);
    });
  }
}
