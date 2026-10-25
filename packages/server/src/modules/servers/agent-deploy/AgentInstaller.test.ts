import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_PROBE_COMMAND } from '../../../shared/os/hostProfile';
import { HOST_OS_PROBE_COMMAND } from './hostOsProbe';
import { buildWindowsPreflightCommand } from './windowsPreflight';
import { AGENT_PRESENCE_COMMAND, AgentInstaller, type AgentMisaoInstaller, type InstallProgress } from './AgentInstaller';
import { DEFAULT_WINDOWS_AGENT_OPTIONS } from './windowsAgentConfig';

const VERSION = 'bundlehash1';

function makeBundler() {
  return {
    ensureBuild: vi.fn(async () => undefined),
    getBundleHash: vi.fn(() => VERSION),
    getTarballPath: vi.fn(() => '/tmp/fake.tar.gz'),
    getSha256sumsPath: vi.fn(() => '/tmp/SHA256SUMS'),
  };
}

interface HostOptions {
  tmux?: string;
  probe?: string;
  /** An agent was on the host before this install. */
  hadAgent?: boolean;
  /** Commands matching this fail (exit 1, "Permission denied"). */
  failCommand?: RegExp;
  /** The presence check itself cannot be run (the connection fails). */
  presenceThrows?: boolean;
  /** What the single cleanup script answers once the id matches (a line of its protocol; default REMOVED). */
  cleanupResult?: string;
  /** The unit cannot be started, so the agent is started with nohup. */
  nohup?: boolean;
  /** What the sighting of the nohup agent prints (default: pid 4242 with a start time). */
  sighting?: string;
  /** The install id on the host is replaced by this one before the cleanup (another install took the folder). */
  takeoverId?: string;
}

/** What one host keeps: shared by every install that is run against the same fake, like the real thing. */
interface FakeHost { folderId: string; folderExists: boolean }

/** An SSH client whose host answers the preflight and accepts every other command, recording them all. */
function makeSsh(opts: HostOptions = {}, host: FakeHost = { folderId: '', folderExists: false }) {
  const commands: string[] = [];
  const execIsolated = vi.fn(async (_host: string, command: string) => {
    commands.push(command);
    if (opts.presenceThrows && command === AGENT_PRESENCE_COMMAND) throw new Error('connection reset');
    const written = /printf %s (\w+) > ~\/\.azito\/agent\/install\.id/.exec(command);
    if (written) { host.folderId = written[1]!; host.folderExists = true; }
    if (opts.failCommand?.test(command)) return { stdout: '', stderr: 'Permission denied', code: 1 };
    if (opts.nohup && command.includes('systemctl --user daemon-reload && systemctl --user enable')) return { stdout: '', stderr: 'no bus', code: 1 };
    if (command.includes('ps -o lstart=')) return { stdout: opts.sighting ?? '4242|Sat Oct 25 11:00:00 2026\n', stderr: '', code: 0 };
    if (command.includes('cleanup() {')) {
      if (opts.takeoverId) host.folderId = opts.takeoverId;
      const mine = /"\$id" != '(\w+)'/.exec(command)![1]!;
      if (host.folderId !== mine) return { stdout: `NOT_OWNER:${host.folderId}\n`, stderr: '', code: 0 };
      const result = opts.cleanupResult ?? 'REMOVED';
      if (result === 'REMOVED') { host.folderId = ''; host.folderExists = false; }
      return { stdout: `${result}\n`, stderr: '', code: 0 };
    }
    const answers: Record<string, string> = {
      [HOST_OS_PROBE_COMMAND]: 'AZITO_OS:%OS%:0\n',
      'node --version': 'v24.14.0\n',
      [HOST_PROBE_COMMAND]: opts.probe ?? 'linux x64\n',
      'tmux -V': opts.tmux ?? '',
      'tailscale ip -4': '100.64.0.9\n',
      [AGENT_PRESENCE_COMMAND]: opts.hadAgent || host.folderExists ? 'AZITO_AGENT_PRESENT\n' : 'AZITO_AGENT_ABSENT\n',
    };
    return { stdout: answers[command] ?? '', stderr: '', code: 0 };
  });
  // Names of ~/.ssh/config resolve to a user and an address: the alias `box` is user@host.
  const resolveHost = (h: string) => (h === 'box' ? { username: 'user', host: 'host', port: 22 } : { username: h.includes('@') ? h.split('@')[0]! : 'user', host: h.replace(/^.*@/, '').replace(/:\d+$/, ''), port: Number(/:(\d+)$/.exec(h)?.[1] ?? 22) });
  return { ssh: { execIsolated, resolveHost }, commands, host };
}

describe('AgentInstaller', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: VERSION }) })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function make(misao?: AgentMisaoInstaller, sshOpts: HostOptions = {}, fakeHost?: FakeHost) {
    const { ssh, commands } = makeSsh(sshOpts, fakeHost);
    const installer = new AgentInstaller(ssh as never, makeBundler() as never, DEFAULT_WINDOWS_AGENT_OPTIONS, misao);
    // The transfer is the SSH library's business (and needs a real server): everything around it is what is tested here.
    (installer as unknown as { transferAndDeploy: () => Promise<void> }).transferAndDeploy = async () => undefined;
    return { installer, commands };
  }

  const okMisao = (): AgentMisaoInstaller & { install: ReturnType<typeof vi.fn> } => ({
    install: vi.fn(async (_transport, onProgress?: (step: 'transfer') => void) => {
      onProgress?.('transfer');
      return { version: '0.2.0', startMethod: 'systemd' as const, updateAvailable: false };
    }),
  });

  it('does not require tmux when misao is installed: a host without it passes', async () => {
    const { installer } = make(okMisao(), { tmux: '' });
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));
    expect(result.success).toBe(true);
    expect(result.tmuxFound).toBe(false);
    expect(steps.find((s) => s.step === 'preflight' && s.status === 'ok')?.message).toContain('no tmux (optional)');
  });

  const NO_MISAO = undefined;
  const cleanupScripts = (commands: string[]): string[] => commands.filter((c) => c.includes('cleanup() {'));

  it('fails saying no mux is available, and stops and removes the systemd agent it started, in one script', async () => {
    const { installer, commands } = make(NO_MISAO, { tmux: '' });
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^no mux is available on user@host: tmux is not installed and misao could not be installed \(this hub has no misao to install\)\. /);
    expect(result.error).not.toMatch(/tmux is required/);
    expect(result.error).toContain('The agent this install started was stopped and removed.');
    const [script] = cleanupScripts(commands);
    expect(cleanupScripts(commands)).toHaveLength(1);
    // The id check, the stop (as a unit, no pid) and the removal are one call.
    expect(script).toContain("systemctl --user stop azito-agent");
    expect(script).not.toContain('kill "$p"');
    expect(script.indexOf("!= '")).toBeLessThan(script.indexOf('systemctl --user stop'));
    expect(script.indexOf('systemctl --user stop')).toBeLessThan(script.indexOf('rm -rf ~/.azito/agent'));
    expect(steps.at(-1)).toEqual({ step: 'misao', status: 'error', message: result.error });
  });

  it('fails with the reason misao could not be installed, and removes the agent it started', async () => {
    const misao: AgentMisaoInstaller = { install: vi.fn(async () => { throw new Error('no node-pty'); }) };
    const { installer, commands } = make(misao, { tmux: '' });
    const result = await installer.install('user@host');
    expect(result.error).toMatch(/^no mux is available on user@host: tmux is not installed and misao could not be installed \(no node-pty\)\. /);
    expect(cleanupScripts(commands)).toHaveLength(1);
  });

  it('does not remove anything when the host has tmux (the install is kept)', async () => {
    const misao: AgentMisaoInstaller = { install: vi.fn(async () => { throw new Error('no node-pty'); }) };
    const { installer, commands } = make(misao, { tmux: 'tmux 3.4\n' });
    expect((await installer.install('user@host')).success).toBe(true);
    expect(cleanupScripts(commands)).toEqual([]);
  });

  it('does not stop or remove a nohup agent: it is left in place, with its pid, start time and the steps to stop it by hand', async () => {
    const { installer, commands } = make(NO_MISAO, { tmux: '', nohup: true });
    const result = await installer.install('user@host');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^no mux is available on user@host: /);
    expect(result.error).toContain('runs as a plain process (nohup), which is not stopped automatically');
    expect(result.error).toContain('when it started the pid was 4242 and the process started at "Sat Oct 25 11:00:00 2026"');
    expect(result.error).toContain('$HOME/.azito/agent/current/azito-agent.cjs as an argument');
    expect(result.error).toContain('then rm -rf ~/.azito/agent');
    expect(cleanupScripts(commands)).toEqual([]);
    expect(commands.some((c) => /kill "\$p"|\/proc\//.test(c))).toBe(false);
  });

  it('says so when the pid of a nohup agent could not be read', async () => {
    const { installer } = make(NO_MISAO, { tmux: '', nohup: true, sighting: '\n' });
    const result = await installer.install('user@host');
    expect(result.error).toContain('its pid could not be read when it started');
  });

  it('gives the systemd steps when the unit does not stop', async () => {
    const { installer } = make(NO_MISAO, { tmux: '', cleanupResult: 'NOT_STOPPED:the unit is still active after it was stopped' });
    const result = await installer.install('user@host');
    expect(result.error).toContain('the unit is still active after it was stopped');
    expect(result.error).toContain('systemctl --user is-active azito-agent (it must print inactive)');
  });

  it('does not touch an agent that was on the host before this install, and says how to remove it by hand (systemd or nohup)', async () => {
    const { installer, commands } = make(NO_MISAO, { tmux: '', hadAgent: true });
    const result = await installer.install('user@host');
    expect(result.error).toMatch(/^no mux is available on user@host: /);
    expect(result.error).toContain('left running, nothing was removed');
    expect(result.error).toContain('If it runs as a systemd unit: systemctl --user stop azito-agent');
    expect(result.error).toContain('If it was started with nohup: The pid file is ~/.azito/agent/agent.pid');
    expect(cleanupScripts(commands)).toEqual([]);
  });

  it('removes nothing when the host cannot say whether an agent was there (an answer that fails is "has one")', async () => {
    const { installer, commands } = make(NO_MISAO, { tmux: '', failCommand: new RegExp(`^${AGENT_PRESENCE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    const result = await installer.install('user@host');
    expect(result.error).toContain('left running, nothing was removed');
    expect(cleanupScripts(commands)).toEqual([]);
  });

  it('fails like the other steps, removing nothing, when the presence check cannot run', async () => {
    const { installer, commands } = make(NO_MISAO, { tmux: '', presenceThrows: true });
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));
    expect(result.success).toBe(false);
    expect(result.error).toBe('Could not check the host for an existing agent: connection reset');
    expect(steps.at(-1)).toEqual({ step: 'transfer', status: 'error', message: result.error });
    expect(commands.some((c) => c.includes('systemctl --user enable'))).toBe(false);
  });

  it('removes nothing when another install has taken the folder', async () => {
    const { installer } = make(NO_MISAO, { tmux: '', takeoverId: 'someoneelsesid' });
    const result = await installer.install('user@host');
    expect(result.success).toBe(false);
    expect(result.error).toContain("Nothing was removed: ~/.azito/agent on user@host does not hold this install's id (another install is using it)");
  });

  it('runs two installs to one host one after the other: the second starts after the first has finished its cleanup', async () => {
    const host: FakeHost = { folderId: '', folderExists: false };
    const { ssh, commands } = makeSsh({ tmux: '' }, host);
    const installer = new AgentInstaller(ssh as never, makeBundler() as never, DEFAULT_WINDOWS_AGENT_OPTIONS, undefined);
    (installer as unknown as { transferAndDeploy: () => Promise<void> }).transferAndDeploy = async () => undefined;
    // Same host under two spellings (as two server names would have it).
    const [a, b] = await Promise.all([installer.install('user@host'), installer.install('user@HOST:22')]);
    // Without the lock the second one's presence probe would run before the first's cleanup, and it would be refused as "has an agent".
    expect(a.error).toContain('stopped and removed');
    expect(b.error).toContain('stopped and removed');
    const firstCleanup = commands.findIndex((c) => c.includes('cleanup() {'));
    const probes = commands.flatMap((c, i) => (c === AGENT_PRESENCE_COMMAND ? [i] : []));
    expect(probes).toHaveLength(2);
    expect(probes[1]).toBeGreaterThan(firstCleanup);
    expect(host.folderExists).toBe(false);
  });

  it('takes one lock for an SSH alias, an omitted port and an explicit one: they are one host', async () => {
    const host: FakeHost = { folderId: '', folderExists: false };
    const { ssh, commands } = makeSsh({ tmux: '' }, host);
    const installer = new AgentInstaller(ssh as never, makeBundler() as never, DEFAULT_WINDOWS_AGENT_OPTIONS, undefined);
    (installer as unknown as { transferAndDeploy: () => Promise<void> }).transferAndDeploy = async () => undefined;
    const [a, b] = await Promise.all([installer.install('box'), installer.install('user@host:22')]);
    expect(a.error).toContain('stopped and removed');
    expect(b.error).toContain('stopped and removed');
    const probes = commands.flatMap((c, i) => (c === AGENT_PRESENCE_COMMAND ? [i] : []));
    expect(probes[1]).toBeGreaterThan(commands.findIndex((c) => c.includes('cleanup() {')));
  });

  it('makes a recovery wait for an install of the same host', async () => {
    const { ssh, commands } = makeSsh({ tmux: 'tmux 3.4\n' });
    const installer = new AgentInstaller(ssh as never, makeBundler() as never, DEFAULT_WINDOWS_AGENT_OPTIONS, undefined);
    const gate: { release?: () => void } = {};
    (installer as unknown as { transferAndDeploy: () => Promise<void> }).transferAndDeploy = () => new Promise<void>((resolve) => { gate.release = resolve; });
    const install = installer.install('user@host');
    const recovered = installer.recoverAgent('user@host', '100.64.0.9', 'tok', { platform: 'linux', arch: 'x64' }).then(() => commands.length);
    await new Promise((r) => setTimeout(r, 50));
    const before = commands.length;
    expect(commands.some((c) => c.includes('systemctl --user enable'))).toBe(false);
    gate.release!();
    await install;
    expect(await recovered).toBeGreaterThan(before);
  });

  it('gives the cleanup script a timeout of its own, longer than the unit\'s stop time', async () => {
    const { installer } = make(NO_MISAO, { tmux: '' });
    await installer.install('user@host');
    const exec = (installer as unknown as { sshClient: { execIsolated: { mock: { calls: unknown[][] } } } }).sshClient.execIsolated;
    const call = exec.mock.calls.find((c) => String(c[1]).includes('cleanup() {'))!;
    expect(call[2]).toBeGreaterThanOrEqual(100_000);
  });

  it('does not make installs to different hosts wait for each other', async () => {
    const gate: { release?: () => void } = {};
    const blocked = new Promise<void>((resolve) => { gate.release = resolve; });
    const { ssh: sshA } = makeSsh({ tmux: '' });
    const installerA = new AgentInstaller(sshA as never, makeBundler() as never, DEFAULT_WINDOWS_AGENT_OPTIONS, undefined);
    (installerA as unknown as { transferAndDeploy: () => Promise<void> }).transferAndDeploy = () => blocked;
    const first = installerA.install('user@one');
    const second = installerA.install('user@two');
    // user@two is not held up by user@one, which is stuck in its transfer.
    (installerA as unknown as { transferAndDeploy: () => Promise<void> }).transferAndDeploy = async () => undefined;
    expect((await second).error).toContain('stopped and removed');
    gate.release!();
    await first;
  });

  it('reports what is left, and how to remove it, when the folder cannot be removed', async () => {
    const { installer } = make(NO_MISAO, { tmux: '', cleanupResult: 'NOT_REMOVED:~/.azito/agent' });
    const result = await installer.install('user@host');
    expect(result.success).toBe(false);
    expect(result.error).toContain('was stopped, but not fully removed (could not remove ~/.azito/agent)');
    expect(result.error).toContain('Remove what is left on user@host by hand: rm -f ~/.config/systemd/user/azito-agent.service; rm -rf ~/.azito/agent');
  });

  it('reports a cleanup that could not be run at all, or whose end is not known (a timeout), and keeps everything', async () => {
    const { installer } = make(NO_MISAO, { tmux: '', failCommand: /cleanup\(\) \{/ });
    const result = await installer.install('user@host');
    expect(result.error).toContain('could not be checked or removed (Permission denied); it may still be running on user@host, and the removal script may still be running there');
    expect(result.error).toContain('systemctl --user is-active azito-agent');
  });

  it('shows the tmux version when the host has one', async () => {
    const { installer } = make(undefined, { tmux: 'tmux 3.4\n' });
    const steps: InstallProgress[] = [];
    await installer.install('user@host', (p) => steps.push(p));
    expect(steps.find((s) => s.step === 'preflight' && s.status === 'ok')?.message).toContain('tmux tmux 3.4');
  });

  it('puts misao on the agent once it is healthy, through a transport to that agent with the new token', async () => {
    const misao = okMisao();
    const { installer } = make(misao);
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));

    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('misaoError');
    expect(misao.install).toHaveBeenCalledTimes(1);
    const transport = misao.install.mock.calls[0][0] as { matchesToken(token: string): boolean };
    expect(transport.matchesToken(result.token)).toBe(true);
    expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      'preflight:running', 'preflight:ok', 'transfer:running', 'transfer:ok', 'start:running', 'start:ok',
      'health:running', 'health:ok', 'misao:running', 'misao:running', 'misao:ok',
    ]);
    expect(steps.filter((s) => s.step === 'misao').map((s) => s.message)).toEqual(['Installing misao...', 'Transferring misao...', 'misao 0.2.0 (systemd)']);
    expect(steps.at(-1)?.message).toBe('misao 0.2.0 (systemd)');
  });

  it('keeps the agent installed and reports why when misao could not be installed', async () => {
    const misao: AgentMisaoInstaller = { install: vi.fn(async () => { throw new Error('The agent has no node-pty'); }) };
    const { installer } = make(misao, { tmux: 'tmux 3.4\n' });
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));

    expect(result.success).toBe(true);
    expect(result.misaoError).toBe('The agent has no node-pty');
    expect(steps.at(-1)).toEqual({ step: 'misao', status: 'error', message: 'The agent has no node-pty' });
  });

  it('installs without a misao step when the hub has no misao to install', async () => {
    const { installer } = make(undefined, { tmux: 'tmux 3.4\n' });
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));
    expect(result.success).toBe(true);
    expect(steps.some((s) => s.step === 'misao')).toBe(false);
  });

  it('does not install misao on an agent that failed its health check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);
    const misao = okMisao();
    const { installer } = make(misao);
    const nowSpy = vi.spyOn(Date, 'now');
    let t = 0;
    nowSpy.mockImplementation(() => (t += 10_000));
    const result = await installer.install('user@host');
    expect(result.success).toBe(false);
    expect(misao.install).not.toHaveBeenCalled();
  });

  it('tells the agent where its misao socket is (systemd unit)', async () => {
    const { installer, commands } = make(undefined, { tmux: 'tmux 3.4\n' });
    await installer.install('user@host');
    const unit = commands.find((c) => c.includes('azito-agent.service <<'));
    expect(unit).toContain('Environment=MISAO_SOCKET=%h/.azito/misao/misao.sock');
  });

  it('never stops, restarts or reconfigures the misao daemon when the agent is updated', async () => {
    const misao = okMisao();
    const { installer, commands } = make(misao);
    const result = await installer.update('user@host', '100.64.0.9', 'tok', null, 'system');
    expect(result).toEqual({ success: true, version: VERSION });
    expect(misao.install).not.toHaveBeenCalled();
    // The agent is stopped and started by its own unit and process name; the daemon has its own unit and a different process.
    const text = commands.join('\n');
    expect(text).not.toMatch(/azito-misao/);
    expect(text).not.toMatch(/pkill[^\n]*misao/);
    expect(text).toContain('pkill -f azito-agent.cjs');
  });

  it('refuses to update a win32 agent with the Unix bootstrap, with the unsupported_os reason and nothing sent', async () => {
    const { installer, commands } = make(okMisao());
    const result = await installer.update('user@host', '100.64.0.9', 'tok', { platform: 'win32', arch: 'x64' }, 'system');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^unsupported_os: .*updating the agent over SSH/);
    expect(commands).toEqual([]);
  });

  describe('host OS / architecture preflight', () => {
    it('reads the host with a fixed node command, not uname', async () => {
      const { installer, commands } = make(okMisao(), { tmux: 'tmux 3.4' });
      await installer.install('user@host');
      expect(HOST_PROBE_COMMAND).toBe(`node -p "process.platform+' '+process.arch"`);
      expect(commands).toContain(HOST_PROBE_COMMAND);
      expect(commands).not.toContain('uname -m');
    });

    it('returns the profile it read on success, and hands it to the misao installer\'s transport', async () => {
      const misao = okMisao();
      const { installer } = make(misao, { tmux: 'tmux 3.4' });
      const result = await installer.install('user@host');
      expect(result.success).toBe(true);
      expect(result.hostProfile).toEqual({ platform: 'linux', arch: 'x64' });
      expect((misao.install.mock.calls[0][0] as { hostProfile: unknown }).hostProfile).toEqual({ platform: 'linux', arch: 'x64' });
    });

    it('still accepts only x64: darwin arm64 is a known host that is refused as before', async () => {
      const { installer } = make(okMisao(), { tmux: 'tmux 3.4', probe: 'darwin arm64\n' });
      const result = await installer.install('user@host');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/x86_64 architecture required \(found: arm64\)/);
    });

    it('accepts darwin x64', async () => {
      const { installer } = make(okMisao(), { tmux: 'tmux 3.4', probe: 'darwin x64\n' });
      const result = await installer.install('user@host');
      expect(result.success).toBe(true);
      expect(result.hostProfile).toEqual({ platform: 'darwin', arch: 'x64' });
    });

    it('refuses a Windows host as unsupported_os (installing there is #369)', async () => {
      const { installer, commands } = make(okMisao(), { tmux: 'tmux 3.4', probe: 'win32 x64\n' });
      const result = await installer.install('user@host');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unsupported_os/);
      expect(commands.some((c) => c.includes('tar') || c.includes('nohup'))).toBe(false);
    });

    it('refuses an OS AZITO does not know as unsupported_host', async () => {
      const { installer } = make(okMisao(), { tmux: 'tmux 3.4', probe: 'freebsd x64\n' });
      const result = await installer.install('user@host');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unsupported_host/);
    });

    it('reports an unreadable answer instead of guessing a host', async () => {
      const { installer } = make(okMisao(), { tmux: 'tmux 3.4', probe: '' });
      const result = await installer.install('user@host');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Could not read the host OS and architecture/);
    });
  });

  describe('OS detection and the Windows preflight', () => {
    const windowsOutput = (over: Record<string, unknown> = {}) => `banner\n<<AZITO_PREFLIGHT_BEGIN>>\n${JSON.stringify({
      nodePath: 'C:\\node.exe', nodeVersion: 'v24.14.0', arch: 'AMD64', windowsCaption: 'Microsoft Windows 11 Pro', buildNumber: '22631', tailscaleIp: '100.64.0.9', home: 'C:\\Users\\d', systemRoot: 'C:\\Windows', userId: 'PC\\d', ...over,
    })}\n<<AZITO_PREFLIGHT_END>>\n`;

    function makeWindows(login: 'cmd' | 'powershell', over: Record<string, unknown> = {}) {
      const commands: string[] = [];
      const osAnswer = login === 'cmd' ? 'AZITO_OS:Windows_NT:$?\r\n' : 'AZITO_OS:%OS%:True\r\n';
      const execIsolated = vi.fn(async (_host: string, command: string) => {
        commands.push(command);
        if (command === HOST_OS_PROBE_COMMAND) return { stdout: osAnswer, stderr: '', code: 0 };
        if (command === buildWindowsPreflightCommand()) return { stdout: windowsOutput(over), stderr: '', code: 0 };
        throw new Error(`unexpected command on a Windows host: ${command}`);
      });
      const installer = new AgentInstaller({ execIsolated, resolveHost: (h: string) => ({ username: 'user', host: h.replace(/^.*@/, '').replace(/:\d+$/, ''), port: 22 }) } as never, makeBundler() as never, DEFAULT_WINDOWS_AGENT_OPTIONS, okMisao());
      return { installer, commands };
    }

    it('sends the OS probe first, then the usual Unix probes unchanged', async () => {
      const { installer, commands } = make(okMisao(), { tmux: 'tmux 3.4' });
      await installer.install('user@host');
      expect(commands.slice(0, 3)).toEqual([HOST_OS_PROBE_COMMAND, 'node --version', HOST_PROBE_COMMAND]);
      expect(commands).toContain('tmux -V');
      expect(commands).toContain('tailscale ip -4');
    });

    it('fails the preflight of a Windows host with every reason: old Node, arm64, no Tailscale', async () => {
      const { installer } = makeWindows('cmd', { nodeVersion: 'v22.0.0', arch: 'ARM64', tailscaleIp: null });
      const result = await installer.install('user@host');
      expect(result.error).toContain('Node.js v24+ required (found: v22.0.0)');
      expect(result.error).toContain('x86_64 architecture required (found: arm64');
      expect(result.error).toContain('Tailscale IP not found');
      expect(result.error).not.toContain('unsupported_os');
    });

    it('refuses a Windows host whose native architecture cannot be read, with the reason', async () => {
      const { installer } = makeWindows('powershell', { arch: null });
      const result = await installer.install('user@host');
      expect(result.error).toContain('Could not read the OS architecture');
    });

    it('fails with a reason, and sends nothing else, when the OS probe answers as none of sh, cmd or PowerShell', async () => {
      const commands: string[] = [];
      const execIsolated = vi.fn(async (_host: string, command: string) => { commands.push(command); return { stdout: 'weird\n', stderr: '', code: 0 }; });
      const installer = new AgentInstaller({ execIsolated, resolveHost: (h: string) => ({ username: 'user', host: h.replace(/^.*@/, '').replace(/:\d+$/, ''), port: 22 }) } as never, makeBundler() as never, DEFAULT_WINDOWS_AGENT_OPTIONS, okMisao());
      const result = await installer.install('user@host');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Could not tell the host's OS/);
      expect(commands).toEqual([HOST_OS_PROBE_COMMAND]);
    });
  });
});
