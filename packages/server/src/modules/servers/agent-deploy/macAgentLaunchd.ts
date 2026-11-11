import { LaunchdJobOperations, DEFAULT_LAUNCHD_TIMING, limitToBackgroundSession, type CommandRunner } from '../../../shared/os/launchd';
import { execPosixRemote } from './posixRemoteCommand';
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
    const facts = await execPosixRemote(ssh, host, 'printf "%s\\n%s\\n" "$HOME" "$(id -u)"');
    const lines = facts.stdout.trimEnd().split('\n');
    if (facts.code !== 0 || lines.length !== 2 || !lines[0].startsWith('/') || !/^\d+$/.test(lines[1])) throw new Error('Could not resolve the remote home directory and uid for launchd');
    const home = lines[0];
    const plist = `${home}/Library/LaunchAgents/${LABEL}.plist`;
    const run: CommandRunner = async (file, args) => {
      const result = await execPosixRemote(ssh, host, [file, ...args].map(shellQuote).join(' '));
      if (args[0] !== 'print') return result;
      if (result.code === 0 && result.stdout.includes(`${args[1]} = {`)) return result;
      if (result.code === 113 && /Could not find service/i.test(result.stderr)) return result;
      if ((result.code === 113 || result.code === 125) && /Could not find domain/i.test(result.stderr)) return result;
      throw new Error(`Could not determine launchd job state for ${args[1]}`);
    };
    return new MacAgentLaunchd(ssh, host, home, plist, new LaunchdJobOperations(run, LABEL, Number(lines[1]), plist, DEFAULT_LAUNCHD_TIMING));
  }

  private execPosix(command: string): ReturnType<SshClient['execIsolated']> {
    return execPosixRemote(this.ssh, this.host, command);
  }

  async assertOwned(): Promise<void> {
    const definition = await this.execPosix(`if [ -f ${shellQuote(this.plist)} ]; then cat ${shellQuote(this.plist)}; else printf AZITO_NO_PLIST; fi`);
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

  async readCurrent(): Promise<string | null> {
    const current = `${this.home}/.azito/agent/current`;
    const result = await this.execPosix(`if [ -L ${shellQuote(current)} ]; then readlink ${shellQuote(current)}; elif [ -e ${shellQuote(current)} ]; then exit 1; else printf AZITO_ABSENT; fi`);
    if (result.code !== 0) throw new Error('The agent current path is not a symlink');
    const target = result.stdout.trim();
    if (target === 'AZITO_ABSENT') return null;
    if (!target || target.includes('\n')) throw new Error('Could not read the agent current link');
    return target;
  }

  async restoreCurrent(previous: string | null, version: string): Promise<void> {
    const current = `${this.home}/.azito/agent/current`;
    const expected = `${this.home}/.azito/agent/${version}`;
    const change = previous === null ? `rm -f ${shellQuote(current)}` : `ln -sfn ${shellQuote(previous)} ${shellQuote(current)}`;
    const result = await this.execPosix(`[ "$(readlink ${shellQuote(current)})" = ${shellQuote(expected)} ] && ${change}`);
    if (result.code !== 0) throw new Error('Agent current link changed or could not be restored');
  }

  async readInstallId(): Promise<string | undefined> {
    const idFile = `${this.home}/.azito/agent/install.id`;
    const result = await this.execPosix(`if [ -f ${shellQuote(idFile)} ]; then cat ${shellQuote(idFile)}; elif [ -e ${shellQuote(`${this.home}/.azito/agent`)} ]; then exit 2; else printf AZITO_ABSENT; fi`);
    if (result.code !== 0) throw new Error('The agent folder has no installation id; it was left unchanged');
    const id = result.stdout.trim();
    if (id === 'AZITO_ABSENT') {
      await this.assertOwned();
      if ((await this.jobs.printJobs()).some((job) => job.result.code === 0)) throw new Error('A launchd job is still loaded but the agent folder is absent; it was left unchanged');
      return undefined;
    }
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('The agent installation id is invalid; it was left unchanged');
    return id;
  }

  /** The managed agent is still installed: its installation id and `current` link are there (both are removed with the agent). */
  async hasInstallation(): Promise<boolean> {
    if ((await this.readInstallId()) === undefined) return false;
    return (await this.readCurrent()) !== null;
  }

  async cleanup(installId: string): Promise<void> {
    const lock = `${this.home}/.azito/agent-cleanup.lock`;
    const idFile = `${this.home}/.azito/agent/install.id`;
    const acquire = await this.execPosix(`mkdir ${shellQuote(lock)} && date +%s > ${shellQuote(`${lock}/started`)}`);
    if (acquire.code !== 0) throw new Error('Could not acquire the cleanup lock or verify the installation id');
    try {
      const owner = await this.execPosix(`[ "$(cat ${shellQuote(idFile)} 2>/dev/null)" = ${shellQuote(installId)} ]`);
      if (owner.code !== 0) throw new Error('Installation id changed');
      await this.stop();
      const remove = await this.execPosix(`[ "$(cat ${shellQuote(idFile)} 2>/dev/null)" = ${shellQuote(installId)} ] && rm -f ${shellQuote(this.plist)} && rm -rf ${shellQuote(`${this.home}/.azito/agent`)}`);
      if (remove.code !== 0) throw new Error('Installation id changed or agent files could not be removed');
    } finally {
      const release = await this.execPosix(`rm -rf ${shellQuote(lock)}`);
      if (release.code !== 0) throw new Error('Could not release the agent cleanup lock');
    }
  }

  async start(bind: string, port: number, token: string, mux: string): Promise<void> {
    await this.assertOwned();
    const jobs = (await this.jobs.printJobs()).filter((job) => job.result.code === 0);
    if (jobs.length > 1) throw new Error(`${LABEL} is loaded in both user and gui domains`);
    const envFile = `${this.home}/.azito/agent/agent.env`;
    const backupResult = await this.execPosix(`mkdir -p ${shellQuote(`${this.home}/.azito`)} && backup=$(mktemp -d ${shellQuote(`${this.home}/.azito/agent-launchd-backup.XXXXXX`)}) && { [ ! -f ${shellQuote(this.plist)} ] || cp -p ${shellQuote(this.plist)} "$backup/plist"; } && { [ ! -f ${shellQuote(envFile)} ] || cp -p ${shellQuote(envFile)} "$backup/env"; } && printf '%s\\n' "$backup"`);
    const backup = backupResult.stdout.trim();
    if (backupResult.code !== 0 || !backup.startsWith(`${this.home}/.azito/agent-launchd-backup.`) || backup.includes('\n')) throw new Error('Could not save the previous launchd definition');
    let stopped = false;
    let keepBackup = false;
    try {
      if (jobs.length === 1) { await this.jobs.bootout(jobs[0].domain); stopped = true; }
      const env = `AZITO_AGENT_TOKEN=${shellQuote(token)}\n`;
      const script = `mkdir -p ${shellQuote(`${this.home}/.azito/agent`)} ${shellQuote(`${this.home}/Library/LaunchAgents`)} && (umask 077; printf %s ${shellQuote(env)} > ${shellQuote(envFile)}) && printf %s ${shellQuote(renderMacAgentPlist(this.home, bind, port, mux))} > ${shellQuote(this.plist)}`;
      const write = await this.execPosix(script);
      if (write.code !== 0) throw new Error(`Could not write the agent launchd definition: ${write.stderr}`);
      await this.jobs.bootstrap('user');
    } catch (err) {
      const restore = await this.execPosix(`if [ -f ${shellQuote(`${backup}/plist`)} ]; then cp -p ${shellQuote(`${backup}/plist`)} ${shellQuote(this.plist)}; else rm -f ${shellQuote(this.plist)}; fi && if [ -f ${shellQuote(`${backup}/env`)} ]; then cp -p ${shellQuote(`${backup}/env`)} ${shellQuote(envFile)}; else rm -f ${shellQuote(envFile)}; fi`);
      if (restore.code !== 0) { keepBackup = true; throw new Error(`Agent launchd start failed and restoring its definition failed; backup left at ${backup}`); }
      if (stopped) {
        try { await this.jobs.bootstrap(jobs[0].domain); }
        catch (restoreError) { keepBackup = true; throw new Error(`Agent launchd start failed and the previous job could not be restarted; backup left at ${backup}: ${(restoreError as Error).message}`); }
      }
      throw err;
    } finally {
      if (!keepBackup) {
        const remove = await this.execPosix(`rm -rf ${shellQuote(backup)}`);
        if (remove.code !== 0) throw new Error(`Could not remove launchd backup ${backup}`);
      }
    }
  }
}
