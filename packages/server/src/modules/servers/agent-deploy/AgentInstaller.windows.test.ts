import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEncodedCommand, FakeWindowsHost, type FakeWindowsHostOptions } from './testing/fakeWindowsHost';
import { AgentInstaller, type AgentMisaoInstaller, type InstallProgress } from './AgentInstaller';
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

function make(hostOptions: Partial<FakeWindowsHostOptions> = {}, windowsAgent: WindowsAgentOptions = DEFAULT_WINDOWS_AGENT_OPTIONS, misao?: AgentMisaoInstaller) {
  const host = new FakeWindowsHost({ sha256: SHA, taskName: windowsAgent.taskName, ...hostOptions });
  const execIsolated = vi.fn(async (sshHost: string, command: string) => host.exec(sshHost, command));
  const installer = new AgentInstaller({ execIsolated, resolveHost: (h: string) => ({ username: 'user', host: h.replace(/^.*@/, '').replace(/:\d+$/, ''), port: 22 }) } as never, makeBundler() as never, windowsAgent, misao);
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
      'preflight:running', 'preflight:ok', 'transfer:running', 'transfer:ok', 'start:running', 'start:ok', 'health:running', 'health:ok',
    ]);
    // This hub has no misao to install (none was given): there is no misao step and no error about it.
    expect(result).not.toHaveProperty('misaoError');

    // Files go over SFTP into the owner-only folder under the home: the bundle, the settings, the task XML.
    // The settings are written into agent.env.new, which was created owner-only first, and swapped in after its ACL was checked.
    expect(uploads).toEqual([`.azito/agent/azito-agent-${VERSION}.tar.gz`, '.azito/agent/agent.env.new', '.azito/agent/AzitoAgent.task.xml']);
    const env = host.uploaded.get('.azito/agent/agent.env.new')!.toString('utf8');
    expect(env).toBe(`AZITO_AGENT_TOKEN="${result.token}"\nAZITO_AGENT_BIND="100.64.0.9"\nPORT="3002"\nAZITO_AGENT_LOG_FILE="C:\\Users\\dev\\.azito\\agent\\agent.log"\nAZITO_AGENT_EXIT_WITH_PARENT="1"\n`);

    const scripts = host.calls.filter((c) => c.kind === 'script').map((c) => c.text);
    expect(scripts[0]).toContain("New-Item -ItemType Directory -Force -Path 'C:\\Users\\dev\\.azito\\agent'");
    expect(scripts[0]).toContain('PurgeAccessRules'); // the folder is made owner-only before anything is put in it
    expect(scripts.some((s) => s.includes("[System.IO.File]::OpenRead('C:\\Users\\dev\\.azito\\agent\\azito-agent-bundlehash1.tar.gz')"))).toBe(true);
    const extract = scripts.find((s) => s.includes('tar.exe'))!;
    expect(extract).toContain("$tar = 'C:\\Windows\\System32\\tar.exe'");
    expect(extract).toContain("$dest = 'C:\\Users\\dev\\.azito\\agent\\bundlehash1'");
    const guarded = scripts.filter((s) => s.includes("$env:AZITO_GUARD_PATH = 'C:\\Users\\dev\\.azito\\agent\\agent.env.new'"));
    expect(guarded.length).toBe(2); // create (owner-only, exclusive), then inspect
    expect(guarded[0]).toContain('FileMode]\'CreateNew\'');
    expect(guarded[1]).toContain('ConvertTo-Json -Depth 4');
    // The order on the host: created owner-only, THEN the token is written, then checked, then swapped in.
    const order = host.calls.map((c) => (c.kind === 'script' && c.text.includes('CreateNew') ? 'create' : c.kind === 'script' && c.text.includes('Depth 4') ? 'inspect' : c.kind === 'script' && c.text.includes('Move-Item -LiteralPath \'C:\\Users\\dev\\.azito\\agent\\agent.env.new\'') ? 'swap' : c.kind));
    expect(order.indexOf('create')).toBeLessThan(order.indexOf('inspect'));
    expect(order.indexOf('inspect')).toBeLessThan(order.indexOf('swap'));
    // The token is only ever in the SFTP-written file: no script (and so no command line) carries it.
    expect(JSON.stringify(host.calls)).not.toContain(result.token);

    // The task: logon trigger for the SSH user, node.exe --env-file=<settings> <entry>, working folder = the version folder.
    expect(host.registeredXml).toContain('<UserId>PC\\dev</UserId>');
    // Under conhost --headless: node.exe has a console without a window, so nothing appears on the user's desktop.
    expect(host.registeredXml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(host.registeredXml).toContain('<Arguments>--headless "C:\\Program Files\\nodejs\\node.exe" --env-file=C:\\Users\\dev\\.azito\\agent\\agent.env C:\\Users\\dev\\.azito\\agent\\bundlehash1\\azito-agent.cjs</Arguments>');
    expect(host.registeredXml).toContain('<WorkingDirectory>C:\\Users\\dev\\.azito\\agent\\bundlehash1</WorkingDirectory>');
    expect(host.registeredXml).toContain('<LogonTrigger>');
    const schtasks = host.calls.filter((c) => c.kind === 'schtasks').map((c) => c.schtasksArgs![0]);
    expect(schtasks.indexOf('/Create')).toBeGreaterThan(-1);
    expect(schtasks.indexOf('/Run')).toBeGreaterThan(schtasks.indexOf('/Create'));
    expect(host.taskState).toBe('running');
  });

  describe('misao', () => {
    const okMisao = (): AgentMisaoInstaller & { install: ReturnType<typeof vi.fn> } => ({
      install: vi.fn(async (_transport, onProgress) => {
        onProgress?.('transfer');
        return { version: '0.3.0', startMethod: 'taskscheduler' as const, updateAvailable: false };
      }),
    });

    it('is put on the agent once it is healthy, through a transport to the configured port with the new token and the Windows host profile', async () => {
      const misao = okMisao();
      const { installer } = make({}, { ...DEFAULT_WINDOWS_AGENT_OPTIONS, port: 3902 }, misao);
      const steps: InstallProgress[] = [];
      const result = await installer.install('user@win', (p) => steps.push(p));
      expect(result.success).toBe(true);
      expect(result).not.toHaveProperty('misaoError');
      expect(steps.filter((s) => s.step === 'misao').map((s) => `${s.status}:${s.message}`)).toEqual(['running:Installing misao...', 'running:Transferring misao...', 'ok:misao 0.3.0 (taskscheduler)']);
      const transport = misao.install.mock.calls[0]![0] as { matchesToken(token: string): boolean; hostProfile: unknown; fetchMisaoStatus: unknown };
      expect(transport.matchesToken(result.token)).toBe(true);
      expect(transport.hostProfile).toEqual({ platform: 'win32', arch: 'x64' });
      // The agent of a Windows host listens on its configured port, not the Unix one.
      expect(String((transport as unknown as { baseUrl: string }).baseUrl)).toBe('http://100.64.0.9:3902');
    });

    it('keeps the agent installed and healthy, and reports why, when misao could not be installed', async () => {
      const misao: AgentMisaoInstaller = { install: vi.fn(async () => { throw new Error('The pipe did not open'); }) };
      const { installer } = make({}, DEFAULT_WINDOWS_AGENT_OPTIONS, misao);
      const steps: InstallProgress[] = [];
      const result = await installer.install('user@win', (p) => steps.push(p));
      expect(result).toMatchObject({ success: true, startMethod: 'taskscheduler', tmuxFound: false, misaoError: 'The pipe did not open' });
      expect(steps.at(-1)).toMatchObject({ step: 'misao', status: 'error', message: 'The pipe did not open' });
    });
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
    const { installer, host, uploads } = make({ firewall: { ruleFound: false, elevated: true, created: true, problem: null } }, { taskName: 'w806-AzitoAgent', dir: 'w806-agent', port: 3902, misaoTaskName: 'w806-AzitoMisao', misaoDir: 'w806-misao' });
    const result = await installer.install('user@win');
    expect(result).toMatchObject({ success: true, port: 3902 });
    expect(uploads).toEqual([`w806-agent/azito-agent-${VERSION}.tar.gz`, 'w806-agent/agent.env.new', 'w806-agent/w806-AzitoAgent.task.xml']);
    expect(host.uploaded.get('w806-agent/agent.env.new')!.toString('utf8')).toContain('PORT="3902"\n');
    expect(host.calls.filter((c) => c.kind === 'schtasks').some((c) => c.schtasksArgs!.includes('w806-AzitoAgent'))).toBe(true);
    expect(host.calls.filter((c) => c.kind === 'firewall').some((c) => c.text.includes('-LocalPort 3902'))).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://100.64.0.9:3902/health', expect.anything());
  });

  describe('Windows Firewall', () => {
    it('stops before anything is transferred, with the reason and the command, when no rule allows the port and the session is not elevated', async () => {
      const { installer, host, uploads } = make({ firewall: { ruleFound: false, elevated: false, created: false, problem: null } });
      const steps: InstallProgress[] = [];
      const result = await installer.install('user@win', (p) => steps.push(p));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Windows Firewall has no enabled inbound rule that lets the hub reach the agent (TCP 3002 for C:\\Program Files\\nodejs\\node.exe on 100.64.0.9');
      expect(result.error).toContain('not elevated');
      expect(result.error).toContain('New-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3002 -Program "C:\\Program Files\\nodejs\\node.exe" -LocalAddress 100.64.0.9 -RemoteAddress 100.64.0.0/10');
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

  describe('a failed reinstall puts the previous install back', () => {
    it('restores the previous files, definition and running state when the new agent never answers, and deletes nothing before that', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('401'); }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        const { installer, host } = make({ existingTask: 'running' });
        const pending = installer.install('user@win');
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await pending;
        expect(result.success).toBe(false);
        expect(result.error).toContain('Rolled back:');
        expect(result.error).toContain('restored the version folder');
        expect(result.error).toContain('restored the settings');
        expect(result.error).toContain('restored the previous task definition');
        expect(result.error).toContain('started the previous agent again');
        // The definition on the host is the previous one again, and the previous agent is running.
        expect(host.registeredXml).toBe('<Task>previous definition</Task>');
        expect(host.taskState).toBe('running');
        const scripts = host.calls.filter((c) => c.kind === 'script').map((c) => c.text);
        // The previous folder and settings are moved aside on the way in (never deleted) and moved back on the way out.
        expect(scripts.some((s) => s.includes('Move-Item -LiteralPath $dest -Destination $prev'))).toBe(true);
        expect(scripts.some((s) => s.includes("agent.env' -Destination 'C:\\Users\\dev\\.azito\\agent\\agent.env.prev'"))).toBe(true);
        expect(scripts.some((s) => s.includes("Move-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\agent.env.prev' -Destination 'C:\\Users\\dev\\.azito\\agent\\agent.env'"))).toBe(true);
        // Nothing of the previous install was deleted for good.
        expect(scripts.some((s) => s.includes("Remove-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\agent.env.prev' -Recurse -Force }"))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not start the previous agent when its settings could not be put back, and says what stays set aside', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('401'); }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        const { installer, host } = make({ existingTask: 'running', failScript: { containing: "Move-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\agent.env.prev'", stderr: 'Access is denied' } });
        const pending = installer.install('user@win');
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await pending;
        expect(result.success).toBe(false);
        // The folder restore is independent of the settings restore: it was still tried and worked.
        expect(result.error).toContain('restored the version folder');
        expect(result.error).toContain('restored the settings failed');
        expect(result.error).toContain('the previous agent was NOT started');
        expect(result.error).toContain('agent.env.prev');
        expect(result.error).not.toContain('started the previous agent again');
        expect(host.taskState).not.toBe('running');
        // Nothing deleted the set-aside data.
        expect(host.calls.filter((c) => c.kind === 'script').some((c) => c.text.includes("Remove-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\agent.env.prev'"))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not start the previous agent when its folder could not be put back, but still restores the settings', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('401'); }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        const { installer, host } = make({ existingTask: 'running', failScript: { containing: "Move-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\bundlehash1.prev'", stderr: 'Access is denied' } });
        const pending = installer.install('user@win');
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await pending;
        expect(result.error).toContain('restored the version folder failed');
        expect(result.error).toContain('restored the settings');
        expect(result.error).toContain('the previous agent was NOT started');
        expect(host.taskState).not.toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });

    it('judges the previous install by what it put back: a new version folder that cannot be removed does not stop the previous agent', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('401'); }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        const { installer, host } = make({ existingTask: 'running', scriptOutput: { containing: "Move-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\bundlehash1.prev'", stdout: 'CLEANUP_FAILED The process cannot access the file' } });
        const pending = installer.install('user@win');
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await pending;
        expect(result.success).toBe(false);
        expect(result.error).toContain('could not remove the new version folder this deploy created (The process cannot access the file); the previous install itself is not affected');
        expect(result.error).toContain('started the previous agent again');
        expect(result.error).not.toContain('NOT started');
        expect(host.taskState).toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a previous install that could not be removed after a good install as a warning that says what to delete', async () => {
      const { installer } = make({ existingTask: 'running', failScript: { containing: "if (Test-Path -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\agent.env.prev') { Remove-Item", stderr: 'Access is denied' } });
      const steps: InstallProgress[] = [];
      const result = await installer.install('user@win', (p) => steps.push(p));
      expect(result.success).toBe(true);
      const health = steps.find((s) => s.step === 'health' && s.status === 'ok')!;
      expect(health.message).toContain('WARNING: the previous install could not be removed');
      expect(health.message).toContain('The next install on this host stops while C:\\Users\\dev\\.azito\\agent\\agent.env.prev');
      expect(health.message).toContain('delete them by hand');
    });

    it('stops before anything is changed while an earlier reinstall left its previous install set aside', async () => {
      const { installer, host } = make({ existingTask: 'running', failScript: { containing: "-Filter '*.prev'", stderr: 'An earlier reinstall left its previous install set aside and it was neither put back nor removed: C:\\Users\\dev\\.azito\\agent\\agent.env.prev.' } });
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toContain('set aside');
      expect(host.calls.some((c) => c.kind === 'schtasks' && c.schtasksArgs![0] === '/End')).toBe(false);
      expect(host.taskState).toBe('running');
      const prepare = host.calls.filter((c) => c.kind === 'script')[0]!.text;
      // The script itself refuses (throws) before it removes anything, and never deletes a *.prev.
      expect(prepare.indexOf("throw ('An earlier reinstall")).toBeGreaterThan(-1);
      expect(prepare).not.toMatch(/Remove-Item[^\n]*\.prev/);
    });

    it('removes the version folder and the settings a failed first install created', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        const { installer, host } = make();
        const pending = installer.install('user@win');
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await pending;
        expect(result.error).toContain('restored the version folder');
        expect(result.error).toContain('restored the settings');
        const restore = host.calls.filter((c) => c.kind === 'script').map((c) => c.text).filter((t) => t.includes('elseif (Test-Path'));
        expect(restore.some((t) => t.includes("Remove-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\bundlehash1'"))).toBe(true);
        expect(restore.some((t) => t.includes("Remove-Item -LiteralPath 'C:\\Users\\dev\\.azito\\agent\\agent.env'"))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('restores the previous install when registering the new task fails', async () => {
      const { installer, host } = make({ existingTask: 'running' });
      const original = host.exec;
      let created = 0;
      (host as { exec: typeof host.exec }).exec = async (h, command) => {
        const out = await original(h, command);
        if (command.includes('-EncodedCommand') && decodeEncodedCommand(command).includes('AZITO_RUN_BEGIN') && decodeEncodedCommand(command).includes('/Create') && created++ === 0) {
          return { stdout: `<<AZITO_RUN_BEGIN>>\n${JSON.stringify({ exitCode: 1, stdout: '', stderr: Buffer.from('ERROR: No mapping between account names').toString('base64') })}\n<<AZITO_RUN_END>>\n`, stderr: '', code: 0 };
        }
        return out;
      };
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No mapping between account names');
      expect(result.error).toContain('restored the previous task definition');
      expect(host.taskState).toBe('running');
    });

    it('removes the new task of a failed first install (nothing to restore)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        const { installer, host } = make();
        const pending = installer.install('user@win');
        await vi.advanceTimersByTimeAsync(20_000);
        const result = await pending;
        expect(result.error).toContain('removed the new task');
        expect(host.taskState).toBe('absent');
      } finally {
        vi.useRealTimers();
      }
    });

    it('builds the settings and the task definition before it stops anything: a home the dotenv format cannot hold changes nothing on the host', async () => {
      const { installer, host } = make({ existingTask: 'running', home: 'C:\\Users\\a\\n"b\'c`d' });
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be written to the agent\'s env file');
      expect(host.calls.some((c) => c.kind === 'schtasks' && ['/End', '/Create'].includes(c.schtasksArgs![0]!))).toBe(false);
      expect(host.calls.some((c) => c.kind === 'script')).toBe(false);
      expect(host.taskState).toBe('running');
    });

    it('installs under a home with a quote, a hash sign and a backtick in its path', async () => {
      const { installer, host } = make({ home: "C:\\Users\\O'Brien #1 `x`" });
      const result = await installer.install('user@win');
      expect(result.success).toBe(true);
      expect(host.registeredXml).toContain("O'Brien #1 `x`");
    });
  });

  describe('the host is refused or fixed before anything is sent', () => {
    it('refuses Windows older than 1809 (no conhost --headless)', async () => {
      const { installer, host } = make({ buildNumber: '17134' });
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/1809.*found: build 17134/);
      expect(host.calls.some((c) => c.kind === 'firewall' || c.kind === 'script')).toBe(false);
    });

    it('stops with the WMI reason, not an old-build one, when WMI is refused, before the firewall and any transfer', async () => {
      const { installer, host } = make({ cim: 'denied', buildNumber: undefined });
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/WMI is not available.*administrator.*v0\.13\.0.*issues\/559/);
      expect(result.error).not.toMatch(/build number|1809/);
      expect(host.calls.some((c) => c.kind === 'firewall' || c.kind === 'script')).toBe(false);
    });

    it('stops with the name of an enabled inbound Block rule', async () => {
      const { installer, host } = make({ firewall: { ruleFound: true, elevated: true, created: false, problem: null, blockedBy: ['node.js JavaScript Runtime'] } });
      const result = await installer.install('user@win');
      expect(result.success).toBe(false);
      expect(result.error).toContain('"node.js JavaScript Runtime"');
      expect(host.calls.some((c) => c.kind === 'script')).toBe(false);
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

  });

  describe('updating an agent that is registered', () => {
    const WIN = { platform: 'win32', arch: 'x64' } as const;
    const OLD = '0123456789ab';
    const OLD_XML = `<Task><Actions><Exec><Arguments>--headless "C:\\Program Files\\nodejs\\node.exe" --env-file=C:\\Users\\dev\\.azito\\agent\\agent.env C:\\Users\\dev\\.azito\\agent\\${OLD}\\azito-agent.cjs</Arguments></Exec></Actions></Task>`;
    const makeRunning = (hostOptions: Partial<FakeWindowsHostOptions> = {}, misao?: AgentMisaoInstaller) => {
      const made = make({ existingTask: 'running', ...hostOptions }, DEFAULT_WINDOWS_AGENT_OPTIONS, misao);
      made.host.registeredXml = OLD_XML;
      return made;
    };
    /** `fetch` answers with the version of the agent that is up at the time: `current()` is read at each call; undefined = it does not answer. */
    const stubAgent = (current: () => string | undefined): void => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        const version = current();
        if (version === undefined) throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => ({ version }) };
      }));
    };
    const withTimers = async <T,>(run: () => Promise<T>): Promise<T> => {
      vi.useFakeTimers();
      try {
        const pending = run();
        await vi.advanceTimersByTimeAsync(120_000);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    };

    it('runs the install transaction with the agent\'s current token, leaves the misao task alone, and removes the releases older than the previous one', async () => {
      const misao = { install: vi.fn() };
      const { installer, host } = makeRunning({ scriptOutput: { containing: 'REMOVED', stdout: 'REMOVED aaaaaaaaaaaa\r\n' } }, misao as unknown as AgentMisaoInstaller);
      stubAgent(() => (host.uploaded.size > 0 ? VERSION : undefined));

      const result = await withTimers(() => installer.update('user@win', '100.64.0.9', 'the-current-token', WIN));

      expect(result).toEqual({ success: true, version: VERSION });
      // The settings the new agent starts with carry the token the hub already holds, and the bind address it is reached at.
      expect(host.uploaded.get('.azito/agent/agent.env.new')!.toString('utf8')).toBe(`AZITO_AGENT_TOKEN="the-current-token"\nAZITO_AGENT_BIND="100.64.0.9"\nPORT="3002"\nAZITO_AGENT_LOG_FILE="C:\\Users\\dev\\.azito\\agent\\agent.log"\nAZITO_AGENT_EXIT_WITH_PARENT="1"\n`);
      // Only the agent's task is stopped / started; the misao daemon (task AzitoMisao) and its installer are not involved.
      const schtasks = host.calls.filter((c) => c.kind === 'schtasks');
      expect(schtasks.map((c) => c.schtasksArgs![0])).toEqual(expect.arrayContaining(['/Query', '/End', '/Create', '/Run']));
      expect(schtasks.every((c) => !c.text.includes('AzitoMisao'))).toBe(true);
      expect(misao.install).not.toHaveBeenCalled();
      // The deploy came first, then the start, and the old releases were pruned last, keeping the new and the previous one.
      const kinds = host.calls.map((c) => (c.kind === 'schtasks' ? c.schtasksArgs![0] : c.kind === 'script' && c.text.includes('REMOVED') ? 'prune' : c.kind));
      expect(kinds.indexOf('/Create')).toBeLessThan(kinds.indexOf('/Run'));
      expect(kinds.indexOf('/Run')).toBeLessThan(kinds.indexOf('prune'));
      const prune = host.calls.find((c) => c.text.includes('REMOVED'))!.text;
      expect(prune).toContain(`$keep = @('${VERSION}', '${OLD}')`);
      expect(host.calls.some((c) => c.kind === 'firewall')).toBe(true); // checked as in the install, before anything is stopped
    });

    it('reports an old release that could not be removed as a warning of a successful update', async () => {
      const { installer, host } = makeRunning({ scriptOutput: { containing: 'REMOVED', stdout: 'REMOVED bbbbbbbbbbbb\r\nFAILED aaaaaaaaaaaa The process cannot access the file because it is being used by another process.\r\n' } });
      stubAgent(() => (host.uploaded.size > 0 ? VERSION : undefined));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await withTimers(() => installer.update('user@win', '100.64.0.9', 'tok', WIN));

      expect(result.success).toBe(true);
      expect(result.warning).toContain('aaaaaaaaaaaa (The process cannot access the file because it is being used by another process.)');
      expect(result.warning).toContain('tried again at the next update');
    });

    it('puts the previous version back, starts it and checks that it answers when the new agent does not', async () => {
      const { installer, host } = makeRunning();
      // The new agent never answers with its version; once the previous definition is registered and started again, the old version answers.
      stubAgent(() => (host.registeredXml === OLD_XML && host.taskState === 'running' ? OLD : undefined));

      const result = await withTimers(() => installer.update('user@win', '100.64.0.9', 'tok', WIN));

      expect(result.success).toBe(false);
      expect(result.version).toBe(VERSION);
      expect(result.error).toMatch(/^Health check failed: Health check timed out/);
      expect(result.error).toContain('Rolled back:');
      expect(result.error).toContain('restored the previous task definition');
      expect(result.error).toContain('started the previous agent again');
      expect(result.error).toContain('the previous agent answers again');
      expect(host.registeredXml).toBe(OLD_XML);
    });

    it('says so when the previous agent cannot be brought back, in the error of the update', async () => {
      const { installer } = makeRunning();
      stubAgent(() => undefined);

      const result = await withTimers(() => installer.update('user@win', '100.64.0.9', 'tok', WIN));

      expect(result.success).toBe(false);
      expect(result.error).toContain('the previous agent does NOT answer');
    });

    it('stops with the install\'s firewall error, before anything is stopped, when the node.exe found now has no rule', async () => {
      const { installer, host } = makeRunning({ firewall: { ruleFound: false, elevated: false, created: false, problem: null } });
      stubAgent(() => OLD);

      const result = await installer.update('user@win', '100.64.0.9', 'tok', WIN);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/[Ff]irewall/);
      expect(host.taskState).toBe('running');
      expect(host.uploaded.size).toBe(0);
    });

    it('fails before anything is stopped when the bundle cannot be verified on the host (the previous agent keeps running)', async () => {
      const { installer, host } = makeRunning({ sha256: 'f'.repeat(64) });
      stubAgent(() => OLD);

      const result = await installer.update('user@win', '100.64.0.9', 'tok', WIN);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^Transfer failed: .*SHA256 mismatch/);
      expect(host.taskState).toBe('running');
      expect(host.calls.some((c) => c.kind === 'schtasks' && c.schtasksArgs![0] === '/End')).toBe(false);
    });
  });

  describe('removing the agent from the host', () => {
    const TASK_XML = '<Task><Actions><Exec><Command>C:\\Windows\\System32\\conhost.exe</Command><Arguments>--headless "C:\\Program Files\\nodejs\\node.exe" --env-file=C:\\Users\\dev\\.azito\\agent\\agent.env C:\\Users\\dev\\.azito\\agent\\abc123abc123\\azito-agent.cjs</Arguments></Exec></Actions></Task>';

    it('asks the host who it is, takes the task off, and reports each step; no install check (Tailscale) is needed', async () => {
      const { installer, host } = make({ existingTask: 'running', tailscaleIp: '' });
      host.registeredXml = TASK_XML;
      const exec = host.exec;
      // The comparison of the task's node.exe with the host's runs on the host; the fake answers that the two are one file.
      Object.assign(host, {
        exec: async (h: string, command: string) => {
          const result = await exec(h, command);
          return host.calls[host.calls.length - 1]?.text.includes('$a = Resolve-Long') ? { ...result, stdout: 'SAME\r\n' } : result;
        },
      });
      const result = await installer.uninstallFromWindowsHost('user@win', { removeMisao: false });
      expect(result.steps.find((s) => s.id === 'task')).toEqual({ id: 'task', outcome: 'done' });
      expect(host.taskState).toBe('absent');
      expect(host.calls.some((c) => c.kind === 'preflight')).toBe(true);
      expect(host.calls.map((c) => c.text).join('\n')).not.toMatch(/nohup|systemctl|pkill/);
    });

    it('leaves the task when the host has no node.exe to compare the task\'s with', async () => {
      const { installer, host } = make({ existingTask: 'running', nodePath: '' });
      host.registeredXml = TASK_XML;
      const result = await installer.uninstallFromWindowsHost('user@win', { removeMisao: false });
      expect(result.steps.find((s) => s.id === 'task')).toMatchObject({ outcome: 'failed' });
      expect(host.taskState).toBe('running');
    });
  });
});
