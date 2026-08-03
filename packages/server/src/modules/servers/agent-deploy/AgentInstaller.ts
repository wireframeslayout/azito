import * as crypto from 'crypto';
import * as fs from 'fs';
import { Client as Ssh2Client } from 'ssh2';
import type { SshClient } from '../ssh/SshClient';
import type { AgentBundler } from './AgentBundler';
import { buildSha256VerifyCommand, buildSafeExtractCommand, readSha256FromSumsFile } from './integrityVerifier';

export type InstallStep = 'preflight' | 'transfer' | 'start' | 'health';

export interface InstallProgress {
  step: InstallStep;
  status: 'running' | 'ok' | 'error';
  message: string;
}

export interface InstallResult {
  success: boolean;
  host: string;
  port: number;
  token: string;
  version: string;
  startMethod: 'systemd' | 'nohup';
  steps: InstallProgress[];
  error?: string;
}

interface PreflightInfo {
  tailscaleIp: string;
  nodeVersion: string;
  arch: string;
  tmuxVersion: string;
}

const AGENT_PORT = 3002;
const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_RETRY_INTERVAL_MS = 1000;

export class AgentInstaller {
  constructor(
    private sshClient: SshClient,
    private bundler: AgentBundler,
  ) {}

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
      report('preflight', 'ok', `Node ${preflight.nodeVersion}, ${preflight.arch}, tmux ${preflight.tmuxVersion}`);
    } catch (err) {
      const msg = (err as Error).message;
      report('preflight', 'error', msg);
      return { success: false, host: '', port: AGENT_PORT, token, version, startMethod: 'nohup', steps, error: msg };
    }

    // ── Transfer & deploy ──
    report('transfer', 'running', 'Transferring agent bundle...');
    try {
      await this.transferAndDeploy(sshHost, version);
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

    return { success: true, host: preflight.tailscaleIp, port: AGENT_PORT, token, version, startMethod, steps };
  }

  async update(sshHost: string, tailscaleIp: string, existingToken: string, muxRuntime?: string): Promise<{ success: boolean; version: string; error?: string }> {
    await this.bundler.ensureBuild();
    const version = this.bundler.getBundleHash();

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
    const missing: string[] = [];

    const nodeResult = await this.sshClient.execIsolated(sshHost, 'node --version');
    const nodeVersionRaw = nodeResult.stdout.trim().replace(/^v/, '');
    const nodeMajor = parseInt(nodeVersionRaw.split('.')[0], 10);
    if (isNaN(nodeMajor) || nodeMajor < 24) {
      missing.push(`Node.js v24+ required (found: ${nodeResult.stdout.trim() || 'not installed'})`);
    }

    const archResult = await this.sshClient.execIsolated(sshHost, 'uname -m');
    const arch = archResult.stdout.trim();
    if (arch !== 'x86_64') {
      missing.push(`x86_64 architecture required (found: ${arch || 'unknown'})`);
    }

    const tmuxResult = await this.sshClient.execIsolated(sshHost, 'tmux -V');
    const tmuxVersion = tmuxResult.stdout.trim();
    if (!tmuxVersion) {
      missing.push('tmux is required but not found');
    }

    const tsResult = await this.sshClient.execIsolated(sshHost, 'tailscale ip -4');
    const tailscaleIp = tsResult.stdout.trim().split('\n')[0];
    if (!tailscaleIp || !tailscaleIp.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      missing.push(`Tailscale IP not found (got: ${tailscaleIp || 'empty'})`);
    }

    if (missing.length > 0) {
      throw new Error(`Preflight failed:\n${missing.map(m => `  - ${m}`).join('\n')}`);
    }

    return { tailscaleIp, nodeVersion: nodeVersionRaw, arch, tmuxVersion };
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
  async recoverAgent(sshHost: string, tailscaleIp: string, token: string, muxRuntime?: string): Promise<'systemd' | 'nohup'> {
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
          const readStream = fs.createReadStream(localPath);
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
