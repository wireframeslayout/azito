import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_PROBE_COMMAND } from '../../../shared/os/hostProfile';
import { HOST_OS_PROBE_COMMAND } from './hostOsProbe';
import { buildWindowsPreflightCommand } from './windowsPreflight';
import { AgentInstaller, type AgentMisaoInstaller, type InstallProgress } from './AgentInstaller';

const VERSION = 'bundlehash1';

function makeBundler() {
  return {
    ensureBuild: vi.fn(async () => undefined),
    getBundleHash: vi.fn(() => VERSION),
    getTarballPath: vi.fn(() => '/tmp/fake.tar.gz'),
    getSha256sumsPath: vi.fn(() => '/tmp/SHA256SUMS'),
  };
}

/** An SSH client whose host answers the preflight and accepts every other command, recording them all. */
function makeSsh(opts: { tmux?: string; probe?: string } = {}) {
  const commands: string[] = [];
  const execIsolated = vi.fn(async (_host: string, command: string) => {
    commands.push(command);
    const answers: Record<string, string> = {
      [HOST_OS_PROBE_COMMAND]: 'AZITO_OS:%OS%::OS\n',
      'node --version': 'v24.14.0\n',
      [HOST_PROBE_COMMAND]: opts.probe ?? 'linux x64\n',
      'tmux -V': opts.tmux ?? '',
      'tailscale ip -4': '100.64.0.9\n',
    };
    return { stdout: answers[command] ?? '', stderr: '', code: 0 };
  });
  return { ssh: { execIsolated }, commands };
}

describe('AgentInstaller', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: VERSION }) })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function make(misao?: AgentMisaoInstaller, sshOpts: { tmux?: string; probe?: string } = {}) {
    const { ssh, commands } = makeSsh(sshOpts);
    const installer = new AgentInstaller(ssh as never, makeBundler() as never, misao);
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

  it('fails as before, asking for tmux, when the host has no tmux and this hub has no misao to install', async () => {
    const { installer } = make(undefined, { tmux: '' });
    const result = await installer.install('user@host');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tmux is required/);
  });

  it('fails when the host has no tmux and misao could not be installed on it', async () => {
    const misao: AgentMisaoInstaller = { install: vi.fn(async () => { throw new Error('no node-pty'); }) };
    const { installer } = make(misao, { tmux: '' });
    const result = await installer.install('user@host');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tmux is required.*no node-pty/);
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
      nodePath: 'C:\\node.exe', nodeVersion: 'v24.14.0', arch: 'X64', windowsMajor: 10, windowsBuild: 26100, tailscaleIp: '100.64.0.9', home: 'C:\\Users\\d', ...over,
    })}\n<<AZITO_PREFLIGHT_END>>\n`;

    function makeWindows(login: 'cmd' | 'powershell', over: Record<string, unknown> = {}) {
      const commands: string[] = [];
      const osAnswer = login === 'cmd' ? 'AZITO_OS:Windows_NT:$env:OS\r\n' : 'AZITO_OS:%OS%:Windows_NT\r\n';
      const execIsolated = vi.fn(async (_host: string, command: string) => {
        commands.push(command);
        if (command === HOST_OS_PROBE_COMMAND) return { stdout: osAnswer, stderr: '', code: 0 };
        if (command === buildWindowsPreflightCommand()) return { stdout: windowsOutput(over), stderr: '', code: 0 };
        throw new Error(`unexpected command on a Windows host: ${command}`);
      });
      const installer = new AgentInstaller({ execIsolated } as never, makeBundler() as never, okMisao());
      return { installer, commands };
    }

    it('sends the OS probe first, then the usual Unix probes unchanged', async () => {
      const { installer, commands } = make(okMisao(), { tmux: 'tmux 3.4' });
      await installer.install('user@host');
      expect(commands.slice(0, 3)).toEqual([HOST_OS_PROBE_COMMAND, 'node --version', HOST_PROBE_COMMAND]);
      expect(commands).toContain('tmux -V');
      expect(commands).toContain('tailscale ip -4');
    });

    it.each(['cmd', 'powershell'] as const)('runs the PowerShell preflight on a Windows host with a %s login shell, then stops with unsupported_os and stores no profile', async (login) => {
      const { installer, commands } = makeWindows(login);
      const steps: InstallProgress[] = [];
      const result = await installer.install('user@host', (p) => steps.push(p));
      expect(commands).toEqual([HOST_OS_PROBE_COMMAND, buildWindowsPreflightCommand()]);
      expect(result.success).toBe(false);
      expect(result.hostProfile).toBeUndefined();
      expect(result.error).toMatch(/Windows 11 x64, Node 24\.14\.0, Tailscale 100\.64\.0\.9: unsupported_os: installing the agent on a Windows host is not supported yet/);
      expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual(['preflight:running', 'preflight:error']);
      expect(steps[1].message).toBe(result.error);
    });

    it('fails the preflight of a Windows host with every reason: old Node, arm64, no Tailscale', async () => {
      const { installer } = makeWindows('cmd', { nodeVersion: 'v22.0.0', arch: 'Arm64', tailscaleIp: null });
      const result = await installer.install('user@host');
      expect(result.error).toContain('Node.js v24+ required (found: v22.0.0)');
      expect(result.error).toContain('x86_64 architecture required (found: arm64');
      expect(result.error).toContain('Tailscale IP not found');
      expect(result.error).not.toContain('unsupported_os');
    });

    it('fails with a reason, and sends nothing else, when the OS probe answers as none of sh, cmd or PowerShell', async () => {
      const commands: string[] = [];
      const execIsolated = vi.fn(async (_host: string, command: string) => { commands.push(command); return { stdout: 'weird\n', stderr: '', code: 0 }; });
      const installer = new AgentInstaller({ execIsolated } as never, makeBundler() as never, okMisao());
      const result = await installer.install('user@host');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Could not tell the host's OS/);
      expect(commands).toEqual([HOST_OS_PROBE_COMMAND]);
    });
  });
});
