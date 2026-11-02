import { LaunchdJobOperations, DEFAULT_LAUNCHD_TIMING, limitToBackgroundSession, type CommandRunner } from '../../system/serviceManager';
import { shellQuote } from '../../../shared/shellQuote';
import type { SshClient } from '../ssh/SshClient';

const LABEL = 'com.azito.agent';

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function renderMacAgentPlist(home: string, bind: string, port: number, mux: string): string {
  const run = `set -a; . ${shellQuote(`${home}/.azito/agent/agent.env`)}; set +a; exec /bin/bash ${shellQuote(`${home}/.azito/agent/current/run.sh`)}`;
  const env = { AZITO_AGENT_BIND: bind, PORT: String(port), AZITO_MUX_RUNTIME: mux, MISAO_SOCKET: `${home}/.azito/misao/misao.sock` };
  return limitToBackgroundSession(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${xml(run)}</string></array>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(`${home}/.azito/agent/agent.log`)}</string>\n<key>StandardErrorPath</key><string>${xml(`${home}/.azito/agent/agent.log`)}</string>\n</dict></plist>`);
}

/** Remote launchd commands use the same domain operations as the hub. */
export class MacAgentLaunchd {
  private constructor(private readonly ssh: Pick<SshClient, 'execIsolated'>, private readonly host: string, private readonly home: string, private readonly plist: string, private readonly jobs: LaunchdJobOperations) {}

  static async connect(ssh: Pick<SshClient, 'execIsolated'>, host: string): Promise<MacAgentLaunchd> {
    const facts = await ssh.execIsolated(host, 'printf "%s\\n%s\\n" "$HOME" "$(id -u)"');
    const lines = facts.stdout.trimEnd().split('\n');
    if (facts.code !== 0 || lines.length !== 2 || !lines[0].startsWith('/') || !/^\d+$/.test(lines[1])) throw new Error('Could not resolve the remote home directory and uid for launchd');
    const home = lines[0];
    const plist = `${home}/Library/LaunchAgents/${LABEL}.plist`;
    const run: CommandRunner = (file, args) => ssh.execIsolated(host, [file, ...args].map(shellQuote).join(' '));
    return new MacAgentLaunchd(ssh, host, home, plist, new LaunchdJobOperations(run, LABEL, Number(lines[1]), plist, DEFAULT_LAUNCHD_TIMING));
  }

  async assertOwned(): Promise<void> {
    const definition = await this.ssh.execIsolated(this.host, `if [ -f ${shellQuote(this.plist)} ]; then cat ${shellQuote(this.plist)}; else printf AZITO_NO_PLIST; fi`);
    if (definition.code !== 0) throw new Error('Could not inspect the agent launchd definition');
    if (definition.stdout !== 'AZITO_NO_PLIST' && (!definition.stdout.includes(`<key>Label</key><string>${LABEL}</string>`) || !definition.stdout.includes(xml(`${this.home}/.azito/agent/current/run.sh`)))) {
      throw new Error(`${LABEL} definition is not the managed agent; it was left unchanged`);
    }
    for (const job of await this.jobs.printJobs()) {
      if (job.result.code !== 0) continue;
      if (!job.result.stdout.includes(`path = ${this.plist}`) || !job.result.stdout.includes(`${this.home}/.azito/agent/current/run.sh`)) {
        throw new Error(`${LABEL} in ${job.domain} is not the managed agent; it was left unchanged`);
      }
    }
  }

  async stop(): Promise<void> {
    await this.assertOwned();
    const jobs = (await this.jobs.printJobs()).filter((job) => job.result.code === 0);
    if (jobs.length > 1) throw new Error(`${LABEL} is loaded in both user and gui domains`);
    for (const job of jobs) await this.jobs.bootout(job.domain);
  }

  async cleanup(installId: string): Promise<void> {
    const lock = `${this.home}/.azito/agent-cleanup.lock`;
    const idFile = `${this.home}/.azito/agent/install.id`;
    const acquire = await this.ssh.execIsolated(this.host, `mkdir ${shellQuote(lock)} && printf %s $$ > ${shellQuote(`${lock}/pid`)}`);
    if (acquire.code !== 0) throw new Error('Could not acquire the cleanup lock or verify the installation id');
    try {
      const owner = await this.ssh.execIsolated(this.host, `[ "$(cat ${shellQuote(idFile)} 2>/dev/null)" = ${shellQuote(installId)} ]`);
      if (owner.code !== 0) throw new Error('Installation id changed');
      await this.stop();
      const remove = await this.ssh.execIsolated(this.host, `[ "$(cat ${shellQuote(idFile)} 2>/dev/null)" = ${shellQuote(installId)} ] && rm -f ${shellQuote(this.plist)} && rm -rf ${shellQuote(`${this.home}/.azito/agent`)}`);
      if (remove.code !== 0) throw new Error('Installation id changed or agent files could not be removed');
    } finally {
      const release = await this.ssh.execIsolated(this.host, `rm -rf ${shellQuote(lock)}`);
      if (release.code !== 0) throw new Error('Could not release the agent cleanup lock');
    }
  }

  async start(bind: string, port: number, token: string, mux: string): Promise<void> {
    await this.assertOwned();
    const jobs = (await this.jobs.printJobs()).filter((job) => job.result.code === 0);
    if (jobs.length > 1) throw new Error(`${LABEL} is loaded in both user and gui domains`);
    if (jobs.length === 1) await this.jobs.bootout(jobs[0].domain);
    const env = `AZITO_AGENT_TOKEN=${shellQuote(token)}\n`;
    const script = `mkdir -p ${shellQuote(`${this.home}/.azito/agent`)} ${shellQuote(`${this.home}/Library/LaunchAgents`)} && (umask 077; printf %s ${shellQuote(env)} > ${shellQuote(`${this.home}/.azito/agent/agent.env`)}) && printf %s ${shellQuote(renderMacAgentPlist(this.home, bind, port, mux))} > ${shellQuote(this.plist)}`;
    const write = await this.ssh.execIsolated(this.host, script);
    if (write.code !== 0) throw new Error(`Could not write the agent launchd definition: ${write.stderr}`);
    await this.jobs.bootstrap('user');
  }
}
