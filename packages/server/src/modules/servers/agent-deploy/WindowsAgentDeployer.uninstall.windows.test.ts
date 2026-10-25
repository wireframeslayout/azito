import { exec as execCallback, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { encodeTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../../system/misao/misaoWindowsTask';
import { readSha256FromSumsFile } from './integrityVerifier';
import { AgentBundler } from './AgentBundler';
import { WindowsAgentDeployer, windowsAgentLayout, type WindowsDeployInput, type WindowsFileTransfer, type WindowsSshExec } from './WindowsAgentDeployer';
import { checkFirewall, firewallRuleName } from './windowsFirewall';
import { buildWindowsPreflightCommand, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import type { UninstallStepId, WindowsUninstallResult } from './windowsAgentUninstall';
import type { WindowsAgentOptions } from './windowsAgentConfig';

/**
 * The removal of a Windows agent from its host, against a real Windows: the agent bundle is really installed (real tar.exe, a real
 * Task Scheduler task), then removed through the same SSH-shaped path (each command line through cmd.exe), and nothing may be left:
 * no task, no process of the install, no folder, no firewall rule. The misao beside it stays unless it is asked for. Task, folders,
 * port and rule names are unique to this run; if anything cannot be removed at the end the suite FAILS.
 */
const SUFFIX = crypto.randomBytes(4).toString('hex');
const OPTIONS: WindowsAgentOptions = { taskName: `AzitoCiAgent-${SUFFIX}`, dir: `azito-ci-un-${SUFFIX}`, port: 0, misaoTaskName: `AzitoCiMisao-${SUFFIX}`, misaoDir: `azito-ci-un-misao-${SUFFIX}` };
const BIND = '127.0.0.1';

/** The environment of an SSH session: this process's, without a PSModulePath (see WindowsAgentDeployer.windows.test.ts). */
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

async function ps(script: string, timeoutMs = 120_000): Promise<string> {
  const out = await cmdExec('ci', powershellDialect.wrapScript(script), timeoutMs);
  if (out.code !== 0) throw new Error(`PowerShell failed (exit ${out.code}): ${out.stderr.slice(0, 500)}`);
  return out.stdout;
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

const alive = (child: ChildProcess): boolean => {
  try { process.kill(child.pid!, 0); return true; } catch { return false; }
};

const stepsOf = (result: WindowsUninstallResult): Partial<Record<UninstallStepId, string>> => Object.fromEntries(result.steps.map((s) => [s.id, s.outcome]));

describe.skipIf(process.platform !== 'win32')('removing the Windows agent from a real Windows', () => {
  let deployer: WindowsAgentDeployer;
  let host: WindowsPreflightInfo;
  let input: WindowsDeployInput;
  let version: string;
  let elevated = false;
  const decoys: ChildProcess[] = [];
  const scratch = path.join(os.tmpdir(), `azito-ci-un-${SUFFIX}`);
  const fwDir = path.join(os.tmpdir(), `azito-ci-un-fw-${SUFFIX}`);
  let fwNode = '';

  const agentRoot = (): string => path.win32.join(host.home, OPTIONS.dir);
  const misaoRoot = (): string => path.win32.join(host.home, OPTIONS.misaoDir);
  const schtasksPath = (): string => path.win32.join(host.systemRoot, 'System32', 'schtasks.exe');
  const taskRegistered = async (name: string): Promise<boolean> => (await cmdExec('ci', `"${schtasksPath()}" /Query /TN ${name}`, 60_000)).code === 0;
  const ruleCount = async (): Promise<number> => Number((await ps(`@(Get-NetFirewallRule -DisplayName ${powershellDialect.quote(firewallRuleName(OPTIONS.port))} -ErrorAction SilentlyContinue).Count`)).trim());

  /** The agent installed as the install does it (real bundle, real task), with a stand-in process that carries the install's --env-file argument. */
  async function installAgent(): Promise<ChildProcess> {
    const deployment = await deployer.deploy(input);
    await deployment.commit();
    const layout = windowsAgentLayout(host.home, OPTIONS, version);
    const script = path.join(scratch, 'decoy.js');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(script, 'setTimeout(() => {}, 120000);');
    const decoy = spawn(host.nodePath!, [script, `--env-file=${layout.envFile}`], { stdio: 'ignore', windowsHide: true });
    decoys.push(decoy);
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(decoy)).toBe(true);
    return decoy;
  }

  /** A misao task and folder of this run: the task starts nothing that exists (it runs at logon only), and the folder holds a file. */
  async function installMisao(): Promise<void> {
    fs.mkdirSync(misaoRoot(), { recursive: true });
    fs.writeFileSync(path.join(misaoRoot(), 'misao.log'), 'log');
    const xml = buildMisaoTaskXml({
      userId: host.userId, systemRoot: host.systemRoot, homeDir: host.home,
      layout: misaoWindowsLayout({ misaoRoot: misaoRoot() }, '0.3.0', OPTIONS.misaoTaskName), pipe: `\\\\.\\pipe\\misao-ci-${SUFFIX}`,
    });
    const file = path.join(scratch, 'misao.task.xml');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(file, encodeTaskXml(xml));
    const created = await cmdExec('ci', `"${schtasksPath()}" /Create /XML "${file}" /TN ${OPTIONS.misaoTaskName} /F`, 60_000);
    expect(created.code, created.stdout + created.stderr).toBe(0);
  }

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
      sshHost: 'ci', host, nodePath: fwNode, version, tarballPath: bundler.getTarballPath(),
      expectedSha256: readSha256FromSumsFile(bundler.getSha256sumsPath(), 'azito-agent.tar.gz'), token: crypto.randomBytes(32).toString('hex'), bindAddress: BIND,
    };
    // The firewall rule the install adds, when this session may add it (an elevated one): for a rule to remove.
    const firewall = await checkFirewall((command) => cmdExec('ci', command, 120_000), OPTIONS.port, fwNode, BIND);
    elevated = firewall.elevated;
  }, 600_000);

  afterAll(async () => {
    const problems: string[] = [];
    for (const decoy of decoys) decoy.kill();
    if (host) {
      for (const name of [OPTIONS.taskName, OPTIONS.misaoTaskName]) {
        await cmdExec('ci', `"${schtasksPath()}" /Delete /TN ${name} /F`, 60_000);
        if (await taskRegistered(name)) problems.push(`the task ${name} is still registered`);
      }
      await ps(`Remove-NetFirewallRule -DisplayName ${powershellDialect.quote(firewallRuleName(OPTIONS.port))} -ErrorAction SilentlyContinue`).catch(() => undefined);
      if (await ruleCount().catch(() => 0) !== 0) problems.push('the firewall rule is still there');
    }
    for (const dir of [fwDir, scratch, path.join(os.homedir(), OPTIONS.dir), path.join(os.homedir(), OPTIONS.misaoDir)]) {
      for (let attempt = 0; attempt < 20 && fs.existsSync(dir); attempt++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
      if (fs.existsSync(dir)) problems.push(`the folder ${dir} could not be removed`);
    }
    if (problems.length > 0) throw new Error(`The test could not clean up after itself:\n${problems.join('\n')}`);
  }, 180_000);

  it('removes the task, the install\'s processes, the firewall rule and the folder, and leaves the misao beside it', async () => {
    const decoy = await installAgent();
    await installMisao();
    expect(await taskRegistered(OPTIONS.taskName)).toBe(true);
    if (elevated) {
      // The rule the install adds, in the form the uninstall removes it.
      const added = await checkFirewall((command) => cmdExec('ci', command, 120_000), OPTIONS.port, fwNode, BIND);
      expect(added.created || added.ruleFound).toBe(true);
      expect(await ruleCount()).toBe(1);
    }

    const result = await deployer.uninstall('ci', host, { removeMisao: false });

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(stepsOf(result)).toEqual({ task: 'done', processes: 'done', firewall: elevated ? 'done' : 'absent', folder: 'done' });
    expect(await taskRegistered(OPTIONS.taskName)).toBe(false);
    for (let i = 0; i < 20 && alive(decoy); i++) await new Promise((r) => setTimeout(r, 250));
    expect(alive(decoy)).toBe(false);
    expect(fs.existsSync(agentRoot())).toBe(false);
    expect(await ruleCount()).toBe(0);
    // The misao was not asked for: its task and folder are still there.
    expect(await taskRegistered(OPTIONS.misaoTaskName)).toBe(true);
    expect(fs.existsSync(path.join(misaoRoot(), 'misao.log'))).toBe(true);
  }, 600_000);

  it('removing again finds nothing to remove (nothing fails), and with the misao asked for, removes its task and folder', async () => {
    const again = await deployer.uninstall('ci', host, { removeMisao: false });
    expect(again.ok, JSON.stringify(again.steps)).toBe(true);
    expect(stepsOf(again)).toEqual({ task: 'absent', processes: 'absent', firewall: 'absent', folder: 'absent' });

    const result = await deployer.uninstall('ci', host, { removeMisao: true });
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(stepsOf(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'absent', misaoFolder: 'done' });
    expect(await taskRegistered(OPTIONS.misaoTaskName)).toBe(false);
    expect(fs.existsSync(misaoRoot())).toBe(false);
  }, 600_000);

  it('leaves a task of that name that is not this install\'s, and the folder with it', async () => {
    const root = agentRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'agent.log'), 'x');
    const foreign = buildMisaoTaskXml({
      userId: host.userId, systemRoot: host.systemRoot, homeDir: host.home,
      layout: misaoWindowsLayout({ misaoRoot: path.win32.join(host.home, `elsewhere-${SUFFIX}`) }, '0.3.0', OPTIONS.taskName), pipe: `\\\\.\\pipe\\misao-ci-other-${SUFFIX}`,
    });
    const file = path.join(scratch, 'foreign.task.xml');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(file, encodeTaskXml(foreign));
    const created = await cmdExec('ci', `"${schtasksPath()}" /Create /XML "${file}" /TN ${OPTIONS.taskName} /F`, 60_000);
    expect(created.code, created.stdout + created.stderr).toBe(0);

    const result = await deployer.uninstall('ci', host, { removeMisao: false });

    expect(result.ok).toBe(false);
    expect(stepsOf(result)).toMatchObject({ task: 'failed', processes: 'skipped', firewall: 'skipped', folder: 'skipped' });
    expect(await taskRegistered(OPTIONS.taskName)).toBe(true);
    expect(fs.existsSync(path.join(root, 'agent.log'))).toBe(true);
    await cmdExec('ci', `"${schtasksPath()}" /Delete /TN ${OPTIONS.taskName} /F`, 60_000);
    fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('leaves a task that only has a settings file of a similar name (agent.env.other), and the folder with it', async () => {
    const root = agentRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'agent.log'), 'x');
    const similar = buildTaskXml({
      userId: host.userId, description: 'AZITO Agent: started at logon by the AZITO hub', executable: path.win32.join(host.systemRoot, 'System32', 'conhost.exe'),
      args: ['--headless', host.nodePath!, `--env-file=${path.win32.join(root, 'agent.env')}.other`, path.win32.join(root, 'x.cjs')], workingDirectory: root,
      restartOnFailure: { intervalMinutes: 1, count: 1 },
    });
    const file = path.join(scratch, 'similar.task.xml');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(file, encodeTaskXml(similar));
    const created = await cmdExec('ci', `"${schtasksPath()}" /Create /XML "${file}" /TN ${OPTIONS.taskName} /F`, 60_000);
    expect(created.code, created.stdout + created.stderr).toBe(0);

    const result = await deployer.uninstall('ci', host, { removeMisao: false });

    expect(stepsOf(result)).toMatchObject({ task: 'failed', processes: 'skipped', firewall: 'skipped', folder: 'skipped' });
    expect(await taskRegistered(OPTIONS.taskName)).toBe(true);
    expect(fs.existsSync(path.join(root, 'agent.log'))).toBe(true);
    await cmdExec('ci', `"${schtasksPath()}" /Delete /TN ${OPTIONS.taskName} /F`, 60_000);
    fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('leaves a firewall rule of the same name that is for another program (only an elevated session can make one)', async (ctx) => {
    if (!elevated) ctx.skip('this session is not elevated: a rule cannot be added here');
    const other = path.join(fwDir, 'other-node.exe');
    fs.copyFileSync(process.execPath, other);
    const name = firewallRuleName(OPTIONS.port);
    await ps(`Get-NetFirewallRule -DisplayName ${powershellDialect.quote(name)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
    await ps(`$null = New-NetFirewallRule -DisplayName ${powershellDialect.quote(name)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${OPTIONS.port} -Program ${powershellDialect.quote(other)} -LocalAddress ${BIND} -RemoteAddress 100.64.0.0/10 -Profile Any`);

    const result = await deployer.uninstall('ci', host, { removeMisao: false });

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(stepsOf(result).firewall).toBe('skipped');
    expect(await ruleCount()).toBe(1);
    await ps(`Remove-NetFirewallRule -DisplayName ${powershellDialect.quote(name)}`);
  }, 120_000);

  it('does not follow a link: a junction inside the folder is removed as a link, and what it points to is untouched', async () => {
    const root = agentRoot();
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'agent.log'), 'x');
    const made = await cmdExec('ci', `mklink /J "${path.join(root, 'link')}" "${outside}"`, 60_000);
    expect(made.code, made.stdout + made.stderr).toBe(0);

    const result = await deployer.uninstall('ci', host, { removeMisao: false });

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(stepsOf(result).folder).toBe('done');
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  }, 120_000);

  it('refuses to remove a folder that is itself a link, and leaves what it points to', async () => {
    const root = agentRoot();
    const outside = path.join(scratch, 'outside-root');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    const made = await cmdExec('ci', `mklink /J "${root}" "${outside}"`, 60_000);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    try {
      const result = await deployer.uninstall('ci', host, { removeMisao: false });
      expect(result.ok).toBe(false);
      expect(stepsOf(result).folder).toBe('failed');
      expect(result.steps.find((s) => s.id === 'folder')!.detail).toContain('is a link');
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    } finally {
      // rmdir on a junction removes the link, not its target.
      await cmdExec('ci', `rmdir "${root}"`, 60_000);
    }
    expect(fs.existsSync(root)).toBe(false);
  }, 120_000);
});
