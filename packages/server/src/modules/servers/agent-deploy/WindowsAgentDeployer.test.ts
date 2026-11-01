import { createHash } from 'node:crypto';
import { agentTaskAction } from './windowsAgentTask';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { parseEnv } from 'util';
import { describe, expect, it, vi } from 'vitest';
import { buildEndProcessesScript } from '../../../shared/os/windowsProcessSweep';
import { compressPowerShellScript } from '../../../shared/os/compressPowerShellScript';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { DEFAULT_WINDOWS_AGENT_OPTIONS } from './windowsAgentConfig';
import { decodeEncodedCommand, FakeWindowsHost } from './testing/fakeWindowsHost';
import { WindowsAgentDeployer, buildAgentEnvFile, powershellErrorText, quoteDotenvValue, windowsAgentLayout } from './WindowsAgentDeployer';

describe('windowsAgentLayout', () => {
  it('puts everything under <home>\\<dir>, and gives the SFTP path relative to the home with forward slashes', () => {
    const l = windowsAgentLayout('C:\\Users\\Server User', DEFAULT_WINDOWS_AGENT_OPTIONS, 'abc123');
    expect(l.root).toBe('C:\\Users\\Server User\\.azito\\agent');
    expect(l.rootRelative).toBe('.azito/agent');
    expect(l.entry).toBe('C:\\Users\\Server User\\.azito\\agent\\abc123\\azito-agent.cjs');
    expect(l.envFile).toBe('C:\\Users\\Server User\\.azito\\agent\\agent.env');
    expect(l.envFileNew).toBe('C:\\Users\\Server User\\.azito\\agent\\agent.env.new');
    expect(l.envFilePrev).toBe('C:\\Users\\Server User\\.azito\\agent\\agent.env.prev');
    expect(l.versionDirPrev).toBe('C:\\Users\\Server User\\.azito\\agent\\abc123.prev');
    expect(l.taskXml).toBe('C:\\Users\\Server User\\.azito\\agent\\AzitoAgent.task.xml');
  });

  it('refuses a version that is not a plain name', () => {
    expect(() => windowsAgentLayout('C:\\u', DEFAULT_WINDOWS_AGENT_OPTIONS, '..\\x')).toThrow(/Unsafe agent version/);
  });
});

describe('buildAgentEnvFile', () => {
  const env = (over: Partial<Parameters<typeof buildAgentEnvFile>[0]> = {}) => ({ token: 'tok', bindAddress: '100.64.0.9', port: 3002, logFile: 'C:\\Users\\a b\\agent.log', misaoDir: '.azito\\misao', ...over });

  it('writes the values node --env-file reads, double-quoted', () => {
    expect(buildAgentEnvFile(env()))
      .toBe('AZITO_AGENT_TOKEN="tok"\nAZITO_AGENT_BIND="100.64.0.9"\nPORT="3002"\nAZITO_AGENT_LOG_FILE="C:\\Users\\a b\\agent.log"\nAZITO_AGENT_EXIT_WITH_PARENT="1"\n');
  });

  it.each([
    ["C:\\Users\\O'Brien\\agent.log"],
    ['C:\\Users\\a#1\\agent.log'],
    ['C:\\Users\\`tick`\\agent.log'],
    ["C:\\Users\\O'Brien #1 `x` 日本語 café\\agent.log"],
    ['C:\\Users\\new\\next\\agent.log'], // a literal \n: Node expands it inside double quotes
    ["C:\\Users\\new's\\agent.log"],
  ])("reads %j back unchanged through Node's own parseEnv", (logFile) => {
    expect(parseEnv(buildAgentEnvFile(env({ logFile }))).AZITO_AGENT_LOG_FILE).toBe(logFile);
  });

  it('reads every setting back', () => {
    const parsed = parseEnv(buildAgentEnvFile(env({ token: 'a'.repeat(64) })));
    expect(parsed).toEqual({ AZITO_AGENT_TOKEN: 'a'.repeat(64), AZITO_AGENT_BIND: '100.64.0.9', PORT: '3002', AZITO_AGENT_LOG_FILE: 'C:\\Users\\a b\\agent.log', AZITO_AGENT_EXIT_WITH_PARENT: '1' });
  });

  it.each(['a\nb', ''])('refuses a value that cannot be written (%j)', (token) => {
    expect(() => buildAgentEnvFile(env({ token }))).toThrow(/AZITO_AGENT_TOKEN/);
  });

  it('refuses a value that fits no quote', () => {
    expect(() => quoteDotenvValue('X', 'a\\n"b\'c`d')).toThrow(/cannot be written/);
  });
});

describe('powershellErrorText', () => {
  it('passes plain stderr through', () => {
    expect(powershellErrorText(' boom \n')).toBe('boom');
  });

  it('takes the message out of CLIXML', () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">tar failed: a &lt;b&gt;_x000D__x000A_</S><S S="Error">at line 3_x000D__x000A_</S></Objs>';
    expect(powershellErrorText(clixml)).toBe('tar failed: a <b>\nat line 3');
  });
});

describe('stopping a task launcher', () => {
  it('does not interrupt a waiting launcher, and restarts a present process only when forced', async () => {
    const fake = new FakeWindowsHost({ sha256: 'a'.repeat(64), existingTask: 'running', scriptOutput: { containing: '# AZITO_PROCESS_PRESENT', stdout: 'absent' } });
    const info = { nodePath: 'C:\\node.exe', nodeVersion: '24', arch: 'x64' as const, windowsVersion: null, buildNumber: 22631, cim: 'ok' as const, tailscaleIp: '100.64.0.9', home: 'C:\\Users\\dev', systemRoot: 'C:\\Windows', userId: 'PC\\dev' };
    const layout = windowsAgentLayout(info.home, DEFAULT_WINDOWS_AGENT_OPTIONS, 'abc123');
    const action = agentTaskAction(info.systemRoot, info.nodePath, layout.envFile, layout.entry, DEFAULT_WINDOWS_AGENT_OPTIONS.taskName);
    fake.registeredXml = buildTaskXml({ userId: info.userId, description: 'agent', executable: action.executable, args: action.args, workingDirectory: layout.versionDir, restartOnFailure: { intervalMinutes: 1, count: 999 } });
    const deployer = new WindowsAgentDeployer(fake.exec, { putFile: async () => undefined, putBuffer: async () => undefined }, DEFAULT_WINDOWS_AGENT_OPTIONS);
    expect(await deployer.restart('h', info, false)).toBe('starting');
    expect(await deployer.restart('h', info, true)).toBe('starting');
    fake.options.scriptOutput!.stdout = 'present';
    expect(await deployer.restart('h', info, true)).toBe('restarted');
    expect(fake.calls.some((call) => call.schtasksArgs?.[0] === '/End')).toBe(true);
  });

  it('ends the recognised launcher before sweeping its agent even when the scheduler reports stopped', async () => {
    const fake = new FakeWindowsHost({ sha256: 'a'.repeat(64), existingTask: 'stopped' });
    const info = { nodePath: 'C:\\node.exe', nodeVersion: '24', arch: 'x64' as const, windowsVersion: null, buildNumber: 22631, cim: 'ok' as const, tailscaleIp: '100.64.0.9', home: 'C:\\Users\\dev', systemRoot: 'C:\\Windows', userId: 'PC\\dev' };
    const layout = windowsAgentLayout(info.home, DEFAULT_WINDOWS_AGENT_OPTIONS, 'abc123');
    const action = agentTaskAction(info.systemRoot, info.nodePath, layout.envFile, layout.entry, DEFAULT_WINDOWS_AGENT_OPTIONS.taskName);
    fake.registeredXml = buildTaskXml({ userId: info.userId, description: 'agent', executable: action.executable, args: action.args, workingDirectory: layout.versionDir, restartOnFailure: { intervalMinutes: 1, count: 999 } });
    const deployer = new WindowsAgentDeployer(fake.exec, { putFile: async () => undefined, putBuffer: async () => undefined }, DEFAULT_WINDOWS_AGENT_OPTIONS);
    await deployer.stop('h', info);
    const sweeps = fake.calls.filter((call) => call.text.includes('function Get-AgentNodes')).map((call) => call.text);
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0]).toContain("Get-Process -Name 'powershell'");
    expect(sweeps[0]).toContain(createHash('sha256').update(action.args.at(-1)!, 'ascii').digest('hex'));
    expect(sweeps[0]).not.toContain(action.args.at(-1)!);
    expect(sweeps[1]).toContain("Get-Process -Name 'node'");
    expect(sweeps[1]).toContain(`--env-file=${layout.envFile}`);
  });
});

describe('transferred uninstall scripts', () => {
  it('keeps a successful result when cleanup fails', async () => {
    const host = new FakeWindowsHost({ sha256: 'a'.repeat(64), failScript: { containing: "Remove-Item -LiteralPath 'C:\\Users\\dev\\.azito-script-", stderr: 'cleanup failed' } });
    const deployer = new WindowsAgentDeployer(host.exec, { putFile: async () => undefined, putBuffer: async () => undefined }, DEFAULT_WINDOWS_AGENT_OPTIONS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = deployer as unknown as { transferredScript(host: string, home: string, what: string, body: string): Promise<string> };
      await expect(run.transferredScript('h', 'C:\\Users\\dev', 'test', 'Write-Output 1')).resolves.toBe(`${'a'.repeat(64)}\r\n`);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('keeps the original execution error when cleanup also fails', async () => {
    const exec = async (_host: string, command: string) => ({ stdout: '', stderr: decodeEncodedCommand(command).includes('[IO.File]::ReadAllBytes') ? 'execution failed' : 'cleanup failed', code: 1 });
    const deployer = new WindowsAgentDeployer(exec, { putFile: async () => undefined, putBuffer: async () => undefined }, DEFAULT_WINDOWS_AGENT_OPTIONS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = deployer as unknown as { transferredScript(host: string, home: string, what: string, body: string): Promise<string> };
      await expect(run.transferredScript('h', 'C:\\Users\\dev', 'test', 'Write-Output 1')).rejects.toThrow('execution failed');
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }

  });
});

describe('the process sweep script', () => {
  async function sweepScript(): Promise<string> {
    const host = new FakeWindowsHost({ sha256: 'a'.repeat(64) });
    const deployer = new WindowsAgentDeployer(host.exec, { putFile: async () => undefined, putBuffer: async () => undefined }, DEFAULT_WINDOWS_AGENT_OPTIONS);
    await deployer.stop('h', { nodePath: 'C:\\node.exe', nodeVersion: '24', arch: 'x64', windowsVersion: null, buildNumber: 22631, tailscaleIp: '100.64.0.9', home: 'C:\\Users\\dev', systemRoot: 'C:\\Windows', userId: 'PC\\dev' });
    return host.calls.map((c) => c.text).find((t) => t.includes('Get-AgentNodes'))!;
  }

  it('takes a parent only if it is a conhost.exe of the same user, no younger than the node, with the same --env-file argument', async () => {
    const script = await sweepScript();
    expect(script).toContain("$parent.Name -eq 'conhost.exe'");
    expect(script).toContain('$parent.CreationDate -le $node.CreationDate');
    expect(script).toContain('(Test-Argument $parent)');
    expect(script).toContain('(Test-Mine $parent)');
    expect(script).toContain('if ($owner -ne $me) { return }; $n = try { Read-Node $candidate }');
    expect(script).toContain('if (-not $owner)');
    expect(script).toContain('-or -not $elevated) { return }');
  });

  it('keeps each target with its creation time, and checks it again before ending it and when asking whether it has ended', async () => {
    const script = await sweepScript();
    expect(script).toContain('[pscustomobject]@{ Id = $node.ProcessId; Created = $node.CreationDate }');
    expect(script).toContain('$started -eq $target.Created');
    expect(script).toContain('foreach ($target in $targets) { if (Get-Same $target) { Stop-Process');
    expect(script).toContain('function Get-Alive { @($targets | Where-Object { Get-Same $_ }) }');
    expect(script).not.toMatch(/Get-CimInstance|Invoke-CimMethod/);
  });

  it('fits the SSH command limit with a long agent path', () => {
    const body = buildEndProcessesScript({ image: 'node.exe', argument: `--env-file=C:\\${'a'.repeat(240)}\\agent.env`, label: 'agent', endParentConhost: true });
    expect(powershellDialect.wrapScript(compressPowerShellScript(body)).length).toBeLessThanOrEqual(8191);
  });

  it('does not use two spellings of one variable', async () => {
    const script = await sweepScript();
    const spellings = new Map<string, Set<string>>();
    for (const [, name] of script.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (['_', 'true', 'false', 'null', 'lastexitcode', 'erroractionpreference', 'progresspreference', 'global'].includes(name!.toLowerCase())) continue;
      spellings.set(name!.toLowerCase(), (spellings.get(name!.toLowerCase()) ?? new Set()).add(name!));
    }
    expect([...spellings.values()].filter((set) => set.size > 1)).toEqual([]);
  });
});
