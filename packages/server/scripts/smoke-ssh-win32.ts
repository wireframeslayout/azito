import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SshClient, type FingerprintStore } from '../src/modules/servers/ssh/SshClient';
import { resolveSshClientEnv } from '../src/modules/servers/ssh/sshClientEnv';
import { WINDOWS_OPENSSH_AGENT_PIPE } from '../src/modules/servers/ssh/sshAgentSocket';
import { resolveCurrentHostEnv } from '../src/shared/os/hostEnv';

/**
 * A Windows hub reaching an SSH server for real, on a Windows runner (GitHub's are administrators): the OpenSSH server (sshd) of the
 * machine itself over the loopback, with the hub's own SshClient. Three things are shown with the real services, not fakes:
 *   1. a private key under the hub's home (`<home>\.ssh\id_ed25519`, found through HostEnv.homeDir, not $HOME) authenticates;
 *   2. the OpenSSH Authentication Agent service (the named pipe \\.\pipe\openssh-ssh-agent, SSH_AUTH_SOCK unset) authenticates with
 *      no key file at all (the key was put into the agent with ssh-add);
 *   3. with the agent service stopped the pipe is absent, the hub reports "no ssh-agent" with the reason, and the key file still works.
 * The host key is pinned the way the hub does (a fingerprint store, trust on first use), and a changed fingerprint is refused.
 *
 * It changes the machine (starts sshd, writes the administrators' authorized_keys, starts ssh-agent) and puts everything back at the
 * end, also when a step fails. Only run it on a disposable CI runner.
 * Usage: tsx smoke-ssh-win32.ts
 */

const systemRoot = process.env.SystemRoot;
if (process.platform !== 'win32' || !systemRoot) throw new Error('smoke-ssh-win32.ts runs on Windows only');
const OPENSSH_DIR = path.join(systemRoot, 'System32', 'OpenSSH');
const POWERSHELL = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PROGRAM_DATA_SSH = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh');
const ADMIN_KEYS = path.join(PROGRAM_DATA_SSH, 'administrators_authorized_keys');

function ps(script: string): string {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], {
    encoding: 'utf8',
    timeout: 600_000,
  }).trim();
}

interface ServiceState {
  exists: boolean;
  status: string;
  startType: string;
}

function serviceState(name: string): ServiceState {
  const out = ps(`$s = Get-Service -Name '${name}' -ErrorAction SilentlyContinue; if ($null -eq $s) { 'absent' } else { "$($s.Status) $($s.StartType)" }`);
  if (out === 'absent') return { exists: false, status: '', startType: '' };
  const [status, startType] = out.split(' ');
  return { exists: true, status, startType };
}

function restoreService(name: string, before: ServiceState): void {
  if (!before.exists) return;
  if (before.status !== 'Running') ps(`Stop-Service -Name '${name}' -Force -ErrorAction SilentlyContinue`);
  ps(`Set-Service -Name '${name}' -StartupType ${before.startType}`);
  if (before.status === 'Running') ps(`Start-Service -Name '${name}'`);
}

class MemoryFingerprints implements FingerprintStore {
  readonly saved = new Map<string, string>();
  getFingerprint(host: string, port: number): string | null {
    return this.saved.get(`${host}:${port}`) ?? null;
  }
  saveFingerprint(host: string, port: number, fingerprint: string): void {
    this.saved.set(`${host}:${port}`, fingerprint);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`smoke-ssh-win32: ${message}`);
  console.log(`[smoke-ssh-win32] ok: ${message}`);
}

async function remoteEcho(client: SshClient, target: string): Promise<string> {
  const result = await client.execIsolated(target, 'echo azito-ssh-ok', 30_000);
  check(result.code === 0, `exit code 0 from ${target} (stderr: ${result.stderr.trim()})`);
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const user = os.userInfo().username;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-ssh-smoke-'));
  const hostEnv = resolveCurrentHostEnv();
  const sshdBefore = serviceState('sshd');
  const agentBefore = serviceState('ssh-agent');
  const adminKeysBefore = fs.existsSync(ADMIN_KEYS) ? fs.readFileSync(ADMIN_KEYS) : null;
  const adminKeysAcl = path.join(work, 'administrators_authorized_keys.acl');
  let wroteAdminKeys = false;

  try {
    check(agentBefore.exists, 'the OpenSSH Authentication Agent service (ssh-agent) is installed');
    if (!sshdBefore.exists) {
      console.log('[smoke-ssh-win32] installing the OpenSSH server capability...');
      ps('Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null');
    }
    check(serviceState('sshd').exists, 'the OpenSSH server service (sshd) is installed');

    // The key pair, made by the OpenSSH client itself so that it carries the access rules ssh-add insists on.
    const keyFile = path.join(work, 'id_ed25519');
    execFileSync(path.join(OPENSSH_DIR, 'ssh-keygen.exe'), ['-q', '-t', 'ed25519', '-N', '', '-C', 'azito-ssh-smoke', '-f', keyFile]);
    const publicKey = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim();

    // sshd reads the administrators' file, and refuses it unless only Administrators and SYSTEM can touch it.
    fs.mkdirSync(PROGRAM_DATA_SSH, { recursive: true });
    // The existing file's access rules (and inheritance) are saved first, to be restored with its content.
    if (adminKeysBefore) ps(`icacls.exe '${ADMIN_KEYS}' /save '${adminKeysAcl}' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls /save failed' }`);
    fs.writeFileSync(ADMIN_KEYS, `${publicKey}\r\n`);
    wroteAdminKeys = true;
    ps(`icacls.exe '${ADMIN_KEYS}' /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null`);
    ps(`Set-Service -Name sshd -StartupType Manual; Start-Service -Name sshd`);

    const fingerprints = new MemoryFingerprints();
    const target = `${user}@127.0.0.1`;

    // 1. A key file under the hub's home. The agent service is stopped, so the key file is the only way in.
    ps(`Stop-Service -Name ssh-agent -Force -ErrorAction SilentlyContinue; Set-Service -Name ssh-agent -StartupType Manual`);
    const home = path.join(work, 'home');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.copyFileSync(keyFile, path.join(home, '.ssh', 'id_ed25519'));
    const withKeyFile = new SshClient(resolveSshClientEnv({ homeDir: home, platform: 'win32' }, { USERNAME: user }), fingerprints);
    const resolvedKey = withKeyFile.resolveHost(target);
    check(resolvedKey.identityFile === path.join(home, '.ssh', 'id_ed25519'), `the key is found under the hub's home (${resolvedKey.identityFile})`);
    check(resolvedKey.agent === null && (resolvedKey.agentUnavailableReason ?? '').includes(WINDOWS_OPENSSH_AGENT_PIPE), `a stopped ssh-agent service is "no agent" with its reason (${resolvedKey.agentUnavailableReason})`);
    check((await remoteEcho(withKeyFile, target)).includes('azito-ssh-ok'), 'key-file authentication against the real sshd');
    check(fingerprints.saved.has('127.0.0.1:22'), 'the host key fingerprint was pinned on first use');

    // The user comes from USERNAME when the target names none (ssh config / user@host absent).
    check((await remoteEcho(withKeyFile, '127.0.0.1')).includes('azito-ssh-ok'), 'the OS user (USERNAME) is used when the server is written without user@');

    // A changed host key is refused.
    fingerprints.saved.set('127.0.0.1:22', 'SHA256:not-the-fingerprint-of-this-server');
    let refused = false;
    try {
      await withKeyFile.execIsolated(target, 'echo azito-ssh-ok', 30_000);
    } catch {
      refused = true;
    }
    check(refused, 'a host key that differs from the pinned fingerprint is refused');
    fingerprints.saved.clear();

    // 2. The OpenSSH agent service and its named pipe, with no key file in the home.
    ps(`Set-Service -Name ssh-agent -StartupType Manual; Start-Service -Name ssh-agent`);
    execFileSync(path.join(OPENSSH_DIR, 'ssh-add.exe'), [keyFile]);
    const emptyHome = path.join(work, 'empty-home');
    fs.mkdirSync(path.join(emptyHome, '.ssh'), { recursive: true });
    const viaAgent = new SshClient(resolveSshClientEnv({ homeDir: emptyHome, platform: 'win32' }, { USERNAME: user }), fingerprints);
    const resolvedAgent = viaAgent.resolveHost(target);
    check(resolvedAgent.identityFile === null, 'no key file in this home');
    check(resolvedAgent.agent === WINDOWS_OPENSSH_AGENT_PIPE, `SSH_AUTH_SOCK is unset, so the OpenSSH agent pipe is used (${resolvedAgent.agent})`);
    check((await remoteEcho(viaAgent, target)).includes('azito-ssh-ok'), 'authentication through the ssh-agent named pipe against the real sshd');

    // 3. The agent holds no key: the key file is still tried and wins (an empty agent is not an error).
    execFileSync(path.join(OPENSSH_DIR, 'ssh-add.exe'), ['-D']);
    check((await remoteEcho(withKeyFile, target)).includes('azito-ssh-ok'), 'an agent with no keys does not stop the key file from authenticating');
    execFileSync(path.join(OPENSSH_DIR, 'ssh-add.exe'), [keyFile]);
    console.log(`[smoke-ssh-win32] done (user ${user}, home ${hostEnv.homeDir})`);
  } finally {
    const problems: string[] = [];
    const attempt = (what: string, action: () => void): void => {
      try {
        action();
      } catch (err) {
        problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    attempt('ssh-add -D', () => {
      if (serviceState('ssh-agent').status === 'Running') execFileSync(path.join(OPENSSH_DIR, 'ssh-add.exe'), ['-D'], { stdio: 'ignore' });
    });
    attempt('restore ssh-agent', () => restoreService('ssh-agent', agentBefore));
    attempt('stop sshd and restore its start type', () => restoreService('sshd', sshdBefore.exists ? sshdBefore : { exists: true, status: 'Stopped', startType: 'Manual' }));
    attempt('restore administrators_authorized_keys', () => {
      if (!wroteAdminKeys) return;
      if (adminKeysBefore) {
        fs.writeFileSync(ADMIN_KEYS, adminKeysBefore);
        ps(`icacls.exe '${PROGRAM_DATA_SSH}' /restore '${adminKeysAcl}' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls /restore failed' }`);
      } else {
        fs.rmSync(ADMIN_KEYS, { force: true });
      }
    });
    attempt('remove the temporary folder', () => fs.rmSync(work, { recursive: true, force: true }));
    // A clean-up that did not work leaves the runner changed, so it fails the job (a failure above is reported first).
    if (problems.length > 0) throw new Error(`smoke-ssh-win32: clean-up problems:\n  ${problems.join('\n  ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
