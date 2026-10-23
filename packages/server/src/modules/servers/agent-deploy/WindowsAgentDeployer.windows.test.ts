import { exec as execCallback, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateAcl, parseAclSnapshot, INSPECT_SCRIPT } from '../../../shared/os/windowsSecretFileGuard';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { readSha256FromSumsFile } from './integrityVerifier';
import { AgentBundler } from './AgentBundler';
import { WindowsAgentDeployer, buildAgentEnvFile, windowsAgentLayout, type WindowsDeployInput, type WindowsFileTransfer, type WindowsSshExec } from './WindowsAgentDeployer';
import { buildFirewallCommand, firewallRuleName, parseFirewallResult } from './windowsFirewall';
import { buildWindowsPreflightCommand, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import type { WindowsAgentOptions } from './windowsAgentConfig';

/**
 * The Windows install against a real Windows: the SSH session is replaced by running each command line through cmd.exe (what a
 * Windows OpenSSH login shell does by default) and SFTP by file copies into the home directory. The REAL agent bundle is built,
 * unpacked by the real tar.exe, started by `node.exe --env-file=...` (directly, and through the Task Scheduler under
 * `conhost.exe --headless` when this machine has a logon session for it) and asked for /health. The firewall script runs on the
 * real PowerShell too. Task, folder, ports and firewall rules are unique to this run and removed afterwards; if anything cannot
 * be removed the suite FAILS.
 */
const SUFFIX = crypto.randomBytes(4).toString('hex');
const OPTIONS: WindowsAgentOptions = { taskName: `AzitoCiAgent-${SUFFIX}`, dir: `azito-ci-${SUFFIX}`, port: 0 };
const BIND = '127.0.0.1';
const NO_INTERACTIVE_LOGON = new Set([0x8004130f, 0x80070520]);
const FIREWALL_RULE_PREFIX = `AZITO CI ${SUFFIX}`;

/**
 * The environment of an SSH session: this process's, without a PSModulePath. The CI job is started from PowerShell 7, whose
 * PSModulePath Windows PowerShell 5.1 cannot use; sshd's own environment has the system one.
 */
function sessionEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

const cmdExec: WindowsSshExec = (_host, command, timeoutMs) => new Promise((resolve) => {
  execCallback(command, { env: sessionEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ stdout, stderr, code });
  });
});

/** Runs a PowerShell script the way the install does (EncodedCommand through cmd.exe) and returns stdout. */
async function ps(script: string, timeoutMs = 120_000): Promise<string> {
  const out = await cmdExec('ci', powershellDialect.wrapScript(script), timeoutMs);
  if (out.code !== 0) throw new Error(`PowerShell failed (exit ${out.code}): ${out.stderr.slice(0, 500)}`);
  return out.stdout;
}

/** What the test learned at the moment the token was written into the settings file (before the swap). */
const writeTimeChecks: Array<{ file: string; ownerOnly: boolean; sizeBefore: number }> = [];

async function ownerOnly(target: string, kind: 'file' | 'dir'): Promise<boolean> {
  const out = await ps(`$env:AZITO_GUARD_PATH = ${powershellDialect.quote(target)}\n${INSPECT_SCRIPT}`, 60_000);
  return evaluateAcl(parseAclSnapshot(out.trim()), target, kind).ok;
}

const homeTransfer: WindowsFileTransfer = {
  async putFile(_host, localPath, relative) {
    const dest = path.join(os.homedir(), ...relative.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localPath, dest);
  },
  async putBuffer(_host, data, relative) {
    const dest = path.join(os.homedir(), ...relative.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (relative.endsWith('/agent.env.new')) {
      // The moment before the token goes in: the file must already exist, empty, and be owner-only.
      writeTimeChecks.push({ file: dest, ownerOnly: await ownerOnly(dest, 'file'), sizeBefore: fs.statSync(dest).size });
    }
    fs.writeFileSync(dest, data);
  },
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, BIND, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, version: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${BIND}:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) {
        const body = await res.json() as { version: string };
        expect(body.version).toBe(version);
        return;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The agent did not answer /health within ${timeoutMs}ms (${last})`);
}

async function waitForNoHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answered = await fetch(`http://${BIND}:${port}/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (!answered) return;
    if (Date.now() >= deadline) throw new Error(`The agent still answers /health ${timeoutMs}ms after the task was stopped`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function readLog(logFile: string): string {
  try { return fs.readFileSync(logFile, 'utf8').slice(-3000); } catch { return '(no log file)'; }
}

/** The processes (node.exe and conhost.exe) whose command line names this run's agent folder. */
async function agentProcesses(root: string): Promise<Array<{ name: string; handle: number }>> {
  const out = await ps([
    `$root = ${powershellDialect.quote(root)}`,
    '$list = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and ($_.Name -eq \'node.exe\' -or $_.Name -eq \'conhost.exe\') } | ForEach-Object { $h = 0; try { $h = (Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowHandle } catch {}; [ordered]@{ name = $_.Name; handle = [int64]$h } })',
    '$global:LASTEXITCODE = 0',
    'ConvertTo-Json -InputObject @($list) -Compress',
  ].join('\n'));
  const parsed = JSON.parse(out.trim() || '[]') as Array<{ name: string; handle: number }> | { name: string; handle: number };
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The Command, Arguments and WorkingDirectory of a task's XML. */
function actionOf(xml: string): string[] {
  return ['Command', 'Arguments', 'WorkingDirectory'].map((tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? '');
}

describe.skipIf(process.platform !== 'win32')('the Windows agent install on a real Windows', () => {
  let deployer: WindowsAgentDeployer;
  let host: WindowsPreflightInfo;
  let input: WindowsDeployInput;
  let version: string;
  let direct: ChildProcess | undefined;
  let logonSession: boolean | undefined;
  const firewallRules = new Set<string>();
  /**
   * A copy of node.exe at a path of its own: the runner already has firewall rules for the real node.exe (they would make the
   * "no rule" cases unreachable), and the rules this suite adds name this path only.
   */
  const fwDir = path.join(os.tmpdir(), `azito-ci-fw-${SUFFIX}`);
  // Long form: the firewall refuses an 8.3 short path (RUNNER~1) as a rule's program.
  let fwNode = '';

  const layoutOf = (v = version) => windowsAgentLayout(host.home, OPTIONS, v);
  const schtasksPath = (): string => path.win32.join(host.systemRoot, 'System32', 'schtasks.exe');

  beforeAll(async () => {
    OPTIONS.port = await freePort();
    fs.mkdirSync(fwDir, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(fwDir, 'node.exe'));
    fwNode = path.join(fs.realpathSync.native(fwDir), 'node.exe');
    const bundler = new AgentBundler();
    await bundler.ensureBuild();
    version = bundler.getBundleHash();

    const pre = await cmdExec('ci', buildWindowsPreflightCommand(), 120_000);
    host = parseWindowsPreflight(pre.stdout, pre.stderr, pre.code);
    deployer = new WindowsAgentDeployer(cmdExec, homeTransfer, OPTIONS);
    input = {
      sshHost: 'ci', host, nodePath: host.nodePath!, version, tarballPath: bundler.getTarballPath(),
      expectedSha256: readSha256FromSumsFile(bundler.getSha256sumsPath(), 'azito-agent.tar.gz'), token: crypto.randomBytes(32).toString('hex'), bindAddress: BIND,
    };
  }, 600_000);

  afterAll(async () => {
    const problems: string[] = [];
    direct?.kill();
    await deployer?.stop('ci', host).catch((e: unknown) => problems.push(`stop: ${(e as Error).message}`));
    if (host) {
      const deleted = await cmdExec('ci', `"${schtasksPath()}" /Delete /TN ${OPTIONS.taskName} /F`, 60_000);
      const query = await cmdExec('ci', `"${schtasksPath()}" /Query /TN ${OPTIONS.taskName}`, 60_000);
      if (query.code === 0) problems.push(`the task ${OPTIONS.taskName} is still registered (delete exit ${deleted.code}: ${deleted.stderr.trim()})`);
      for (const name of firewallRules) {
        await ps(`Remove-NetFirewallRule -DisplayName ${powershellDialect.quote(name)} -ErrorAction SilentlyContinue`).catch(() => undefined);
        const left = (await ps(`@(Get-NetFirewallRule -DisplayName ${powershellDialect.quote(name)} -ErrorAction SilentlyContinue).Count`).catch((e: unknown) => String(e))).trim();
        if (left !== '0') problems.push(`the firewall rule "${name}" is still there (${left})`);
      }
    }
    fs.rmSync(fwDir, { recursive: true, force: true });
    if (fs.existsSync(fwDir)) problems.push(`the folder ${fwDir} could not be removed`);
    const dir = path.join(os.homedir(), OPTIONS.dir);
    for (let attempt = 0; attempt < 20 && fs.existsSync(dir); attempt++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    if (fs.existsSync(dir)) problems.push(`the folder ${dir} could not be removed`);
    if (host && (await agentProcesses(dir).catch(() => [])).length > 0) problems.push('an agent process is still running');
    if (problems.length > 0) throw new Error(`The test could not clean up after itself:\n${problems.join('\n')}`);
  }, 180_000);

  it('the preflight read the real host (home, SystemRoot, DOMAIN\\user, build)', () => {
    expect(host.home.toLowerCase()).toBe(os.homedir().toLowerCase());
    expect(host.userId).toMatch(/^[^\\]+\\[^\\]+$/);
    expect(host.nodePath).toMatch(/node\.exe$/i);
    expect(host.buildNumber).toBeGreaterThanOrEqual(17763);
  });

  describe('the firewall script on the real PowerShell', () => {
    const run = async (port: number, node = fwNode) => {
      const out = await cmdExec('ci', buildFirewallCommand(port, node, BIND), 120_000);
      expect(out.code, out.stderr).toBe(0);
      return parseFirewallResult(out.stdout, out.stderr, out.code);
    };
    const track = (port: number): string => {
      const name = firewallRuleName(port);
      firewallRules.add(name);
      return name;
    };
    const create = (name: string, extra: string): Promise<string> =>
      ps(`$null = New-NetFirewallRule -DisplayName ${powershellDialect.quote(name)} -Direction Inbound -Protocol TCP -Profile Any ${extra}`);

    it('adds the rule the first time (an elevated session) and finds it the second time', async (ctx) => {
      const port = await freePort();
      track(port);
      const first = await run(port);
      if (!first.elevated) ctx.skip('this session is not elevated: the rule cannot be added here');
      console.log(`[WindowsAgentDeployer.windows.test] first firewall result: ${JSON.stringify(first)}`);
      expect(first).toMatchObject({ ruleFound: false, created: true, problem: null, blockedBy: [] });
      const second = await run(port);
      expect(second).toMatchObject({ ruleFound: true, created: false, blockedBy: [] });
      // The rule is limited to this program, this address and the tailnet.
      const detail = JSON.parse(await ps([
        `$r = Get-NetFirewallRule -DisplayName ${powershellDialect.quote(firewallRuleName(port))}`,
        '$info = [ordered]@{ program = "$(($r | Get-NetFirewallApplicationFilter).Program)"; local = "$(($r | Get-NetFirewallAddressFilter).LocalAddress)"; remote = "$(($r | Get-NetFirewallAddressFilter).RemoteAddress)"; port = "$(($r | Get-NetFirewallPortFilter).LocalPort)"; action = "$($r.Action)" }',
        '$global:LASTEXITCODE = 0',
        'ConvertTo-Json -InputObject $info -Compress',
      ].join('\n'))) as Record<string, string>;
      expect(detail.program.toLowerCase()).toBe(fwNode.toLowerCase());
      expect(detail.local).toBe(BIND);
      expect(detail.remote).toMatch(/^100\.64\.0\.0\/(10|255\.192\.0\.0)$/);
      expect(detail.port).toBe(String(port));
      expect(detail.action).toBe('Allow');
    }, 300_000);

    it('stops at an enabled inbound Block rule for the port, with its name, and adds nothing', async () => {
      const port = await freePort();
      const name = `${FIREWALL_RULE_PREFIX} block`;
      firewallRules.add(name);
      track(port);
      await create(name, `-Action Block -LocalPort ${port} -Program ${powershellDialect.quote(fwNode)}`);
      const result = await run(port);
      expect(result.blockedBy).toContain(name);
      expect(result.created).toBe(false);
    }, 300_000);

    it('does not count a rule for a port range, nor one limited to other remote addresses', async (ctx) => {
      const rangePort = await freePort();
      const narrowPort = await freePort();
      track(rangePort);
      track(narrowPort);
      const rangeName = `${FIREWALL_RULE_PREFIX} range`;
      const narrowName = `${FIREWALL_RULE_PREFIX} narrow`;
      firewallRules.add(rangeName);
      firewallRules.add(narrowName);
      await create(rangeName, `-Action Allow -LocalPort ${rangePort}-${rangePort + 1} -Program ${powershellDialect.quote(fwNode)}`);
      await create(narrowName, `-Action Allow -LocalPort ${narrowPort} -Program ${powershellDialect.quote(fwNode)} -RemoteAddress LocalSubnet`);
      const range = await run(rangePort);
      if (!range.elevated) ctx.skip('this session is not elevated');
      expect(range).toMatchObject({ ruleFound: false, created: true });
      expect(await run(narrowPort)).toMatchObject({ ruleFound: false, created: true });
    }, 300_000);

    it('counts a program rule for node.exe with any port (the rule Windows adds when its prompt is accepted)', async () => {
      const port = await freePort();
      const name = `${FIREWALL_RULE_PREFIX} program`;
      firewallRules.add(name);
      track(port);
      await create(name, `-Action Allow -Program ${powershellDialect.quote(fwNode)}`);
      expect(await run(port)).toMatchObject({ ruleFound: true, created: false });
    }, 300_000);
  });

  describe('the install', () => {
    it('transfers, verifies and unpacks the real bundle, writes the settings into a file that was owner-only before the token went in, and registers the logon task', async () => {
      const layout = layoutOf();
      // An earlier agent.env with a broad explicit ACL: the new token must never be written into it.
      fs.mkdirSync(layout.root, { recursive: true });
      fs.writeFileSync(layout.envFile, 'AZITO_AGENT_TOKEN="old-token"\n');
      const granted = await cmdExec('ci', `icacls "${layout.envFile}" /grant "*S-1-5-32-545:(R)"`, 60_000);
      expect(granted.code, granted.stdout + granted.stderr).toBe(0);
      expect(await ownerOnly(layout.envFile, 'file')).toBe(false);

      const deployment = await deployer.deploy(input);

      expect(writeTimeChecks).toEqual([{ file: layout.envFileNew, ownerOnly: true, sizeBefore: 0 }]);
      expect(fs.existsSync(layout.entry)).toBe(true);
      expect(fs.existsSync(path.join(layout.versionDir, 'version.txt'))).toBe(true);
      expect(fs.existsSync(layout.tarball)).toBe(false);
      expect(fs.existsSync(layout.extractDir)).toBe(false);
      expect(fs.existsSync(layout.taskXml)).toBe(false);
      expect(fs.readFileSync(layout.envFile, 'utf8')).toBe(`AZITO_AGENT_TOKEN="${input.token}"\nAZITO_AGENT_BIND="${BIND}"\nPORT="${OPTIONS.port}"\nAZITO_AGENT_LOG_FILE="${layout.logFile}"\n`);
      // The previous (broad) file is kept aside until the deploy is committed; the live one and its folder are owner-only.
      expect(fs.readFileSync(layout.envFilePrev, 'utf8')).toContain('old-token');
      for (const [target, kind] of [[layout.envFile, 'file'], [layout.root, 'dir']] as const) expect(await ownerOnly(target, kind)).toBe(true);

      const registered = await cmdExec('ci', `"${schtasksPath()}" /Query /TN ${OPTIONS.taskName} /XML`, 60_000);
      expect(registered.code, registered.stderr).toBe(0);
      expect(registered.stdout).toContain('<LogonTrigger>');
      expect(registered.stdout).toContain(path.win32.join(host.systemRoot, 'System32', 'conhost.exe'));
      expect(registered.stdout).toContain('--headless');
      expect(registered.stdout).toContain(layout.entry);
      expect(registered.stdout).toContain(`--env-file=${layout.envFile}`);

      await deployment.commit();
      expect(fs.existsSync(layout.envFilePrev)).toBe(false);
      expect(fs.existsSync(layout.versionDirPrev)).toBe(false);
    }, 600_000);

    it('deploying again over the same version replaces it (a reinstall)', async () => {
      const deployment = await deployer.deploy({ ...input, token: crypto.randomBytes(32).toString('hex') });
      expect(fs.existsSync(layoutOf().entry)).toBe(true);
      await deployment.commit();
    }, 600_000);

    it('refuses a bundle whose SHA256 differs, removing the upload and changing nothing else', async () => {
      const before = fs.readFileSync(layoutOf().envFile, 'utf8');
      await expect(deployer.deploy({ ...input, expectedSha256: '0'.repeat(64) })).rejects.toThrow(/SHA256 mismatch/);
      expect(fs.existsSync(layoutOf().tarball)).toBe(false);
      expect(fs.readFileSync(layoutOf().envFile, 'utf8')).toBe(before);
      expect(fs.existsSync(layoutOf().versionDirPrev)).toBe(false);
    }, 600_000);

    it('writes settings that node --env-file reads back unchanged for a path with a quote, a hash sign and a backtick', async () => {
      // The same writer the install uses, run by the real Node of this machine against a path of that shape.
      const odd = path.join(os.tmpdir(), `O'Brien #${SUFFIX} \`t\``);
      fs.mkdirSync(odd, { recursive: true });
      try {
        const logFile = path.join(odd, 'agent.log');
        const file = path.join(odd, 'agent.env');
        fs.writeFileSync(file, buildAgentEnvFile({ token: 't', bindAddress: BIND, port: 1234, logFile }));
        const out = await new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [`--env-file=${file}`, '-e', 'process.stdout.write(process.env.AZITO_AGENT_LOG_FILE)'], { stdio: ['ignore', 'pipe', 'inherit'] });
          let text = '';
          child.stdout.on('data', (d: Buffer) => { text += d.toString('utf8'); });
          child.on('error', reject);
          child.on('close', () => resolve(text));
        });
        expect(out).toBe(logFile);
      } finally {
        fs.rmSync(odd, { recursive: true, force: true });
      }
    });

    it('node.exe --env-file=<settings> <entry> starts the real agent, which answers /health 200', async () => {
      const layout = layoutOf();
      direct = spawn(host.nodePath!, [`--env-file=${layout.envFile}`, layout.entry], { cwd: layout.versionDir, stdio: 'ignore', windowsHide: true });
      try {
        await waitForHealth(OPTIONS.port, version, 60_000);
      } catch (err) {
        throw new Error(`${(err as Error).message}\nagent log:\n${readLog(layout.logFile)}`);
      }
      // The log file named in the settings is written by the agent itself (a task has no console to send output to).
      expect(fs.existsSync(layout.logFile)).toBe(true);
      direct.kill();
      direct = undefined;
      await waitForNoHealth(OPTIONS.port, 15_000);
    }, 120_000);
  });

  describe('through the Task Scheduler (skipped, with the reason, only when this machine has no logon session)', () => {
    /** Waits until the task is running, or says there is no logon session (the only reason accepted for not running). */
    async function untilTaskSettled(): Promise<{ skip?: string }> {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const text = await deployer.describeTask('ci', host);
        if (text.includes('is running')) return {};
        const code = /last result 0x([0-9a-f]+)/.exec(text);
        if (code && NO_INTERACTIVE_LOGON.has(parseInt(code[1]!, 16))) return { skip: `no interactive logon session on this machine (${text})` };
        if (Date.now() >= deadline) throw new Error(`The task did not start: ${text}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    it('starts the agent under conhost --headless (no window), restarts it, and leaves no process behind after /End', async (ctx) => {
      await deployer.start('ci', host);
      const started = await untilTaskSettled();
      if (started.skip) {
        logonSession = false;
        console.warn(`[WindowsAgentDeployer.windows.test] SKIPPED task start: ${started.skip}`);
        ctx.skip(started.skip);
      }
      logonSession = true;
      try {
        await waitForHealth(OPTIONS.port, version, 60_000);
      } catch (err) {
        throw new Error(`${(err as Error).message}\nagent log:\n${readLog(layoutOf().logFile)}`);
      }
      // conhost is the parent of node; neither has a window.
      const running = await agentProcesses(layoutOf().root);
      expect(running.map((p) => p.name).sort()).toEqual(['conhost.exe', 'node.exe']);
      expect(running.every((p) => p.handle === 0)).toBe(true);

      await deployer.restart('ci', host);
      await waitForHealth(OPTIONS.port, version, 60_000);

      // For the record (not asserted): what the Task Scheduler's own /End leaves behind. The deployer's stop sweeps the rest.
      await cmdExec('ci', `"${schtasksPath()}" /End /TN ${OPTIONS.taskName}`, 60_000);
      await new Promise((r) => setTimeout(r, 3000));
      console.log(`[WindowsAgentDeployer.windows.test] processes left 3s after the task's own /End: ${JSON.stringify(await agentProcesses(layoutOf().root))}`);

      await deployer.stop('ci', host);
      await waitForNoHealth(OPTIONS.port, 15_000);
      // After stop() there is no agent process of this install: the conhost, and the node it started.
      expect(await agentProcesses(layoutOf().root)).toEqual([]);
    }, 300_000);

    it('a failed reinstall restores the previous install: files, settings, task definition, and the running agent', async (ctx) => {
      if (!logonSession) ctx.skip('no interactive logon session on this machine');
      await deployer.start('ci', host);
      await waitForHealth(OPTIONS.port, version, 60_000);
      const layout = layoutOf();
      const settingsBefore = fs.readFileSync(layout.envFile, 'utf8');
      const taskBefore = (await cmdExec('ci', `"${schtasksPath()}" /Query /TN ${OPTIONS.taskName} /XML`, 60_000)).stdout;

      // (1) A same-version reinstall that is rolled back after it was deployed.
      const second = await deployer.deploy({ ...input, token: crypto.randomBytes(32).toString('hex') });
      expect(fs.existsSync(layout.versionDirPrev)).toBe(true);
      expect(fs.readFileSync(layout.envFile, 'utf8')).not.toBe(settingsBefore);
      await waitForNoHealth(OPTIONS.port, 15_000); // the old agent was stopped to replace its files
      const summary = await second.rollback();
      expect(summary).toContain('restored the previous files');
      expect(summary).toContain('started the previous agent again');
      expect(fs.readFileSync(layout.envFile, 'utf8')).toBe(settingsBefore);
      expect(fs.existsSync(layout.versionDirPrev)).toBe(false);
      expect(fs.existsSync(layout.envFilePrev)).toBe(false);
      // The definition is the same one (the registration date the Task Scheduler stamps may differ).
      const taskAfter = (await cmdExec('ci', `"${schtasksPath()}" /Query /TN ${OPTIONS.taskName} /XML`, 60_000)).stdout;
      expect(actionOf(taskAfter)).toEqual(actionOf(taskBefore));
      await waitForHealth(OPTIONS.port, version, 60_000);

      // (2) A reinstall that fails while registering the task (a user that does not exist): thrown, and the previous agent is back.
      await expect(deployer.deploy({ ...input, host: { ...host, userId: 'NO-SUCH-DOMAIN\\nobody' }, token: crypto.randomBytes(32).toString('hex') })).rejects.toThrow(/restored the previous/);
      expect(fs.readFileSync(layout.envFile, 'utf8')).toBe(settingsBefore);
      expect(fs.existsSync(layout.versionDirPrev)).toBe(false);
      await waitForHealth(OPTIONS.port, version, 60_000);

      // (3) A good reinstall: started, answers, committed; the previous one is gone and the agent runs on the new settings.
      const third = await deployer.deploy({ ...input, token: crypto.randomBytes(32).toString('hex') });
      await deployer.start('ci', host);
      await waitForHealth(OPTIONS.port, version, 60_000);
      await third.commit();
      expect(fs.readFileSync(layout.envFile, 'utf8')).not.toBe(settingsBefore);
      expect(fs.existsSync(layout.versionDirPrev)).toBe(false);
      expect(fs.existsSync(layout.envFilePrev)).toBe(false);
    }, 600_000);
  });
});
