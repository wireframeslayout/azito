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
import { WindowsAgentDeployer, windowsAgentLayout, type WindowsDeployInput, type WindowsFileTransfer, type WindowsSshExec } from './WindowsAgentDeployer';
import { buildWindowsPreflightCommand, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';
import type { WindowsAgentOptions } from './windowsAgentConfig';

/**
 * The Windows install against a real Windows: the SSH session is replaced by running each command line through cmd.exe (what a
 * Windows OpenSSH login shell does by default) and SFTP by file copies into the home directory. The REAL agent bundle is built,
 * unpacked by the real tar.exe, started by `node.exe --env-file=...` (directly, and through the Task Scheduler when this machine
 * has a logon session for it) and asked for /health. Task, folder and port are unique to this run and removed afterwards.
 */
const SUFFIX = crypto.randomBytes(4).toString('hex');
const OPTIONS: WindowsAgentOptions = { taskName: `AzitoCiAgent-${SUFFIX}`, dir: `azito-ci-${SUFFIX}`, port: 0 };
const BIND = '127.0.0.1';
const NO_INTERACTIVE_LOGON = new Set([0x8004130f, 0x80070520]);

const cmdExec: WindowsSshExec = (_host, command, timeoutMs) => new Promise((resolve) => {
  execCallback(command, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ stdout, stderr, code });
  });
});

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

describe.skipIf(process.platform !== 'win32')('the Windows agent install on a real Windows', () => {
  let deployer: WindowsAgentDeployer;
  let host: WindowsPreflightInfo;
  let input: WindowsDeployInput;
  let version: string;
  let logFile: string;
  let direct: ChildProcess | undefined;

  beforeAll(async () => {
    OPTIONS.port = await freePort();
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
    logFile = windowsAgentLayout(host.home, OPTIONS, version).logFile;
  }, 600_000);

  afterAll(async () => {
    direct?.kill();
    await deployer?.stop('ci', host).catch(() => undefined);
    if (host) {
      // Remove the task (the deployer has no uninstall: that is #372) and the folder, whatever happened.
      await cmdExec('ci', `${path.win32.join(host.systemRoot, 'System32', 'schtasks.exe')} /Delete /TN ${OPTIONS.taskName} /F`, 60_000);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.rmSync(path.join(os.homedir(), OPTIONS.dir), { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  }, 120_000);

  it('the preflight read the real host (home, SystemRoot, DOMAIN\\user)', () => {
    expect(host.home.toLowerCase()).toBe(os.homedir().toLowerCase());
    expect(host.userId).toMatch(/^[^\\]+\\[^\\]+$/);
    expect(host.nodePath).toMatch(/node\.exe$/i);
  });

  it('transfers, verifies and unpacks the real bundle, writes the owner-only settings and registers the logon task', async () => {
    await deployer.deploy(input);

    const layout = windowsAgentLayout(host.home, OPTIONS, version);
    expect(fs.existsSync(layout.entry)).toBe(true);
    expect(fs.existsSync(path.join(layout.versionDir, 'version.txt'))).toBe(true);
    expect(fs.existsSync(layout.tarball)).toBe(false);
    expect(fs.existsSync(layout.extractDir)).toBe(false);
    expect(fs.existsSync(layout.taskXml)).toBe(false);
    expect(fs.readFileSync(layout.envFile, 'utf8')).toBe(`AZITO_AGENT_TOKEN=${input.token}\nAZITO_AGENT_BIND=${BIND}\nPORT=${OPTIONS.port}\nAZITO_AGENT_LOG_FILE=${layout.logFile}\n`);

    // The settings file and its folder are readable by the current user only.
    for (const [target, kind] of [[layout.envFile, 'file'], [layout.root, 'dir']] as const) {
      const out = await cmdExec('ci', powershellDialect.wrapScript(`$env:AZITO_GUARD_PATH = ${powershellDialect.quote(target)}\n${INSPECT_SCRIPT}`), 60_000);
      expect(out.code, out.stderr).toBe(0);
      expect(evaluateAcl(parseAclSnapshot(out.stdout.trim()), target, kind)).toEqual({ ok: true });
    }

    const registered = await cmdExec('ci', `${path.win32.join(host.systemRoot, 'System32', 'schtasks.exe')} /Query /TN ${OPTIONS.taskName} /XML`, 60_000);
    expect(registered.code, registered.stderr).toBe(0);
    expect(registered.stdout).toContain('<LogonTrigger>');
    expect(registered.stdout).toContain(layout.entry);
    expect(registered.stdout).toContain(`--env-file=${layout.envFile}`);
  }, 600_000);

  it('deploying again over the same version replaces it (a reinstall)', async () => {
    await deployer.deploy(input);
    expect(fs.existsSync(windowsAgentLayout(host.home, OPTIONS, version).entry)).toBe(true);
  }, 600_000);

  it('refuses a bundle whose SHA256 differs, removing the upload', async () => {
    await expect(deployer.deploy({ ...input, expectedSha256: '0'.repeat(64) })).rejects.toThrow(/SHA256 mismatch/);
    expect(fs.existsSync(windowsAgentLayout(host.home, OPTIONS, version).tarball)).toBe(false);
  }, 600_000);

  it('node.exe --env-file=<settings> <entry> starts the real agent, which answers /health 200 (the command line the task runs)', async () => {
    const layout = windowsAgentLayout(host.home, OPTIONS, version);
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
    await new Promise((r) => setTimeout(r, 1000));
  }, 120_000);

  it('the Task Scheduler starts the agent, restarts it and stops it (skipped, with the reason, only when this machine has no logon session)', async (ctx) => {
    await deployer.start('ci', host);
    const started = await untilTaskSettled();
    if (started.skip) {
      console.warn(`[WindowsAgentDeployer.windows.test] SKIPPED task start: ${started.skip}`);
      ctx.skip(started.skip);
    }
    try {
      await waitForHealth(OPTIONS.port, version, 60_000);
    } catch (err) {
      throw new Error(`${(err as Error).message}\nagent log:\n${readLog(logFile)}`);
    }

    await deployer.restart('ci', host);
    await waitForHealth(OPTIONS.port, version, 60_000);

    await deployer.stop('ci', host);
    // The process is gone a moment after the Task Scheduler reports the task stopped.
    await waitForNoHealth(OPTIONS.port, 15_000);
  }, 300_000);

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
});
