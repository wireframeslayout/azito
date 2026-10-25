import { exec as execCallback, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { buildTaskXml, encodeTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../../system/misao/misaoWindowsTask';
import { readSha256FromSumsFile } from './integrityVerifier';
import { AgentBundler } from './AgentBundler';
import { WindowsAgentDeployer, windowsAgentLayout, type WindowsDeployInput, type WindowsFileTransfer, type WindowsSshExec } from './WindowsAgentDeployer';
import { checkFirewall, firewallRuleName } from './windowsFirewall';
import { windowsMisaoPipe } from '../transport/agentMisaoSocket';
import { buildWindowsPreflightCommand, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import type { UninstallStepId, WindowsUninstallResult } from './windowsAgentUninstall';
import { misaoGuardScript, parseMisaoGuardOutput } from './windowsAgentOwnership';
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

  /**
   * The agent installed as the install does it (real bundle, real task), and the real agent running from it with the very command line
   * the task would give it (`node.exe --env-file=<settings> <release>\\azito-agent.cjs`): the process the uninstall has to end.
   */
  async function installAgent(): Promise<ChildProcess> {
    const deployment = await deployer.deploy(input);
    await deployment.commit();
    const layout = windowsAgentLayout(host.home, OPTIONS, version);
    const running = spawn(host.nodePath!, [`--env-file=${layout.envFile}`, layout.entry], { cwd: layout.versionDir, stdio: 'ignore', windowsHide: true });
    decoys.push(running);
    await new Promise((r) => setTimeout(r, 3000));
    expect(alive(running)).toBe(true);
    return running;
  }

  /** A misao task and folder of this run: the task starts nothing that exists (it runs at logon only), and the folder holds a file. */
  async function installMisao(): Promise<void> {
    fs.mkdirSync(misaoRoot(), { recursive: true });
    fs.writeFileSync(path.join(misaoRoot(), 'misao.log'), 'log');
    const xml = buildMisaoTaskXml({
      userId: host.userId, systemRoot: host.systemRoot, homeDir: host.home,
      layout: misaoWindowsLayout({ misaoRoot: misaoRoot() }, '0.3.0', OPTIONS.misaoTaskName), pipe: windowsMisaoPipe(misaoRoot(), os.userInfo().username),
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
      sshHost: 'ci', host, nodePath: host.nodePath!, version, tarballPath: bundler.getTarballPath(),
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

  it('ends the task, will not stop a process itself (it says which one is left), reports the firewall rule without removing it, and leaves the misao beside it', async () => {
    const running = await installAgent();
    await installMisao();
    expect(await taskRegistered(OPTIONS.taskName)).toBe(true);
    if (elevated) {
      // A rule like the one the install adds: it must be reported, and left.
      const added = await checkFirewall((command) => cmdExec('ci', command, 120_000), OPTIONS.port, fwNode, BIND);
      expect(added.created || added.ruleFound).toBe(true);
      expect(await ruleCount()).toBe(1);
    }

    // The agent here was started by the test, not by the task, so ending the task does not end it: AZITO does not stop it either.
    const first = await deployer.uninstall('ci', host, { removeMisao: false });

    expect(first.ok).toBe(false);
    expect(stepsOf(first)).toMatchObject({ task: 'done', processes: 'failed', folder: 'skipped' });
    const left = first.steps.find((step) => step.id === 'processes')!.detail!;
    expect(left).toContain(`process ${running.pid}`);
    expect(left).toContain('stop it yourself');
    expect(alive(running)).toBe(true);
    expect(fs.existsSync(agentRoot())).toBe(true);
    expect(await taskRegistered(OPTIONS.taskName)).toBe(false);

    // The person stops it; the same removal now goes through.
    running.kill();
    for (let i = 0; i < 40 && alive(running); i++) await new Promise((r) => setTimeout(r, 250));
    expect(alive(running)).toBe(false);
    const result = await deployer.uninstall('ci', host, { removeMisao: false });

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(stepsOf(result)).toEqual({ task: 'absent', processes: 'absent', firewall: elevated ? 'skipped' : 'absent', folder: 'done' });
    expect(fs.existsSync(agentRoot())).toBe(false);
    if (elevated) {
      // Reported with its Name and the command to remove it, and still there.
      const text = result.steps.find((step) => step.id === 'firewall')!.detail!;
      expect(text).toContain("Remove-NetFirewallRule -Name '");
      expect(await ruleCount()).toBe(1);
      await ps(`Remove-NetFirewallRule -DisplayName ${powershellDialect.quote(firewallRuleName(OPTIONS.port))} -ErrorAction SilentlyContinue`);
    }
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

  /** The 8.3 form of an existing file or folder, or undefined when this volume makes none. */
  async function shortFormOf(target: string): Promise<string | undefined> {
    const out = (await ps([
      `$target = ${powershellDialect.quote(target)}`,
      '$fso = New-Object -ComObject Scripting.FileSystemObject',
      '$item = if (Test-Path -LiteralPath $target -PathType Container) { $fso.GetFolder($target) } else { $fso.GetFile($target) }',
      '$global:LASTEXITCODE = 0',
      '$item.ShortPath',
    ].join('\n'))).trim();
    return out.includes('~') && out.toLowerCase() !== target.toLowerCase() ? out : undefined;
  }

  /** A task like the install's with the node.exe given as written. */
  async function registerAgentTaskWithNode(node: string): Promise<void> {
    const root = agentRoot();
    fs.mkdirSync(root, { recursive: true });
    const task = buildTaskXml({
      userId: host.userId, description: 'AZITO Agent: started at logon by the AZITO hub', executable: path.win32.join(host.systemRoot, 'System32', 'conhost.exe'),
      args: ['--headless', node, `--env-file=${path.win32.join(root, 'agent.env')}`, path.win32.join(root, 'abc123abc123', 'azito-agent.cjs')], workingDirectory: root,
      restartOnFailure: { intervalMinutes: 1, count: 1 },
    });
    const file = path.join(scratch, 'node.task.xml');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(file, encodeTaskXml(task));
    expect((await cmdExec('ci', `"${schtasksPath()}" /Create /XML "${file}" /TN ${OPTIONS.taskName} /F`, 60_000)).code).toBe(0);
  }

  async function removeAgentTaskAndFolder(): Promise<void> {
    await cmdExec('ci', `"${schtasksPath()}" /Delete /TN ${OPTIONS.taskName} /F`, 60_000);
    fs.rmSync(agentRoot(), { recursive: true, force: true });
  }

  it('takes the task when its node.exe is the host\'s by another spelling (its 8.3 name), and leaves one whose node.exe is another file', async (ctx) => {
    const short = await shortFormOf(host.nodePath!);
    if (short === undefined) ctx.skip('this volume makes no 8.3 names');
    await registerAgentTaskWithNode(fwNode);
    const other = await deployer.uninstall('ci', host, { removeMisao: false });
    expect(stepsOf(other)).toMatchObject({ task: 'failed', processes: 'skipped', folder: 'skipped' });
    expect(await taskRegistered(OPTIONS.taskName)).toBe(true);
    await removeAgentTaskAndFolder();

    await registerAgentTaskWithNode(short!);
    const same = await deployer.uninstall('ci', host, { removeMisao: false });
    expect(stepsOf(same)).toMatchObject({ task: 'done', folder: 'done' });
    expect(await taskRegistered(OPTIONS.taskName)).toBe(false);
  }, 120_000);

  it('leaves a task whose node.exe is reached through a junction (where it leads is not what the name says)', async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const jn = path.join(scratch, `jn-${SUFFIX}`);
    expect((await cmdExec('ci', `mklink /J "${jn}" "${path.dirname(host.nodePath!)}"`, 60_000)).code).toBe(0);
    try {
      await registerAgentTaskWithNode(path.join(jn, 'node.exe'));
      const result = await deployer.uninstall('ci', host, { removeMisao: false });
      expect(stepsOf(result)).toMatchObject({ task: 'failed', processes: 'skipped', folder: 'skipped' });
      expect(await taskRegistered(OPTIONS.taskName)).toBe(true);
    } finally {
      await cmdExec('ci', `rmdir "${jn}"`, 60_000);
      await removeAgentTaskAndFolder();
    }
  }, 120_000);

  it('leaves a task that has a second action beside the right one, and a program that is not node.exe', async () => {
    await registerAgentTaskWithNode(host.nodePath!);
    const exported = await cmdExec('ci', `"${schtasksPath()}" /Query /TN ${OPTIONS.taskName} /XML`, 60_000);
    expect(exported.code).toBe(0);
    await removeAgentTaskAndFolder();
    // The real definition the Task Scheduler gives back, with a COM handler added to its actions.
    const withCom = exported.stdout.replace('</Actions>', '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler></Actions>');
    fs.mkdirSync(agentRoot(), { recursive: true });
    const file = path.join(scratch, 'com.task.xml');
    fs.writeFileSync(file, encodeTaskXml(withCom));
    const created = await cmdExec('ci', `"${schtasksPath()}" /Create /XML "${file}" /TN ${OPTIONS.taskName} /F`, 60_000);
    if (created.code === 0) {
      const result = await deployer.uninstall('ci', host, { removeMisao: false });
      expect(stepsOf(result)).toMatchObject({ task: 'failed', folder: 'skipped' });
      expect(await taskRegistered(OPTIONS.taskName)).toBe(true);
    }
    await removeAgentTaskAndFolder();
  }, 120_000);

  describe('who owns the misao folder, on the real host', () => {
    const ask = async (hubRoot: string | undefined): Promise<string> =>
      parseMisaoGuardOutput(await ps(misaoGuardScript({ root: misaoRoot(), hubRoot, looksForHub: false }))).kind;

    it('knows a hub folder named by its 8.3 name or in another case is the same folder, and one that does not exist may be', async (ctx) => {
      fs.mkdirSync(misaoRoot(), { recursive: true });
      const short = await shortFormOf(misaoRoot());
      if (short === undefined) ctx.skip('this volume makes no 8.3 names');
      expect(await ask(short)).toBe('sameHub');
      expect(await ask(misaoRoot().toUpperCase())).toBe('sameHub');
      expect(await ask(path.win32.join(host.home, `azito-ci-no-such-${SUFFIX}`))).toBe('maybeHub');
      expect(await ask(host.home)).toBe('clear');
    }, 120_000);

    it('does not compare a hub folder that is reached through a junction: it may be this very folder', async () => {
      fs.mkdirSync(misaoRoot(), { recursive: true });
      // home\\<junction> leads back to the home folder, so <junction>\\<misao dir> IS the misao folder, under another name.
      const jn = path.join(host.home, `azito-ci-un-jct-${SUFFIX}`);
      expect((await cmdExec('ci', `mklink /J "${jn}" "${host.home}"`, 60_000)).code).toBe(0);
      try {
        expect(await ask(path.win32.join(jn, OPTIONS.misaoDir))).toBe('maybeHub');
      } finally {
        await cmdExec('ci', `rmdir "${jn}"`, 60_000);
      }
    }, 120_000);
  });

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
