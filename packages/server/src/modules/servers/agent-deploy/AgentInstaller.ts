import * as crypto from 'crypto';
import * as fs from 'fs';
import { Readable } from 'stream';
import { Client as Ssh2Client } from 'ssh2';
import type { SshClient } from '../ssh/SshClient';
import type { AgentBundler } from './AgentBundler';
import { AgentTransport } from '../transport/AgentTransport';
import { HOST_PROBE_COMMAND, HostProfileError, assertPosixHost, parseHostProbe, type HostProfile } from '../../../shared/os/hostProfile';
import { HOST_OS_PROBE_COMMAND, parseHostOsProbe } from './hostOsProbe';
import { buildWindowsPreflightCommand, checkWindowsPreflight, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import { buildSha256VerifyCommand, buildSafeExtractCommand, readSha256FromSumsFile } from './integrityVerifier';
import { WindowsAgentDeployer, windowsAgentLayout, type WindowsDeployment } from './WindowsAgentDeployer';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, type WindowsAgentOptions } from './windowsAgentConfig';

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

/** Answers whether the host already has an agent of this hub's kind (its unit or its folder), before this install touches anything. */
export const AGENT_PRESENCE_COMMAND = 'if [ -e ~/.config/systemd/user/azito-agent.service ] || [ -e ~/.azito/agent ]; then echo AZITO_AGENT_PRESENT; else echo AZITO_AGENT_ABSENT; fi';

/** The file that says which install owns `~/.azito/agent`: the cleanup removes the folder only when it holds this install's id. */
const INSTALL_ID_FILE = '~/.azito/agent/install.id';
/** Marks the agent's own process (run.sh `exec`s node, so the process the pid file names is node running the bundle's entry). */
const AGENT_ENTRY = 'azito-agent.cjs';
const REMOVE_FOLDER_MANUALLY = 'rm -rf ~/.azito/agent';

/** The process a nohup start made: the pid alone is not an identity (a pid is reused once the process ends), so its start time is kept with it. */
interface NohupProcess { pid: number; startedAt: string }

/** The error for a host that has no tmux and no misao: the same text is the API's `error` and what the UI shows. */
function noMuxMessage(host: string, misaoError: string | undefined): string {
  return `no mux is available on ${host}: tmux is not installed and misao could not be installed (${misaoError ?? 'this hub has no misao to install'}).`;
}

export class AgentInstaller {
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

  async install(
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
      const msg = `Could not check the host for an existing agent: ${(err as Error).message}`;
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
    // The agent is up, so its process is the one the pid file names: take its identity now, for a cleanup that may come after misao.
    const nohupProcess = startMethod === 'nohup' ? await this.readNohupProcess(sshHost) : undefined;

    // ── misao ──
    const misaoError = await this.installMisao(preflight.tailscaleIp, AGENT_PORT, token, preflight.hostProfile, report);
    const tmuxFound = preflight.tmuxVersion !== '';
    // A host with neither tmux nor an installed misao has no mux at all: fail instead of registering a server nothing can run on.
    if (!tmuxFound && (!this.misaoInstaller || misaoError)) {
      const cleanup = await this.discardUnregisteredAgent(sshHost, { hadAgent, installId, startMethod, nohupProcess });
      const msg = `${noMuxMessage(sshHost, misaoError)} ${cleanup}`;
      report('misao', 'error', msg);
      return { success: false, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod, steps, tmuxFound, error: msg };
    }

    return { success: true, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod, steps, tmuxFound, hostProfile: preflight.hostProfile, ...(misaoError ? { misaoError } : {}) };
  }

  /**
   * The agent this install started is not going to be registered (the host has no mux), so it is stopped and removed rather than
   * left listening with a token nobody holds. Returns the sentence for the error. Nothing is removed unless the host says, over SSH,
   * that it is this install's: the folder holds this install's id, and the process (checked just before it is stopped) is the one that
   * was started, by start time and command line.
   *
   * An agent that was on the host before this install is left alone. Putting it back would take the previous token and the previous
   * release, and there is no way to hand them to this install yet (it overwrites the unit, the settings and the `current` link in
   * place, where the Windows install sets them aside for its commit / rollback): that is outside this change. Removing it would take
   * away an agent the hub may still be using.
   *
   * The nohup process is the agent itself (run.sh `exec`s node), so no child is stopped: what it started (a tmux server) is meant to
   * outlive it. A systemd agent is stopped as a unit, never by pid.
   */
  private async discardUnregisteredAgent(sshHost: string, install: { hadAgent: boolean; installId: string; startMethod: 'systemd' | 'nohup'; nohupProcess: NohupProcess | undefined }): Promise<string> {
    if (install.hadAgent) {
      return `An agent was already installed on this host before this install; it was replaced by the new one and left running, nothing was removed. The new agent holds a new token that the hub does not store: run the install again once a mux is available. To remove it by hand: systemctl --user disable --now azito-agent; ${REMOVE_FOLDER_MANUALLY}`;
    }
    const owner = await this.runOnHost(sshHost, `cat ${INSTALL_ID_FILE}`);
    if (!owner.ok || owner.stdout.trim() !== install.installId) {
      return `Nothing was removed: ~/.azito/agent on ${sshHost} does not hold this install's id${owner.ok ? ' (another install is using it)' : ` (${owner.error})`}. Whatever agent is there is not this install's to remove.`;
    }

    const unitManual = install.startMethod === 'systemd' ? 'systemctl --user disable azito-agent; rm -f ~/.config/systemd/user/azito-agent.service; ' : '';
    const stop = install.startMethod === 'systemd' ? await this.stopSystemdAgent(sshHost) : await this.stopNohupAgent(sshHost, install.nohupProcess);
    if (!stop.ok) {
      return `The agent this install started could not be stopped (${stop.error}), so it and ~/.azito/agent were left in place. Stop it by hand: ${stop.manual}; then remove it: ${unitManual}${REMOVE_FOLDER_MANUALLY}`;
    }

    const problems: string[] = [];
    if (install.startMethod === 'systemd') {
      const unit = await this.runOnHost(sshHost, 'systemctl --user disable azito-agent 2>/dev/null; rm -f ~/.config/systemd/user/azito-agent.service && (systemctl --user daemon-reload 2>/dev/null; true)');
      if (!unit.ok) problems.push(`could not remove the systemd unit: ${unit.error}`);
    }
    const folder = await this.runOnHost(sshHost, `${REMOVE_FOLDER_MANUALLY} && test ! -e ~/.azito/agent`);
    if (!folder.ok) problems.push(`could not remove ~/.azito/agent: ${folder.error}`);
    if (problems.length === 0) return 'The agent this install started was stopped and removed.';
    return `The agent this install started was stopped, but not fully removed (${problems.join('; ')}). Remove what is left on ${sshHost} by hand: ${unitManual}${REMOVE_FOLDER_MANUALLY}`;
  }

  /** Stops the unit (not a pid) and asks systemd, over SSH, whether it is still running. */
  private async stopSystemdAgent(sshHost: string): Promise<{ ok: true } | { ok: false; error: string; manual: string }> {
    const manual = 'systemctl --user stop azito-agent';
    const stopped = await this.runOnHost(sshHost, 'systemctl --user stop azito-agent');
    if (!stopped.ok) return { ok: false, error: stopped.error, manual };
    const state = await this.runOnHost(sshHost, 'systemctl --user is-active azito-agent; true');
    if (!state.ok) return { ok: false, error: state.error, manual };
    const active = state.stdout.trim();
    return active === 'inactive' || active === 'failed' ? { ok: true } : { ok: false, error: `the unit is still ${active || 'in an unknown state'} after it was stopped`, manual };
  }

  /**
   * Stops the process this install started, only if it is still that process: the pid must have the recorded start time and the
   * agent's entry in its command line. The script prints what it found, so the hub decides on the answer and not on an exit code.
   */
  private async stopNohupAgent(sshHost: string, proc: NohupProcess | undefined): Promise<{ ok: true } | { ok: false; error: string; manual: string }> {
    if (!proc) {
      return { ok: false, error: 'the agent process could not be identified when it started, so it is not stopped on a guess', manual: 'find it with `cat ~/.azito/agent/agent.pid` and `ps -o args= -p <pid>`, and kill that pid' };
    }
    const manual = `kill ${proc.pid}`;
    const script = [
      `p=${proc.pid}`,
      'now=$(ps -o lstart= -p "$p" 2>/dev/null); args=$(ps -o args= -p "$p" 2>/dev/null)',
      'if [ -z "$now" ]; then echo GONE',
      `elif [ "$now" != '${proc.startedAt}' ]; then echo REUSED`,
      `else case "$args" in *${AGENT_ENTRY}*) kill "$p" 2>/dev/null; i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done; if kill -0 "$p" 2>/dev/null; then echo ALIVE; else echo STOPPED; fi;; *) echo REUSED;; esac`,
      'fi',
    ].join('\n');
    const result = await this.runOnHost(sshHost, script);
    if (!result.ok) return { ok: false, error: result.error, manual };
    const outcome = result.stdout.trim();
    // GONE / REUSED: the agent this install started has ended (its pid is free, or belongs to another program, which was not touched).
    if (outcome === 'GONE' || outcome === 'REUSED' || outcome === 'STOPPED') return { ok: true };
    return { ok: false, error: outcome === 'ALIVE' ? `process ${proc.pid} is still running 10s after it was asked to stop` : `unexpected answer "${outcome}"`, manual };
  }

  /** The pid file's process with its start time, or undefined when the host does not answer in the expected form. */
  private async readNohupProcess(sshHost: string): Promise<NohupProcess | undefined> {
    const result = await this.runOnHost(sshHost, 'p=$(cat ~/.azito/agent/agent.pid 2>/dev/null) && echo "$p|$(ps -o lstart= -p "$p")|$(ps -o args= -p "$p")"');
    if (!result.ok) return undefined;
    const [pid, startedAt, args] = result.stdout.trim().split('|');
    if (!/^\d+$/.test(pid ?? '') || !startedAt || !/^[\w :]+$/.test(startedAt) || !args?.includes(AGENT_ENTRY)) return undefined;
    return { pid: Number(pid), startedAt: startedAt.trim() };
  }

  private async writeInstallId(sshHost: string, installId: string): Promise<void> {
    const result = await this.sshClient.execIsolated(sshHost, `mkdir -p ~/.azito/agent && printf %s ${installId} > ${INSTALL_ID_FILE}`);
    if (result.code !== 0) throw new Error(`install id write failed: ${result.stderr}`);
  }

  /** One command over SSH as a value: a failed command or connection is `ok: false` with the reason (the caller reports it, never hides it). */
  private async runOnHost(sshHost: string, command: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
      const result = await this.sshClient.execIsolated(sshHost, command);
      return result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false, error: result.stderr.trim() || `exit ${result.code}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** True when the host has an agent unit or folder. An answer that is not the expected one counts as "has one": nothing is removed on a guess. */
  private async hostHasAgent(sshHost: string): Promise<boolean> {
    const result = await this.sshClient.execIsolated(sshHost, AGENT_PRESENCE_COMMAND);
    return !(result.code === 0 && result.stdout.trim() === 'AZITO_AGENT_ABSENT');
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
   * Redeploys the agent over SSH with the Unix bootstrap (tar, nohup, systemd). A win32 agent (`hostProfile`; null = a Unix agent
   * registered before the OS was recorded) is refused with the `unsupported_os` reason as the error, before anything is sent.
   */
  async update(sshHost: string, tailscaleIp: string, existingToken: string, hostProfile: HostProfile | null, muxRuntime?: string): Promise<{ success: boolean; version: string; error?: string }> {
    await this.bundler.ensureBuild();
    const version = this.bundler.getBundleHash();

    try {
      assertPosixHost(hostProfile, 'this agent server', 'updating the agent over SSH');
    } catch (err) {
      if (!(err instanceof HostProfileError)) throw err;
      return { success: false, version, error: `${err.code}: ${err.message}` };
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
   * accepts are unchanged: x64 only. Windows is a known OS that is not installable here yet (`unsupported_os`); an OS or
   * architecture AZITO does not know is `unsupported_host`. A reason is added to `missing` for a host that is refused.
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
      missing.push('unsupported_os: installing the agent on a Windows host is not supported yet');
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
  async recoverAgent(sshHost: string, tailscaleIp: string, token: string, hostProfile: HostProfile | null, muxRuntime?: string): Promise<'systemd' | 'nohup' | 'taskscheduler' | 'disabled'> {
    if (hostProfile?.platform === 'win32') {
      // The settings and the task are already on the host: ask it who it is, then restart the logon task.
      const probe = await this.sshClient.execIsolated(sshHost, buildWindowsPreflightCommand());
      const outcome = await this.windowsDeployer().restart(sshHost, parseWindowsPreflight(probe.stdout, probe.stderr, probe.code));
      return outcome === 'disabled' ? 'disabled' : 'taskscheduler';
    }
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
    expectedVersion: string,
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
          if (body.version === expectedVersion) return;
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
