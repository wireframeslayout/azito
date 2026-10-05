import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
function makeSsh(opts: { tmux?: string } = {}) {
  const commands: string[] = [];
  const execIsolated = vi.fn(async (_host: string, command: string) => {
    commands.push(command);
    const answers: Record<string, string> = {
      'node --version': 'v24.14.0\n',
      'uname -m': 'x86_64\n',
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

  function make(misao?: AgentMisaoInstaller, sshOpts: { tmux?: string } = {}) {
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

  it('does not require tmux: a host without it passes the preflight', async () => {
    const { installer } = make(undefined, { tmux: '' });
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));
    expect(result.success).toBe(true);
    expect(steps.find((s) => s.step === 'preflight' && s.status === 'ok')?.message).toContain('no tmux (optional)');
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
    const { installer } = make(misao);
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@host', (p) => steps.push(p));

    expect(result.success).toBe(true);
    expect(result.misaoError).toBe('The agent has no node-pty');
    expect(steps.at(-1)).toEqual({ step: 'misao', status: 'error', message: 'The agent has no node-pty' });
  });

  it('installs without a misao step when the hub has no misao to install', async () => {
    const { installer } = make(undefined);
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
    const { installer, commands } = make(undefined);
    await installer.install('user@host');
    const unit = commands.find((c) => c.includes('azito-agent.service <<'));
    expect(unit).toContain('Environment=MISAO_SOCKET=%h/.azito/misao/misao.sock');
  });

  it('never stops, restarts or reconfigures the misao daemon when the agent is updated', async () => {
    const misao = okMisao();
    const { installer, commands } = make(misao);
    const result = await installer.update('user@host', '100.64.0.9', 'tok', 'system');
    expect(result).toEqual({ success: true, version: VERSION });
    expect(misao.install).not.toHaveBeenCalled();
    // The agent is stopped and started by its own unit and process name; the daemon has its own unit and a different process.
    const text = commands.join('\n');
    expect(text).not.toMatch(/azito-misao/);
    expect(text).not.toMatch(/pkill[^\n]*misao/);
    expect(text).toContain('pkill -f azito-agent.cjs');
  });
});
