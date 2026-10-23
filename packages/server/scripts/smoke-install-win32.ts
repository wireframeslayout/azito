import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createSecretFileGuard } from '../src/shared/os/secretFileGuard';
import { readEnvValue } from '../src/shared/envFile';

/**
 * End-to-end check of the Windows install path (install.ps1, the `azito` CLI, run.ps1) on a real Windows PowerShell 5.1:
 * installs the zip build-hub.ts produced into a throwaway prefix, drives the installed `azito.cmd`, starts the hub through it
 * and looks at the access rules of the secret files. Every step that fails throws with the command's output.
 * Usage: tsx smoke-install-win32.ts <azito-hub-*-win32-x64.zip> <SHA256SUMS> <install.ps1>
 */

const STARTUP_TIMEOUT_MS = 90_000;
const SYSTEM_ROOT = process.env.SystemRoot ?? '';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const TASKKILL = path.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

interface Result { status: number | null; output: string }

function step(message: string): void {
  console.log(`[smoke-install] ${message}`);
}

function assert(condition: boolean, message: string, detail = ''): void {
  if (!condition) throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function powershell(args: string[]): Result {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf-8', timeout: 300_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function install(installPs1: string, args: string[]): Result {
  return powershell(['-File', installPs1, ...args]);
}

/** The cmd.exe command line that runs `"<script>" <args>`: /s strips the outer quotes, so the script path keeps its own (spaces, parentheses). */
function cmdLine(script: string, args: string): string[] {
  return ['/d', '/s', '/c', `""${script}" ${args}"`];
}

function azito(azitoCmd: string, args: string): Result {
  const r = spawnSync(CMD, cmdLine(azitoCmd, args), { encoding: 'utf-8', timeout: 120_000, windowsVerbatimArguments: true });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, failure: () => Error | null): Promise<number> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    const failed = failure();
    if (failed) throw failed;
    try {
      const res = await fetch(url);
      if (res.ok) return res.status;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not answer within ${STARTUP_TIMEOUT_MS} ms (last: ${last})`);
}

function checkVerification(installPs1: string, zip: string, sums: string, work: string): void {
  step('a SHA256SUMS that does not match stops the install before anything is written');
  const bad = path.join(work, 'SHA256SUMS.bad');
  fs.writeFileSync(bad, fs.readFileSync(sums, 'utf-8').replace(/^[0-9a-f]/i, (c) => (c === '0' ? '1' : '0')));
  const prefix = path.join(work, 'mismatch', '.azito');
  const r = install(installPs1, ['-ZipPath', zip, '-Sha256Sums', bad, '-Prefix', prefix, '-Yes', '-NoPath']);
  assert(r.status !== 0 && /SHA256 mismatch/.test(r.output), 'a checksum mismatch must fail the install', r.output);
  assert(!fs.existsSync(path.join(prefix, 'hub')), 'nothing may be written under the prefix after a mismatch');
}

function checkInstall(installPs1: string, zip: string, sums: string, prefix: string, version: string): void {
  step(`install into ${prefix}`);
  const args = ['-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath'];
  const first = install(installPs1, args);
  assert(first.status === 0, 'install.ps1 failed', first.output);
  const hubDir = path.join(prefix, 'hub');
  for (const file of [`${version}/run.ps1`, `${version}/node.exe`, '.env', 'current.txt']) {
    assert(fs.existsSync(path.join(hubDir, file)), `missing after install: hub/${file}`, first.output);
  }
  assert(fs.existsSync(path.join(prefix, 'bin', 'azito.cmd')), 'missing bin/azito.cmd', first.output);
  assert(fs.readFileSync(path.join(hubDir, 'current.txt'), 'utf-8').trim() === version, 'current.txt must name the installed version');
  const token = readEnvValue(path.join(hubDir, '.env'), 'AZITO_UI_TOKEN');
  assert(/^[0-9a-f]{64}$/.test(token ?? ''), 'hub/.env must hold a 64-hex UI token');
  assert(first.output.includes(token as string), 'install.ps1 must print the UI token', first.output);

  step('running install.ps1 again for the same version changes nothing');
  const envBefore = fs.readFileSync(path.join(hubDir, '.env'), 'utf-8');
  const second = install(installPs1, args);
  assert(second.status === 0 && /already installed/.test(second.output), 'a re-run must report the install and succeed', second.output);
  assert(fs.readFileSync(path.join(hubDir, '.env'), 'utf-8') === envBefore, 'a re-run must not touch hub/.env');
}

function checkCli(azitoCmd: string, prefix: string, version: string): void {
  step('azito version / token show');
  const v = azito(azitoCmd, 'version');
  assert(v.status === 0 && v.output.includes(`current: ${version}`) && /bundle:\s+\S+/.test(v.output), 'azito version', v.output);
  const t = azito(azitoCmd, 'token show');
  const expected = readEnvValue(path.join(prefix, 'hub', '.env'), 'AZITO_UI_TOKEN');
  assert(t.status === 0 && t.output.trim() === expected, 'azito token show must print the token in hub/.env', t.output);

  step('azito stop / status / misao / service say why they are not available');
  for (const command of ['stop', 'status']) {
    const r = azito(azitoCmd, command);
    assert(r.status === 1 && /resident service/.test(r.output), `azito ${command} must fail with the reason`, r.output);
  }
  const service = azito(azitoCmd, 'service status');
  assert(service.status !== 0 && /Windows/.test(service.output), 'azito service status must fail with its reason', service.output);
  const misao = azito(azitoCmd, 'misao install');
  assert(misao.status !== 0 && misao.output.trim() !== '', 'azito misao install must fail with its reason', misao.output);
  console.log(`[smoke-install] azito service status -> ${service.output.trim()}\n[smoke-install] azito misao install -> ${misao.output.trim()}`);
  const unknown = azito(azitoCmd, 'bogus');
  assert(unknown.status === 1 && /Unknown command/.test(unknown.output), 'an unknown command must fail', unknown.output);
}

async function checkStart(azitoCmd: string, prefix: string): Promise<void> {
  step('azito start runs the hub with hub/.env and /api/health answers');
  const envFile = path.join(prefix, 'hub', '.env');
  const port = await freePort();
  // The installed file asks for port 3001, which may be taken on a shared runner: edit the value in place (the ACL stays).
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf-8').replace(/^PORT=.*$/m, `PORT=${port}`));

  let output = '';
  let failure: Error | null = null;
  let exited = false;
  const child: ChildProcess = spawn(CMD, cmdLine(azitoCmd, 'start'), { stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true });
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.on('error', (err) => { failure = new Error(`could not start azito start: ${err.message}`); exited = true; });
  child.on('exit', (code) => { failure ??= new Error(`azito start exited (code ${code}) before /api/health answered`); exited = true; });
  try {
    const status = await waitForHealth(`http://127.0.0.1:${port}/api/health`, () => failure);
    console.log(`[smoke-install] /api/health -> ${status}`);
    assert(fs.existsSync(path.join(prefix, 'data', 'data.db')), 'the hub must use the AZITO_DATA_DIR from hub/.env', output);
  } catch (err) {
    console.error(`[smoke-install] hub output:\n${output}`);
    throw err;
  } finally {
    if (!exited && child.pid) {
      // Our own process tree (cmd -> powershell -> node), by the pid we spawned.
      spawnSync(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf-8' });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function checkAccessRules(prefix: string): void {
  step('secret files and the data folder belong to the current user only');
  const guard = createSecretFileGuard('win32', process.env);
  const targets: Array<[string, 'file' | 'dir']> = [
    [path.join(prefix, 'hub', '.env'), 'file'],
    [path.join(prefix, 'data'), 'dir'],
    [path.join(prefix, 'data', 'data.db'), 'file'],
  ];
  for (const [target, kind] of targets) {
    assert(fs.existsSync(target), `expected to exist: ${target}`);
    const inspection = guard.inspect(target, kind);
    assert(inspection.ok, `${target} is not owner-only`, inspection.ok ? '' : `${inspection.summary}\n${inspection.fix}`);
  }
}

function checkUserPath(installPs1: string, work: string): void {
  step('Add-UserPathEntry keeps the existing value, adds once and keeps the registry type');
  const script = path.join(work, 'path-check.ps1');
  fs.writeFileSync(script, [
    `. '${installPs1.replace(/'/g, "''")}'`,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "$had = $key.GetValueNames() -contains 'Path'",
    "$orig = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "$origKind = if ($had) { $key.GetValueKind('Path') } else { $null }",
    'try {',
    "  $key.SetValue('Path', '%USERPROFILE%\\.azito-test-bin;C:\\Existing', [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    "  $first = Add-UserPathEntry 'C:\\Foo Bar (x)\\bin'",
    "  $again = Add-UserPathEntry 'C:\\Foo Bar (x)\\bin\\'",
    "  $now = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "  Write-Output \"first=$first\"; Write-Output \"again=$again\"; Write-Output \"kind=$($key.GetValueKind('Path'))\"; Write-Output \"path=$now\"",
    '} finally {',
    "  if ($had) { $key.SetValue('Path', $orig, $origKind) } else { $key.DeleteValue('Path', $false) }",
    '  $key.Close()',
    '}',
    '',
  ].join('\r\n'));
  const r = powershell(['-File', script]);
  assert(r.status === 0, 'the PATH check script failed', r.output);
  const lines = r.output.split(/\r?\n/);
  assert(lines.includes('first=True') && lines.includes('again=False'), 'the entry must be added once', r.output);
  assert(lines.includes('kind=ExpandString'), 'the registry type must be kept', r.output);
  assert(lines.includes('path=%USERPROFILE%\\.azito-test-bin;C:\\Existing;C:\\Foo Bar (x)\\bin'), 'existing entries must be kept as they were', r.output);
}

async function main(): Promise<void> {
  const [zipArg, sumsArg, installArg] = process.argv.slice(2);
  if (!zipArg || !sumsArg || !installArg) throw new Error('usage: smoke-install-win32.ts <zip> <SHA256SUMS> <install.ps1>');
  const zip = path.resolve(zipArg);
  const sums = path.resolve(sumsArg);
  const installPs1 = path.resolve(installArg);
  const version = /^azito-hub-(.+)-win32-x64\.zip$/.exec(path.basename(zip))?.[1];
  assert(version !== undefined, `not an azito-hub-<tag>-win32-x64.zip: ${zip}`);

  const major = powershell(['-Command', '$PSVersionTable.PSVersion.Major']);
  assert(major.output.trim() === '5', 'install.ps1 must be exercised by Windows PowerShell 5.1', major.output);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-install-smoke-'));
  try {
    checkVerification(installPs1, zip, sums, work);
    // Spaces and parentheses in the prefix: the shape of a profile folder like "C:\Users\Foo Bar (Work)".
    const prefix = path.join(work, 'Foo Bar (Work)', '.azito');
    checkInstall(installPs1, zip, sums, prefix, version as string);
    const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
    checkCli(azitoCmd, prefix, version as string);
    await checkStart(azitoCmd, prefix);
    checkAccessRules(prefix);
    checkUserPath(installPs1, work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  step('ok');
}

main().catch((err) => {
  console.error('[smoke-install] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
