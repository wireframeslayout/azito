import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import { decodeTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { decodeEncodedCommand, FakeWindowsHost } from '../../servers/agent-deploy/testing/fakeWindowsHost';
import { MISAO_RELEASE_FILE_NAMES, windowsMisaoPipe, type AgentMisaoHost, type MisaoReleaseFile, type MisaoSocketStatus } from '../../servers/transport/agentMisaoSocket';
import { readMisaoBundle, sha256Buffer, type MisaoBundle } from './MisaoBundle';
import { writeHubBundle } from './misaoBundleFixture';
import { MisaoAgentInstaller, type MisaoInstallStep, type MisaoInstallTarget } from './MisaoAgentInstaller';

const VERSION = '0.3.0';
const OLD_VERSION = '0.2.0';
const ROOT = 'C:\\Users\\dev\\.azito\\misao';
const PIPE = windowsMisaoPipe(ROOT, 'dev');
const TASK = 'AzitoMisao';

const HOST: AgentMisaoHost = {
  homeDir: 'C:\\Users\\dev',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  servicePath: '',
  platform: 'win32',
  arch: 'x64',
  windows: { systemRoot: 'C:\\Windows', userName: 'dev', misaoRoot: ROOT },
};

interface FakeOptions {
  /** The daemon of this release never opens its pipe after `/Run` (the task that names its `misao.exe` starts and ends at once). */
  failStartFor?: string;
  /** `misao stop` does nothing, and so does ending the task and the sweep. */
  unstoppable?: boolean;
  /** The daemon stops, but the task stays "running" and cannot be ended; while it runs, `schtasks /Run` does nothing (IgnoreNew). */
  stuckTask?: boolean;
  /** Whatever the task starts, the program behind the pipe is this release's (a daemon that was not the one just started). */
  daemonVersionOverride?: string;
  /** Writing this file through the agent fails (a task XML whose registration cannot even start). */
  failWriteOf?: string;
  status?: Partial<MisaoSocketStatus>;
}

/**
 * An agent on a Windows host, as far as the installer sees it: its status, its upload route, its file API and its `/api/run`
 * (PowerShell scripts, schtasks, `misao.exe stop`). The Task Scheduler is the shared FakeWindowsHost; the daemon is a flag that
 * `schtasks /Run` raises and `misao stop` (or ending the task) lowers.
 */
class FakeWindowsAgent {
  readonly host = new FakeWindowsHost({ sha256: 'x'.repeat(64), taskName: TASK });
  daemonUp = false;
  /** What `<root>\current` says. */
  current: string | undefined;
  /** The hashes of the files in each release folder on the host. */
  readonly releaseDirs = new Map<string, string[]>();
  readonly uploads: string[] = [];
  readonly specs: CommandSpec[] = [];
  /** Every PowerShell script the agent was asked to run. */
  readonly scripts: string[] = [];
  readonly written: string[] = [];
  /** What changed on the host, in order (the task calls except the queries, the current file, `misao stop`). */
  readonly events: string[] = [];
  /** The release whose misao.exe the running daemon is. */
  private daemonVersion: string | undefined;
  private readonly staged = new Map<string, Map<string, string>>();

  constructor(private readonly bundle: MisaoBundle, private readonly options: FakeOptions = {}) {}

  seedInstalled(version: string, running: boolean): void {
    this.current = version;
    this.releaseDirs.set(version, version === VERSION ? MISAO_RELEASE_FILE_NAMES.map((name) => this.bundle.targets['x86_64-pc-windows-msvc'].sha256[name]) : MISAO_RELEASE_FILE_NAMES.map((name) => `old-${name}`));
    this.host.registeredXml = `<Task>previous definition for ${version}</Task>`;
    if (running) this.host.markRunning();
    else this.host.markEnded(0);
    this.daemonUp = running;
    this.daemonVersion = version;
  }

  asTarget(hostProfile: MisaoInstallTarget['hostProfile'] = { platform: 'win32', arch: 'x64' }): MisaoInstallTarget {
    return {
      hostProfile,
      exec: async () => { throw new Error('a Windows agent has no sh'); },
      fetchMisaoStatus: async () => ({
        socketPath: PIPE,
        socketPresent: this.daemonUp,
        ...(this.current ? { installedVersion: this.current } : {}),
        host: HOST,
        ...this.options.status,
      }),
      uploadMisaoFile: async (version: string, name: MisaoReleaseFile, data: Buffer) => {
        this.uploads.push(`${version}/${name}`);
        const hashes = this.staged.get(version) ?? new Map<string, string>();
        hashes.set(name, sha256Buffer(data));
        this.staged.set(version, hashes);
        return { name, size: data.length, sha256: sha256Buffer(data) };
      },
      files: () => ({
        write: async (file: string, data: Buffer) => {
          this.written.push(file);
          if (this.options.failWriteOf !== undefined && file.endsWith(this.options.failWriteOf)) throw new Error('disk full');
          if (file === `${ROOT}\\current`) {
            this.current = data.toString('utf8').trim();
            this.events.push(`current:${this.current}`);
          }
          else this.host.uploaded.set(file.replace(/\\/g, '/'), data);
          return {};
        },
        remove: async (file: string) => {
          if (file === `${ROOT}\\current`) this.current = undefined;
          else this.host.uploaded.delete(file.replace(/\\/g, '/'));
        },
      }),
      run: async (spec: CommandSpec): Promise<CommandResult> => this.run(spec),
    } as unknown as MisaoInstallTarget;
  }

  private async run(spec: CommandSpec): Promise<CommandResult> {
    this.specs.push(spec);
    if (spec.file.endsWith('misao.exe')) {
      this.events.push('misao stop');
      if (!this.options.unstoppable) this.stopDaemon();
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    }
    const line = `powershell.exe ${spec.args.join(' ')}`;
    const script = decodeEncodedCommand(line);
    this.scripts.push(script);
    const reply = (stdout = ''): CommandResult => ({ exitCode: 0, signal: null, stdout, stderr: '' });
    if (script.includes('WindowsIdentity]::GetCurrent().Name')) return reply(Buffer.from('PC\\dev', 'utf8').toString('base64'));
    if (script.includes('function Get-Sha256')) {
      const dir = /'([^']*\\(\d+\.\d+\.\d+))\\misao\.exe'/.exec(script)![2]!;
      return reply((this.releaseDirs.get(dir) ?? MISAO_RELEASE_FILE_NAMES.map(() => '-')).join('\n'));
    }
    if (script.includes("throw 'the staged release files are missing'")) {
      const version = /(\d+\.\d+\.\d+)\.upload/.exec(script)![1]!;
      this.releaseDirs.set(version, MISAO_RELEASE_FILE_NAMES.map((name) => this.staged.get(version)!.get(name)!));
      return reply();
    }
    if (script.includes('# AZITO_DAEMON_PATHS')) {
      const version = this.daemonVersion ?? this.current;
      return reply(Buffer.from(this.daemonUp && version ? `${ROOT}\\${version}\\misao.exe` : '', 'utf8').toString('base64'));
    }
    if (script.includes('function Get-AgentNodes')) {
      if (!this.options.unstoppable) this.stopDaemon();
      return reply();
    }
    const runningBefore = this.host.taskState === 'running';
    const result = await this.host.exec('h', line);
    const last = this.host.calls.at(-1)?.schtasksArgs?.[0];
    if (last !== undefined && last !== '/Query') this.events.push(`schtasks ${last}`);
    if (last === '/Run') {
      const failing = this.options.failStartFor !== undefined && (this.host.registeredXml ?? '').includes(`\\${this.options.failStartFor}\\misao.exe`);
      if (failing) this.host.markEnded(1);
      else if (!runningBefore) {
        // A start while the task is running does nothing (IgnoreNew): the daemon that is up, if any, stays what it was.
        this.daemonUp = true;
        this.daemonVersion = this.options.daemonVersionOverride ?? /(\d+\.\d+\.\d+)\\misao\.exe/.exec(this.host.registeredXml ?? '')?.[1];
      }
    }
    if (last === '/End' && result.code === 0 && !this.options.unstoppable) this.stopDaemon();
    if (last === '/End' && this.options.stuckTask) this.host.markRunning();
    return { exitCode: result.code, signal: null, stdout: result.stdout, stderr: result.stderr };
  }

  private stopDaemon(): void {
    this.daemonUp = false;
    if (this.options.stuckTask) return;
    if (this.host.taskState === 'running') this.host.markEnded();
  }

  schtasks(): string[] {
    return this.host.calls.filter((c) => c.kind === 'schtasks').map((c) => c.schtasksArgs![0]!);
  }
}

describe('MisaoAgentInstaller on a Windows agent', () => {
  let tmp: string;
  let bundle: MisaoBundle;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azmw-'));
    writeHubBundle(path.join(tmp, 'hub'), VERSION, 'MZ fake misao.exe');
    bundle = readMisaoBundle(path.join(tmp, 'hub'))!;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const installer = (b: MisaoBundle | null = bundle) => new MisaoAgentInstaller(b, { windowsTaskName: TASK, readyTimeoutMs: 400, pollIntervalMs: 10, taskIdleTimeoutMs: 60 });

  describe('install', () => {
    it('sends the Windows build through the agent, owner-only folder first, and starts it as a logon task', async () => {
      const agent = new FakeWindowsAgent(bundle);
      const steps: MisaoInstallStep[] = [];
      const result = await installer().install(agent.asTarget(), (step) => steps.push(step));

      expect(result).toEqual({ version: VERSION, runningVersion: VERSION, startMethod: 'taskscheduler', updateAvailable: false });
      expect(steps).toEqual(['inspect', 'transfer', 'prepare', 'start']);
      expect(agent.uploads).toEqual(MISAO_RELEASE_FILE_NAMES.map((name) => `${VERSION}/${name}`));
      expect(agent.current).toBe(VERSION);
      expect(agent.daemonUp).toBe(true);
      expect(agent.host.taskState).toBe('running');

      const scripts = agent.host.calls.filter((c) => c.kind === 'script').map((c) => c.text);
      expect(scripts[0]).toContain(`New-Item -ItemType Directory -Force -Path '${ROOT}'`);
      expect(scripts[0]).toContain('PurgeAccessRules'); // the folder is made owner-only before anything is put in it
      // No sh, no systemd, no symbolic link: nothing but PowerShell scripts, schtasks and the agent's own routes.
      expect(agent.specs.every((spec) => spec.file === 'powershell.exe' || spec.file.endsWith('misao.exe'))).toBe(true);
    });

    it('registers a logon task for that user: conhost --headless, cmd.exe appending the log, the pipe and the folder named explicitly', async () => {
      const agent = new FakeWindowsAgent(bundle);
      await installer().install(agent.asTarget());
      const xml = agent.host.registeredXml!;
      expect(xml).toContain('<UserId>PC\\dev</UserId>');
      expect(xml).toContain('<LogonTrigger>');
      expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
      // The release's own folder is in the command line, not a link; the daemon itself works in the home, so no pane starts in (and locks) a release folder.
      const args = /<Arguments>(.*)<\/Arguments>/.exec(xml)![1]!.replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      expect(args).toBe(`--headless C:\\Windows\\System32\\cmd.exe /d /c ""${ROOT}\\${VERSION}\\misao.exe" serve --socket "${PIPE}" --data "${ROOT}" >> "${ROOT}\\misao.log" 2>&1"`);
      expect(xml).toContain('<WorkingDirectory>C:\\Users\\dev</WorkingDirectory>');
      expect(xml).toContain('<Interval>PT1M</Interval>');
      // The XML went through the agent's file API (UTF-16, read back by the fake Task Scheduler), then schtasks /Create read it from there; the file is removed afterwards.
      expect(agent.written).toContain(`${ROOT}\\${TASK}.task.xml`);
      expect(agent.host.uploaded.has(`${ROOT.replace(/\\/g, '/')}/${TASK}.task.xml`)).toBe(false);
    });

    it('writes current, then registers the task, and starts only after that', async () => {
      const agent = new FakeWindowsAgent(bundle);
      await installer().install(agent.asTarget());
      expect(agent.events).toEqual([`current:${VERSION}`, 'schtasks /Create', 'schtasks /Run']);
    });

    it('does nothing when the bundled release is already running', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.seedInstalled(VERSION, true);
      const result = await installer().install(agent.asTarget());
      expect(result).toEqual({ version: VERSION, runningVersion: VERSION, startMethod: 'running', updateAvailable: false });
      expect(agent.uploads).toEqual([]);
      expect(agent.schtasks()).not.toContain('/Create');
      expect(agent.written).toEqual([]);
    });

    it('does not transfer again a release that is on the host whole, and starts it when the daemon is down', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.seedInstalled(VERSION, false);
      const steps: MisaoInstallStep[] = [];
      const result = await installer().install(agent.asTarget(), (step) => steps.push(step));
      expect(result.startMethod).toBe('taskscheduler');
      expect(agent.uploads).toEqual([]);
      expect(steps).toEqual(['inspect', 'start']);
      expect(agent.daemonUp).toBe(true);
    });

    it('puts the new release beside an older running one and leaves the daemon alone (an explicit update switches)', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.seedInstalled(OLD_VERSION, true);
      const result = await installer().install(agent.asTarget());
      expect(result).toEqual({ version: VERSION, runningVersion: OLD_VERSION, startMethod: 'running', updateAvailable: true });
      expect(agent.uploads.length).toBe(4);
      expect(agent.releaseDirs.has(VERSION)).toBe(true);
      expect(agent.current).toBe(OLD_VERSION);
      expect(agent.daemonUp).toBe(true);
      expect(agent.schtasks()).not.toContain('/Create');
      expect(agent.schtasks()).not.toContain('/End');
      expect(agent.specs.some((spec) => spec.file.endsWith('misao.exe'))).toBe(false);
    });

    it('refuses a daemon AZITO did not install', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.daemonUp = true;
      await expect(installer().install(agent.asTarget())).rejects.toMatchObject({ code: 'custom_socket' });
      expect(agent.uploads).toEqual([]);
    });

    it('refuses an agent that relays to some other pipe', async () => {
      const agent = new FakeWindowsAgent(bundle, { status: { socketPath: '\\\\.\\pipe\\mine' } });
      await expect(installer().install(agent.asTarget())).rejects.toMatchObject({ code: 'custom_socket', message: expect.stringContaining('MISAO_SOCKET') });
      expect(agent.uploads).toEqual([]);
    });

    it('refuses an agent that reports another OS than the recorded one, and one that did not report its Windows folders', async () => {
      const linux = new FakeWindowsAgent(bundle, { status: { host: { ...HOST, platform: 'linux', windows: undefined } } });
      await expect(installer().install(linux.asTarget())).rejects.toMatchObject({ code: 'unsupported_host', message: expect.stringContaining('linux') });
      const old = new FakeWindowsAgent(bundle, { status: { host: { ...HOST, windows: undefined } } });
      await expect(installer().install(old.asTarget())).rejects.toMatchObject({ code: 'unsupported_host', message: expect.stringContaining('update the agent') });
    });

    it('is refused without a bundle, and without the hub being told the task name', async () => {
      const agent = new FakeWindowsAgent(bundle);
      await expect(installer(null).install(agent.asTarget())).rejects.toMatchObject({ code: 'not_managed' });
      await expect(new MisaoAgentInstaller(bundle).install(agent.asTarget())).rejects.toMatchObject({ code: 'not_managed', message: expect.stringContaining('task name') });
    });

    it('is refused for a folder the task cannot hold, before anything is changed', async () => {
      const root = 'C:\\Users\\100%\\misao';
      const agent = new FakeWindowsAgent(bundle, { status: { socketPath: windowsMisaoPipe(root, 'dev'), host: { ...HOST, windows: { ...HOST.windows!, misaoRoot: root } } } });
      await expect(installer().install(agent.asTarget())).rejects.toMatchObject({ code: 'unsupported_host' });
      expect(agent.uploads).toEqual([]);
      expect(agent.schtasks().filter((call) => call !== '/Query')).toEqual([]);
    });

    it('does nothing while the task is running but the pipe is not up yet (a daemon on its way up)', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.seedInstalled(OLD_VERSION, false);
      agent.host.markRunning();
      await expect(installer().install(agent.asTarget())).rejects.toMatchObject({ code: 'daemon_not_ready', message: expect.stringContaining('Nothing was changed') });
      expect(agent.schtasks()).not.toContain('/Create');
      expect(agent.written).toEqual([]);
    });

    it('puts the previous task definition and current back when re-registering the same release fails or does not start', async () => {
      for (const options of [{ failWriteOf: '.task.xml' }, { failStartFor: VERSION }] as const) {
        const agent = new FakeWindowsAgent(bundle, options);
        agent.seedInstalled(VERSION, false);
        const before = agent.host.registeredXml;
        await expect(installer().install(agent.asTarget())).rejects.toBeInstanceOf(Error);
        expect(agent.host.registeredXml).toBe(before);
        expect(agent.current).toBe(VERSION);
        expect(agent.daemonUp).toBe(false);
      }
    });

    it('removes what a failed first install made, and reports the failure', async () => {
      const agent = new FakeWindowsAgent(bundle, { failStartFor: VERSION });
      await expect(installer().install(agent.asTarget())).rejects.toMatchObject({ code: 'daemon_not_ready', message: expect.stringContaining(`${ROOT}\\misao.log`) });
      expect(agent.host.taskState).toBe('absent');
      expect(agent.current).toBeUndefined();
    });

    it('puts an older install back as it was when starting the new release fails, without starting the old one', async () => {
      const agent = new FakeWindowsAgent(bundle, { failStartFor: VERSION });
      agent.seedInstalled(OLD_VERSION, false);
      await expect(installer().install(agent.asTarget())).rejects.toMatchObject({ code: 'daemon_not_ready' });
      expect(agent.current).toBe(OLD_VERSION);
      expect(agent.host.registeredXml).toBe(`<Task>previous definition for ${OLD_VERSION}</Task>`);
      expect(agent.daemonUp).toBe(false);
    });
  });

  describe('update', () => {
    it('stops the running release with its own misao stop through the pipe, switches, and starts the new one', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.seedInstalled(OLD_VERSION, true);
      const steps: MisaoInstallStep[] = [];
      const result = await installer().update(agent.asTarget(), (step) => steps.push(step));

      expect(result).toEqual({ version: VERSION, runningVersion: VERSION, startMethod: 'taskscheduler', updateAvailable: false });
      expect(steps).toEqual(['inspect', 'transfer', 'prepare', 'stop', 'start']);
      const stop = agent.specs.find((spec) => spec.file.endsWith('misao.exe'))!;
      expect(stop).toMatchObject({ file: `${ROOT}\\${OLD_VERSION}\\misao.exe`, args: ['stop'], env: { MISAO_SOCKET: PIPE } });
      expect(agent.current).toBe(VERSION);
      expect(agent.daemonUp).toBe(true);
      expect(agent.host.registeredXml).toContain(`${VERSION}\\misao.exe`);
      // The old daemon was gone before anything was switched.
      expect(agent.events).toEqual(['misao stop', `current:${VERSION}`, 'schtasks /Create', 'schtasks /Run']);
    });

    it('ends the task and sweeps the daemon processes when misao stop does not stop it', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.seedInstalled(OLD_VERSION, true);
      // misao stop is ignored; the End of the task takes it down.
      const target = agent.asTarget();
      const run = target.run.bind(target);
      target.run = async (spec) => (spec.file.endsWith('misao.exe') ? { exitCode: 0, signal: null, stdout: '', stderr: '' } : run(spec));
      await installer().update(target);
      expect(agent.schtasks()).toContain('/End');
      expect(agent.current).toBe(VERSION);
      expect(agent.daemonUp).toBe(true);
      const sweep = agent.scripts.find((t) => t.includes('function Get-AgentNodes'))!;
      expect(sweep).toContain(`$envArgument = '${PIPE}'`);
      expect(sweep).toContain(`Name = 'misao.exe'`);
    });

    it('changes nothing when the daemon cannot be stopped', async () => {
      const agent = new FakeWindowsAgent(bundle, { unstoppable: true });
      agent.seedInstalled(OLD_VERSION, true);
      await expect(installer().update(agent.asTarget())).rejects.toMatchObject({ code: 'update_failed', message: expect.stringContaining('still running and nothing was changed') });
      expect(agent.current).toBe(OLD_VERSION);
      expect(agent.schtasks()).not.toContain('/Create');
    });

    it('does not put the previous release back, nor start anything, while the stopped daemon\'s task is still running', async () => {
      const agent = new FakeWindowsAgent(bundle, { stuckTask: true });
      agent.seedInstalled(OLD_VERSION, true);
      const error = await installer().update(agent.asTarget()).then(() => undefined, (e: unknown) => e as Error);
      expect(error).toMatchObject({ code: 'update_failed', message: expect.stringContaining('could not be ended') });
      expect(error!.message).toMatch(/restoring 0\.2\.0 failed too.*did not stop/);
      expect(error!.message).not.toContain('Nothing was changed');
      expect(error!.message).not.toContain('was restored and started');
      // Nothing was switched, and no start was attempted that the running task would have ignored.
      expect(agent.current).toBe(OLD_VERSION);
      expect(agent.schtasks()).not.toContain('/Run');
      expect(agent.daemonUp).toBe(false);
    });

    it('does nothing while the task is running but the pipe is not up yet', async () => {
      const agent = new FakeWindowsAgent(bundle);
      agent.seedInstalled(OLD_VERSION, false);
      agent.host.markRunning();
      await expect(installer().update(agent.asTarget())).rejects.toMatchObject({ code: 'daemon_not_ready', message: expect.stringContaining('Nothing was changed') });
      expect(agent.written).toEqual([]);
      expect(agent.schtasks()).not.toContain('/Create');
      expect(agent.uploads).toEqual([]);
    });

    it('does not take an open pipe for the release it started: a different program behind it fails the start (and the previous release is put back)', async () => {
      const agent = new FakeWindowsAgent(bundle, { daemonVersionOverride: '9.9.9' });
      agent.seedInstalled(OLD_VERSION, true);
      const error = await installer().update(agent.asTarget()).then(() => undefined, (e: unknown) => e as Error);
      expect(error).toMatchObject({ code: 'update_failed' });
      expect(error!.message).toMatch(/restoring 0\.2\.0 failed too.*9\.9\.9.*not .*0\.2\.0/s);
    });

    it('puts the previous release and task back and starts it when the new one does not come up', async () => {
      const agent = new FakeWindowsAgent(bundle, { failStartFor: VERSION });
      agent.seedInstalled(OLD_VERSION, true);
      const error = await installer().update(agent.asTarget()).then(() => undefined, (e: unknown) => e as Error);
      expect(error).toMatchObject({ code: 'update_failed' });
      expect(error!.message).toContain(`The previous release ${OLD_VERSION} was restored and started`);
      expect(agent.current).toBe(OLD_VERSION);
      expect(agent.host.registeredXml).toBe(`<Task>previous definition for ${OLD_VERSION}</Task>`);
      expect(agent.daemonUp).toBe(true);
      // Stopped the old one, tried the new one (which never opened its pipe, so there is nothing to stop), put the old one back, started it.
      expect(agent.events).toEqual(['misao stop', `current:${VERSION}`, 'schtasks /Create', 'schtasks /Run', `current:${OLD_VERSION}`, 'schtasks /Create', 'schtasks /Run']);
    });

    it('says what to do by hand when even putting the previous release back fails', async () => {
      const agent = new FakeWindowsAgent(bundle, { failStartFor: VERSION });
      agent.seedInstalled(OLD_VERSION, true);
      const target = agent.asTarget();
      const files = target.files();
      let writes = 0;
      target.files = () => ({ ...files, write: async (file: string, data: Buffer) => { if (++writes > 2) throw new Error('disk full'); return files.write(file, data); } }) as ReturnType<MisaoInstallTarget['files']>;
      const error = await installer().update(target).then(() => undefined, (e: unknown) => e as Error);
      expect(error).toMatchObject({ code: 'update_failed' });
      expect(error!.message).toMatch(/restoring 0\.2\.0 failed too.*disk full/);
      expect(error!.message).toContain('To restore the previous release by hand');
    });

    it('is refused when misao was not installed by AZITO, and does nothing when it is already the bundled release', async () => {
      const bare = new FakeWindowsAgent(bundle);
      await expect(installer().update(bare.asTarget())).rejects.toMatchObject({ code: 'not_installed' });
      const current = new FakeWindowsAgent(bundle);
      current.seedInstalled(VERSION, true);
      expect(await installer().update(current.asTarget())).toMatchObject({ startMethod: 'running', updateAvailable: false });
      expect(current.schtasks()).not.toContain('/Create');
    });
  });

  describe('an agent registered without its OS', () => {
    it('that reports win32 is not guessed at: the Unix install refuses it', async () => {
      const agent = new FakeWindowsAgent(bundle);
      for (const action of ['install', 'update'] as const) {
        await expect(installer()[action](agent.asTarget(null))).rejects.toMatchObject({ code: 'unsupported_os' });
      }
      expect(agent.schtasks()).toEqual([]);
    });
  });
});
