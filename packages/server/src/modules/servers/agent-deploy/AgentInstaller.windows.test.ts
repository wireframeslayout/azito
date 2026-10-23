import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEncodedCommand, FakeWindowsHost, type FakeWindowsHostOptions } from './testing/fakeWindowsHost';
import { AgentInstaller, type InstallProgress } from './AgentInstaller';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, type WindowsAgentOptions } from './windowsAgentConfig';

const VERSION = 'bundlehash1';
const SHA = 'a'.repeat(64);

let sumsFile: string;

function makeBundler() {
  return {
    ensureBuild: vi.fn(async () => undefined),
    getBundleHash: vi.fn(() => VERSION),
    getTarballPath: vi.fn(() => __filename),
    getSha256sumsPath: vi.fn(() => sumsFile),
  };
}

type SftpFake = { sftpUpload: (host: string, local: string, remote: string) => Promise<void>; sftpWrite: (host: string, data: Buffer, remote: string) => Promise<void> };

function make(hostOptions: Partial<FakeWindowsHostOptions> = {}, windowsAgent: WindowsAgentOptions = DEFAULT_WINDOWS_AGENT_OPTIONS) {
  const host = new FakeWindowsHost({ sha256: SHA, taskName: windowsAgent.taskName, ...hostOptions });
  const execIsolated = vi.fn(async (sshHost: string, command: string) => host.exec(sshHost, command));
  const installer = new AgentInstaller({ execIsolated } as never, makeBundler() as never, windowsAgent, undefined);
  const sftp = installer as unknown as SftpFake;
  const uploads: string[] = [];
  sftp.sftpUpload = async (_h, _local, remote) => { uploads.push(remote); host.uploaded.set(remote, Buffer.from('tarball')); };
  sftp.sftpWrite = async (_h, data, remote) => { uploads.push(remote); host.uploaded.set(remote, data); };
  return { installer, host, uploads };
}

beforeEach(async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  sumsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-sums-')), 'SHA256SUMS');
  fs.writeFileSync(sumsFile, `${SHA}  azito-agent.tar.gz\n`);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: VERSION }) })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AgentInstaller on a Windows host', () => {
  it('transfers, verifies, extracts, writes owner-only settings, registers the logon task, starts it and checks health', async () => {
    const { installer, host, uploads } = make();
    const steps: InstallProgress[] = [];
    const result = await installer.install('user@win', (p) => steps.push(p));

    expect(result).toMatchObject({ success: true, host: '100.64.0.9', port: 3002, version: VERSION, startMethod: 'taskscheduler', tmuxFound: false, hostProfile: { platform: 'win32', arch: 'x64' } });
    expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      'preflight:running', 'preflight:ok', 'transfer:running', 'transfer:ok', 'start:running', 'start:ok', 'health:running', 'health:ok', 'misao:ok',
    ]);
    // misao is not installed on Windows yet: the step says so and the reason travels beside the successful result.
    expect(steps.at(-1)!.message).toMatch(/Skipped: unsupported_os.*misao.*Windows/);
    expect(result.misaoError).toMatch(/^unsupported_os:/);

    // Files go over SFTP into the owner-only folder under the home: the bundle, the settings, the task XML.
    expect(uploads).toEqual([`.azito/agent/azito-agent-${VERSION}.tar.gz`, '.azito/agent/agent.env', '.azito/agent/AzitoAgent.task.xml']);
    const env = host.uploaded.get('.azito/agent/agent.env')!.toString('utf8');
    expect(env).toBe(`AZITO_AGENT_TOKEN=${result.token}\nAZITO_AGENT_BIND=100.64.0.9\nPORT=3002\nAZITO_AGENT_LOG_FILE=C:\\Users\\dev\\.azito\\agent\\agent.log\n`);

    const scripts = host.calls.filter((c) => c.kind === 'script').map((c) => c.text);
    expect(scripts[0]).toContain("New-Item -ItemType Directory -Force -Path 'C:\\Users\\dev\\.azito\\agent'");
    expect(scripts[0]).toContain('PurgeAccessRules'); // the folder is made owner-only before anything is put in it
    expect(scripts.some((s) => s.includes("[System.IO.File]::OpenRead('C:\\Users\\dev\\.azito\\agent\\azito-agent-bundlehash1.tar.gz')"))).toBe(true);
    const extract = scripts.find((s) => s.includes('tar.exe'))!;
    expect(extract).toContain("$tar = 'C:\\Windows\\System32\\tar.exe'");
    expect(extract).toContain("$dest = 'C:\\Users\\dev\\.azito\\agent\\bundlehash1'");
    expect(scripts.filter((s) => s.includes("$env:AZITO_GUARD_PATH = 'C:\\Users\\dev\\.azito\\agent\\agent.env'")).length).toBe(2); // protect, then inspect
    // The token is only ever in the SFTP-written file: no script (and so no command line) carries it.
    expect(JSON.stringify(host.calls)).not.toContain(result.token);

    // The task: logon trigger for the SSH user, node.exe --env-file=<settings> <entry>, working folder = the version folder.
    expect(host.registeredXml).toContain('<UserId>PC\\dev</UserId>');
    expect(host.registeredXml).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>');
    expect(host.registeredXml).toContain('<Arguments>--env-file=C:\\Users\\dev\\.azito\\agent\\agent.env C:\\Users\\dev\\.azito\\agent\\bundlehash1\\azito-agent.cjs</Arguments>');
    expect(host.registeredXml).toContain('<WorkingDirectory>C:\\Users\\dev\\.azito\\agent\\bundlehash1</WorkingDirectory>');
    expect(host.registeredXml).toContain('<LogonTrigger>');
    const schtasks = host.calls.filter((c) => c.kind === 'schtasks').map((c) => c.schtasksArgs![0]);
    expect(schtasks.indexOf('/Create')).toBeGreaterThan(-1);
    expect(schtasks.indexOf('/Run')).toBeGreaterThan(schtasks.indexOf('/Create'));
    expect(host.taskState).toBe('running');
  });

  it('never sends the POSIX bootstrap (tar, nohup, systemctl, a sha256sum pipeline) to a Windows host', async () => {
    const { installer, host } = make();
    await installer.install('user@win');
    const texts = host.calls.map((c) => c.text).join('\n');
    expect(texts).not.toMatch(/nohup|systemctl|sha256sum|\/bin\/sh|mktemp/);
  });

  it('stops the task of an earlier install before it unpacks over the files that task has open', async () => {
    const { installer, host } = make({ existingTask: 'running' });
    const result = await installer.install('user@win');
    expect(result.success).toBe(true);
    const order = host.calls.flatMap((c) => c.kind === 'schtasks' ? [`schtasks ${c.schtasksArgs![0]}`] : c.kind === 'script' && c.text.includes('tar.exe') ? ['extract'] : []);
    expect(order.indexOf('schtasks /End')).toBeGreaterThan(-1);
    expect(order.indexOf('schtasks /End')).toBeLessThan(order.indexOf('extract'));
    expect(order.indexOf('extract')).toBeLessThan(order.indexOf('schtasks /Create'));
  });

  it('uses the configured task name, folder and port', async () => {
    const { installer, host, uploads } = make({}, { taskName: 'w806-AzitoAgent', dir: 'w806-agent', port: 3902 });
    const result = await installer.install('user@win');
    expect(result).toMatchObject({ success: true, port: 3902 });
    expect(uploads).toEqual([`w806-agent/azito-agent-${VERSION}.tar.gz`, 'w806-agent/agent.env', 'w806-agent/w806-AzitoAgent.task.xml']);
    expect(host.uploaded.get('w806-agent/agent.env')!.toString('utf8')).toContain('PORT=3902\n');
    expect(host.calls.filter((c) => c.kind === 'schtasks').some((c) => c.schtasksArgs!.includes('w806-AzitoAgent'))).toBe(true);
    expect(host.calls.find((c) => c.kind === 'firewall')!.text).toContain('$port = 3902');
    expect(fetch).toHaveBeenCalledWith('http://100.64.0.9:3902/health', expect.anything());
  });

  describe('Windows Firewall', () => {
    it('stops before anything is transferred, with the reason and the command, when no rule allows the port and the session is not elevated', async () => {
      const { installer, host, uploads } = make({ firewall: { ruleFound: false, elevated: false, created: false, problem: null } });
      const steps: InstallProgress[] = [];
      const result = await installer.install('user@win', (p) => steps.push(p));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Windows Firewall has no enabled inbound rule that allows TCP 3002');
      expect(result.error).toContain('not elevated');
      expect(result.error).toContain('New-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3002 -RemoteAddress 100.64.0.0/10');
      expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual(['preflight:running', 'preflight:error']);
      expect(uploads).toEqual([]);
      expect(host.calls.some((c) => c.kind === 'script')).toBe(false);
    });

    it('goes on when the rule was just added by an elevated session', async () => {
      const { installer } = make({ firewall: { ruleFound: false, elevated: true, created: true, problem: null } });
      expect((await installer.install('user@win')).success).toBe(true);
    });

    it('says the host refused when an elevated session could not add the rule', async () => {
      const { installer } = make({ firewall: { ruleFound: false, elevated: true, created: false, problem: 'Access is denied' } });
      const result = await installer.install('user@win');
      expect(result.error).toContain('the host refused (Access is denied)');
    });

    it('goes on, leaving the health check to prove it, when the host cannot say whether a rule exists', async () => {
      const { installer } = make({ firewall: { ruleFound: null, elevated: false, created: false, problem: null } });
      expect((await installer.install('user@win')).success).toBe(true);
    });
  });

  describe('failures', () => {
    it('reports a SHA256 mismatch, removes the uploaded bundle and registers nothing', async () => {
      const { installer, host } = make({ sha256: 'b'.repeat(64) });
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toContain(`SHA256 mismatch: expected ${SHA}, got ${'b'.repeat(64)}`);
      const removals = host.calls.filter((c) => c.kind === 'script' && c.text.includes('Remove-Item') && c.text.includes('.tar.gz'));
      expect(removals.length).toBeGreaterThan(0);
      expect(host.calls.some((c) => c.kind === 'schtasks' && c.schtasksArgs![0] === '/Create')).toBe(false);
    });

    it('cleans up the uploaded bundle, the scratch folder and the task XML when unpacking fails, and says why', async () => {
      const { installer, host } = make({ failScript: { containing: 'tar.exe', stderr: '#< CLIXML\n<Objs><S S="Error">The bundle has an unsafe path: ../x_x000D__x000A_</S></Objs>' } });
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Extracting the agent bundle failed on the Windows host');
      expect(result.error).toContain('The bundle has an unsafe path: ../x');
      const cleanup = host.calls.filter((c) => c.kind === 'script').at(-1)!.text;
      expect(cleanup).toContain('azito-agent-bundlehash1.tar.gz');
      expect(cleanup).toContain('.extract-bundlehash1');
      expect(cleanup).toContain('AzitoAgent.task.xml');
    });

    it('refuses a settings file that others can read (fail closed), and does not register the task', async () => {
      const { installer, host } = make();
      const original = host.exec;
      (host as { exec: typeof host.exec }).exec = async (h, command) => {
        if (command.includes('-EncodedCommand') && decodeEncodedCommand(command).includes('ConvertTo-Json -Depth 4')) {
          const sid = 'S-1-5-21-1-2-3-1001';
          return { stdout: JSON.stringify({ currentSid: sid, ownerSid: sid, entries: [{ sid, name: 'PC\\dev', type: 'Allow', inherited: false }, { sid: 'S-1-5-32-545', name: 'BUILTIN\\Users', type: 'Allow', inherited: true }] }), stderr: '', code: 0 };
        }
        return original(h, command);
      };
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toContain('readable by others');
      expect(result.error).toContain('BUILTIN\\Users');
      expect(host.calls.some((c) => c.kind === 'schtasks' && c.schtasksArgs![0] === '/Create')).toBe(false);
    });

    it('stops the task and names the likely reasons when the agent never answers (the user is not logged on)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ETIMEDOUT'); }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        const { installer, host } = make({ runResult: 0x8004130f });
        const pending = installer.install('user@win');
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await pending;
        expect(result.success).toBe(false);
        expect(result.error).toContain('Health check timed out: connect ETIMEDOUT');
        expect(result.error).toContain('is not running (last result 0x8004130f: the user is not logged on');
        expect(result.error).toContain('Windows Firewall allows TCP 3002');
        expect(result.error).toContain('C:\\Users\\dev\\.azito\\agent\\agent.log');
        expect(host.taskState).not.toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('restarting an agent that is registered', () => {
    it('recoverAgent restarts the logon task (stop if running, then start) and does not use the POSIX bootstrap', async () => {
      const { installer, host } = make({ existingTask: 'running' });
      await expect(installer.recoverAgent('user@win', '100.64.0.9', 'tok', { platform: 'win32', arch: 'x64' })).resolves.toBe('taskscheduler');
      const schtasks = host.calls.filter((c) => c.kind === 'schtasks').map((c) => c.schtasksArgs![0]);
      expect(schtasks).toEqual(expect.arrayContaining(['/Query', '/End', '/Run']));
      expect(schtasks.indexOf('/End')).toBeLessThan(schtasks.indexOf('/Run'));
      expect(host.calls.map((c) => c.text).join('\n')).not.toMatch(/nohup|systemctl|pkill/);
    });

    it('recoverAgent fails with a reason when no task is registered', async () => {
      const { installer } = make();
      await expect(installer.recoverAgent('user@win', '100.64.0.9', 'tok', { platform: 'win32', arch: 'x64' })).rejects.toThrow(/is not registered on the host: install the agent first/);
    });

    it('update() of a Windows agent is still refused with unsupported_os (#372) and sends nothing', async () => {
      const { installer, host } = make();
      const result = await installer.update('user@win', '100.64.0.9', 'tok', { platform: 'win32', arch: 'x64' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^unsupported_os:/);
      expect(host.calls).toEqual([]);
    });
  });
});
