import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createSecretFileGuard } from '../src/shared/os/secretFileGuard';
import { readEnvValue } from '../src/shared/envFile';
import { assertNoHubLaunchers, assertNoOtherHubProcesses } from '../src/modules/system/windowsHubUninstall';
import { powershellDialect, powershellEncodedArgs } from '../src/shared/os/shellDialect';
import { runCommandSpec, runHostOf } from '../src/shared/exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../src/shared/os/hostEnv';

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

function powershell(args: string[], env: NodeJS.ProcessEnv = process.env): Result {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf-8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024, env });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status, output: r.status === 0 ? output : `stdout:\n${r.stdout ?? ""}\nstderr:\n${r.stderr ?? ""}\nexit status: ${r.status}, signal: ${r.signal ?? "none"}${r.error ? `, error: ${r.error.message}` : ""}` };
}

function install(installPs1: string, args: string[], env: NodeJS.ProcessEnv = process.env): Result {
  return powershell(['-File', installPs1, ...args], env);
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
  const r = install(installPs1, ['-ZipPath', zip, '-Sha256Sums', bad, '-Prefix', prefix, '-Yes', '-NoPath', '-NoService']);
  assert(r.status !== 0 && /SHA256 mismatch/.test(r.output), 'a checksum mismatch must fail the install', r.output);
  assert(!fs.existsSync(path.join(prefix, 'hub')), 'nothing may be written under the prefix after a mismatch');
}

function checkInstall(installPs1: string, zip: string, sums: string, prefix: string, version: string): void {
  step(`install into ${prefix}`);
  const args = ['-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath', '-NoService'];
  // A token variable inherited from the calling shell must not decide the token that is shown: the hub uses hub/.env.
  const inherited = 'token-from-the-parent-shell';
  const first = install(installPs1, args, { ...process.env, AZITO_UI_TOKEN: inherited });
  assert(first.status === 0, 'install.ps1 failed', first.output);
  const hubDir = path.join(prefix, 'hub');
  for (const file of [`${version}/run.ps1`, `${version}/node.exe`, '.env', 'current.txt']) {
    assert(fs.existsSync(path.join(hubDir, file)), `missing after install: hub/${file}`, first.output);
  }
  assert(fs.existsSync(path.join(prefix, 'bin', 'azito.cmd')), 'missing bin/azito.cmd', first.output);
  assert(fs.existsSync(path.join(hubDir, '.install-record.json')), 'missing installation ownership record', first.output);
  assert(fs.readFileSync(path.join(hubDir, 'current.txt'), 'utf-8').trim() === version, 'current.txt must name the installed version');
  const token = readEnvValue(path.join(hubDir, '.env'), 'AZITO_UI_TOKEN');
  assert(/^[0-9a-f]{64}$/.test(token ?? ''), 'hub/.env must hold a 64-hex UI token');
  assert(first.output.includes(token as string), 'install.ps1 must print the UI token of hub/.env', first.output);
  assert(!first.output.includes(inherited), 'install.ps1 must not print a token inherited from the calling shell', first.output);

  step('running install.ps1 again for the same version changes nothing');
  const envBefore = fs.readFileSync(path.join(hubDir, '.env'), 'utf-8');
  const second = install(installPs1, args);
  assert(second.status === 0 && /already installed/.test(second.output), 'a re-run must report the install and succeed', second.output);
  assert(fs.readFileSync(path.join(hubDir, '.env'), 'utf-8') === envBefore, 'a re-run must not touch hub/.env');
}

function checkUninstall(installPs1: string, prefix: string, version: string): void {
  step('uninstall refuses an unrecorded file, then retains data and is repeatable');
  const release = path.join(prefix, 'hub', version);
  const extra = path.join(release, 'user-file');
  fs.writeFileSync(extra, 'leave this');
  const args = ['-Uninstall', '-Prefix', prefix, '-Yes'];
  step('uninstall: refuse an unrecorded file');
  const refused = install(installPs1, args);
  assert(refused.status !== 0 && fs.existsSync(extra), 'an unrecorded file must prevent removal', refused.output);
  fs.unlinkSync(extra);
  const target = path.join(path.dirname(prefix), 'junction-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'outside');
  const junction = path.join(release, 'user-junction');
  fs.symlinkSync(target, junction, 'junction');
  step('uninstall: refuse a junction without following it');
  const linked = install(installPs1, args);
  assert(linked.status !== 0 && fs.existsSync(path.join(target, 'keep')), 'a junction must be refused without entering it', linked.output);
  fs.rmdirSync(junction);
  step('uninstall: remove the release while retaining data');
  const removed = install(installPs1, args);
  assert(removed.status === 0, 'uninstall failed', removed.output);
  assert(!fs.existsSync(release), 'the recorded release must be removed', removed.output);
  assert(fs.existsSync(path.join(prefix, 'data', 'data.db')), 'data must be retained by default', removed.output);
  step('uninstall: repeat after successful removal');
  const again = install(installPs1, args);
  assert(again.status === 0 && /No installation record/.test(again.output), 'a repeat must report the retained files', again.output);
}

async function checkRemoveData(installPs1: string, zip: string, sums: string, prefix: string): Promise<void> {
  step('an explicit -RemoveData removes an unchanged recorded data directory');
  const installed = install(installPs1, ['-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath', '-NoService']);
  assert(installed.status === 0, 'install for data removal failed', installed.output);
  const removed = install(installPs1, ['-Uninstall', '-RemoveData', '-Prefix', prefix, '-Yes']);
  assert(removed.status === 0, 'uninstall with data removal failed', removed.output);
  assert(!fs.existsSync(path.join(prefix, 'data')), 'unchanged recorded data must be removed', removed.output);
  assert(!fs.existsSync(path.join(prefix, 'hub', '.env')), 'recorded .env must be removed', removed.output);
  assert(!fs.existsSync(prefix), 'an unused NoService install must remove its empty prefix', removed.output);
  const reinstalled = install(installPs1, ['-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath', '-NoService']);
  assert(reinstalled.status === 0, 'reinstall failed', reinstalled.output);
  const removedAgain = install(installPs1, ['-Uninstall', '-RemoveData', '-Prefix', prefix, '-Yes']);
  assert(removedAgain.status === 0 && !fs.existsSync(path.join(prefix, 'hub', 'current.txt')), 'uninstall after reinstall failed', removedAgain.output);

  const envPrefix = `${prefix}-env-replaced`;
  const envInstall = install(installPs1, ['-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', envPrefix, '-Yes', '-NoPath', '-NoService']);
  assert(envInstall.status === 0, 'install for changed env failed', envInstall.output);
  const envFile = path.join(envPrefix, 'hub', '.env');
  const envCopy = `${envFile}.replacement`;
  fs.copyFileSync(envFile, envCopy);
  fs.renameSync(envCopy, envFile);
  const envRemoval = install(installPs1, ['-Uninstall', '-RemoveData', '-Prefix', envPrefix, '-Yes']);
  assert(envRemoval.status === 0 && fs.existsSync(envFile) && /env changed after install; retained/i.test(envRemoval.output), 'a replaced env must be kept while uninstall completes', envRemoval.output);
  assert(!fs.existsSync(path.join(envPrefix, 'hub', 'current.txt')), 'changed env must not prevent release removal', envRemoval.output);

  const changedPrefix = `${prefix}-changed`;
  const changedInstall = install(installPs1, ['-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', changedPrefix, '-Yes', '-NoPath', '-NoService']);
  assert(changedInstall.status === 0, 'install for changed data failed', changedInstall.output);
  const hubOutput = await checkStart(installPs1, path.join(changedPrefix, 'bin', 'azito.cmd'), changedPrefix);
  const extra = path.join(changedPrefix, 'data', 'user-file');
  fs.writeFileSync(extra, 'keep');
  const database = path.join(changedPrefix, 'data', 'data.db');
  const webhook = path.join(changedPrefix, 'data', 'webhook-token');
  assert(fs.existsSync(path.join(changedPrefix, 'hub', '.owned-data-webhook-token.json')), 'the generated webhook token must have an ownership record', hubOutput);
  const canary = fs.readdirSync(path.join(changedPrefix, 'data')).find((name) => /^\.azito-hub-canary-[a-f0-9]{32}$/.test(name));
  assert(canary !== undefined && fs.existsSync(path.join(changedPrefix, 'hub', `.owned-data-${canary}.json`)), 'the generated canary must have an ownership record', hubOutput);
  const changedRemoval = install(installPs1, ['-Uninstall', '-RemoveData', '-Prefix', changedPrefix, '-Yes']);
  assert(changedRemoval.status === 0 && fs.existsSync(extra) && /Data retained/.test(changedRemoval.output), 'changed data must be retained and reported', changedRemoval.output);
  if (fs.existsSync(`${database}-wal`) || fs.existsSync(`${database}-shm`)) assert(fs.existsSync(database), 'database must be kept with SQLite sidecars', changedRemoval.output);
  else assert(!fs.existsSync(database), 'the recorded database must be removed without sidecars', changedRemoval.output);
  assert(!fs.existsSync(webhook), 'the recorded generated token must be removed', changedRemoval.output);
  assert(!fs.existsSync(path.join(changedPrefix, 'data', canary as string)), 'the recorded canary must be removed', changedRemoval.output);
}

async function checkOrphanLauncher(prefix: string): Promise<void> {
  step('a synthetic orphan launcher mentioning the hub is detected without being stopped');
  const hub = path.join(prefix, 'hub');
  const script = `$hubRoot = ${powershellDialect.quote(hub)}; Start-Sleep -Seconds 90`;
  const child = spawn(POWERSHELL, powershellEncodedArgs(script), { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const host = runHostOf(resolveCurrentHostEnv());
    let reason = '';
    try { await assertNoHubLaunchers([hub], (spec) => runCommandSpec(spec, host), SYSTEM_ROOT, process.pid); } catch (err) { reason = err instanceof Error ? err.message : String(err); }
    assert(/launcher is still running/.test(reason), 'the orphan launcher must be reported', reason);
    assert(child.exitCode === null, 'the launcher check must not stop the process');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
  }
}

async function checkShortProcessPath(prefix: string): Promise<void> {
  step('an unidentifiable Node process with a short path is refused without being stopped');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)', 'C:\\MIXED~1\\fake'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const host = runHostOf(resolveCurrentHostEnv());
    let reason = '';
    try { await assertNoOtherHubProcesses(path.join(prefix, 'hub'), (spec) => runCommandSpec(spec, host), SYSTEM_ROOT, process.pid); } catch (err) { reason = err instanceof Error ? err.message : String(err); }
    assert(reason.includes(`node process (${child.pid}) could not be identified`), 'the short-name process must be reported', reason);
    assert(child.exitCode === null, 'the process check must not stop the process');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
  }
}

function checkRepairAndDiagnostics(installPs1: string, zip: string, sums: string, prefix: string, version: string): void {
  step(`install into ${prefix} (a prefix with &), then repair a half-finished install`);
  const args = ['-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath', '-NoService'];
  const first = install(installPs1, args);
  assert(first.status === 0, 'install.ps1 failed', first.output);
  const hubDir = path.join(prefix, 'hub');
  const pointer = path.join(hubDir, 'current.txt');
  const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
  const envBefore = fs.readFileSync(path.join(hubDir, '.env'), 'utf-8');

  fs.writeFileSync(pointer, '');
  const empty = install(installPs1, args);
  assert(empty.status !== 0 && /does not hold a version/.test(empty.output), 'an empty current.txt must stop the installer with a reason', empty.output);

  fs.rmSync(pointer);
  fs.rmSync(azitoCmd);
  const repaired = install(installPs1, args);
  assert(repaired.status === 0 && !/already installed/.test(repaired.output), 'a re-run after a part-way install must finish it', repaired.output);
  assert(fs.existsSync(azitoCmd) && fs.readFileSync(pointer, 'utf-8').trim() === version, 'the re-run must write the CLI and current.txt');
  assert(fs.readFileSync(path.join(hubDir, '.env'), 'utf-8') === envBefore, 'the repair must keep hub/.env (and its token)');
  assert(azito(azitoCmd, 'version').status === 0, 'azito version after the repair');

  step('azito.cmd refuses a bad current.txt and reports a failure path that contains &');
  fs.writeFileSync(pointer, `\uFEFF${version}\r\n`, 'utf-8');
  const bom = azito(azitoCmd, 'version');
  assert(bom.status === 1 && /must hold one version/.test(bom.output) && bom.output.includes(prefix), 'a BOM in current.txt must be refused with the path intact', bom.output);
  fs.writeFileSync(pointer, `${version}\r\n`);
  const nodeExe = path.join(hubDir, version, 'node.exe');
  fs.renameSync(nodeExe, `${nodeExe}.off`);
  const missing = azito(azitoCmd, 'version');
  assert(missing.status === 1 && /incomplete/.test(missing.output) && missing.output.includes(path.join(hubDir, version)), 'a missing node.exe must be reported with the path intact', missing.output);
  fs.renameSync(`${nodeExe}.off`, nodeExe);
  const unknown = azito(azitoCmd, '"bogus&echo injected"');
  assert(unknown.status === 1 && unknown.output.includes('Unknown command: bogus&echo injected') && !/^injected/m.test(unknown.output), 'an argument with & must not run as a command', unknown.output);
}

function checkCli(azitoCmd: string, prefix: string, version: string): void {
  step('azito version / token show');
  const v = azito(azitoCmd, 'version');
  assert(v.status === 0 && v.output.includes(`current: ${version}`) && /bundle:\s+\S+/.test(v.output), 'azito version', v.output);
  const t = azito(azitoCmd, 'token show');
  const expected = readEnvValue(path.join(prefix, 'hub', '.env'), 'AZITO_UI_TOKEN');
  assert(t.status === 0 && t.output.trim() === expected, 'azito token show must print the token in hub/.env', t.output);

  // This install was made with -NoService, so there is no task: the commands say so (the registered task is checked by smoke-service-win32.ts).
  step('azito stop / status / service / misao status say what is missing');
  const stop = azito(azitoCmd, 'stop');
  assert(stop.status === 1 && /not installed/.test(stop.output) && /azito service install/.test(stop.output), 'azito stop without the task must fail with the way to register it', stop.output);
  const status = azito(azitoCmd, 'status');
  assert(status.status === 0 && /service:\s+not installed/.test(status.output), 'azito status without the task must say it is not installed', status.output);
  const service = azito(azitoCmd, 'service status');
  assert(service.status === 0 && /service:\s+not installed/.test(service.output), 'azito service status without the task', service.output);
  // misao is installed by install.ps1 only without -NoService (smoke-misao-win32.ts checks that); here `azito misao status` must report nothing installed.
  const misao = azito(azitoCmd, 'misao status');
  assert(misao.status === 0 && /service:\s+not installed/.test(misao.output) && /installed:\s+-/.test(misao.output), 'azito misao status without the task must say it is not installed', misao.output);
  console.log(`[smoke-install] azito service status -> ${service.output.trim()}\n[smoke-install] azito misao status -> ${misao.output.trim()}`);
  const unknown = azito(azitoCmd, 'bogus');
  assert(unknown.status === 1 && /Unknown command/.test(unknown.output), 'an unknown command must fail', unknown.output);
}

async function checkStart(installPs1: string, azitoCmd: string, prefix: string): Promise<string> {
  step('azito run runs the hub in the foreground with hub/.env and /api/health answers');
  const envFile = path.join(prefix, 'hub', '.env');
  const port = await freePort();
  // The installed file asks for port 3001, which may be taken on a shared runner: edit the value in place (the ACL stays).
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf-8').replace(/^PORT=.*$/m, `PORT=${port}`));

  let output = '';
  let failure: Error | null = null;
  let exited = false;
  const env = { ...process.env };
  delete env.AZITO_WEBHOOK_TOKEN;
  delete env.AZITO_MASTER_KEY;
  const child: ChildProcess = spawn(CMD, cmdLine(azitoCmd, 'run'), { stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true, env });
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.on('error', (err) => { failure = new Error(`could not start azito run: ${err.message}`); exited = true; });
  child.on('exit', (code) => { failure ??= new Error(`azito run exited (code ${code}) before /api/health answered`); exited = true; });
  try {
    const status = await waitForHealth(`http://127.0.0.1:${port}/api/health`, () => failure);
    console.log(`[smoke-install] /api/health -> ${status}`);
    assert(fs.existsSync(path.join(prefix, 'data', 'data.db')), 'the hub must use the AZITO_DATA_DIR from hub/.env', output);
    const refused = install(installPs1, ['-Uninstall', '-Prefix', prefix, '-Yes']);
    assert(refused.status !== 0 && /hub process/i.test(refused.output) && /still running/i.test(refused.output) && /Nothing was removed:/i.test(refused.output) && !/Fatal error starting server:/.test(refused.output), 'uninstall must leave a foreground hub running', refused.output);
    assert((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 'uninstall must not stop the foreground hub');
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
  return output;
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
    // install.ps1 keeps its functions inside one script block (so `irm | iex` leaves nothing behind): take the two under test out of its syntax tree.
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${installPs1.replace(/'/g, "''")}', [ref]$null, [ref]$null)`,
    "$found = $ast.FindAll({ param($n) ($n -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and (($n.Name -eq 'Add-UserPathEntry') -or ($n.Name -eq 'Remove-RecordedPathEntry') -or ($n.Name -eq 'Send-EnvironmentChange')) }, $true)",
    "if (@($found).Count -ne 3) { throw 'PATH functions not found in install.ps1' }",
    'foreach ($function in $found) { . ([scriptblock]::Create($function.Extent.Text)) }',
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
    "  Remove-RecordedPathEntry 'C:\\Foo Bar (x)\\bin'",
    "  Write-Output \"after=$($key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))\"",
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
  assert(lines.includes('after=%USERPROFILE%\\.azito-test-bin;C:\\Existing'), 'only the recorded entry must be removed', r.output);
}

function checkTailscaleDns(installPs1: string, work: string): void {
  step('Tailscale status exposes only the local DNS name or a fixed failure reason');
  const fake = path.join(work, 'fake-tailscale.exe');
  const script = path.join(work, 'tailscale-check.ps1');
  fs.writeFileSync(script, [
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${installPs1.replace(/'/g, "''")}', [ref]$null, [ref]$null)`,
    "$found = $ast.FindAll({ param($n) ($n -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and $n.Name -eq 'Get-TailscaleDns' }, $true)",
    "if (@($found).Count -ne 1) { throw 'Get-TailscaleDns not found' }",
    '$definition = @($found)[0].Extent.Text',
    '. ([scriptblock]::Create($definition))',
    `$fake = '${fake.replace(/'/g, "''")}'`,
    "Add-Type -OutputAssembly $fake -OutputType ConsoleApplication -TypeDefinition @'",
    'using System;',
    'using System.Threading;',
    'public class FakeTailscale {',
    '  public static int Main() {',
    // Raw UTF-8 bytes like the real Tailscale, without changing any console code page.
    '    Console.SetOut(new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });',
    '    string mode = Environment.GetEnvironmentVariable("AZITO_TEST_TAILSCALE_MODE");',
    '    Console.Error.WriteLine("person@example.com fictional-peer 192.0.2.55");',
    '    if (mode == "timeout") { Thread.Sleep(30000); return 0; }',
    '    if (mode == "exit") { Console.WriteLine("person@example.com fictional-peer 192.0.2.55"); return 1; }',
    '    if (mode == "invalid") { Console.WriteLine("person@example.com fictional-peer 192.0.2.55 {"); return 0; }',
    '    if (mode == "missing") { Console.WriteLine("{\\"Self\\":{},\\"Peer\\":\\"fictional-peer\\"}"); return 0; }',
    '    string dns = mode == "success" ? "\\u65e5\\u672c.example.ts.net." : "local.example.ts.net.";',
    '    Console.WriteLine("{\\"Self\\":{\\"DNSName\\":\\"" + dns + "\\"},\\"User\\":{\\"DisplayName\\":\\"\\u592a\\u90ce" + (char)92 + (char)34 + "X\\",\\"LoginName\\":\\"person@example.com\\"},\\"Peer\\":\\"fictional-peer 192.0.2.55\\"}");',
    '    return 0;',
    '  }',
    '}',
    "'@",
    "if ($env:AZITO_TEST_TAILSCALE_MODE -eq 'start') { $fake = Join-Path $fake 'missing.exe' }",
    // The console may be shared with the caller, so its code page is put back before anything is written.
    '$savedOutputEncoding = [Console]::OutputEncoding',
    'try {',
    '  [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(932)',
    "  if ($env:AZITO_TEST_TAILSCALE_MODE -in @('success', 'ascii')) {",
    "    $expected = if ($env:AZITO_TEST_TAILSCALE_MODE -eq 'ascii') { 'local.example.ts.net' } else { ([string][char]0x65e5) + ([string][char]0x672c) + '.example.ts.net' }",
    "    $old = $definition -replace '(?m)^.*\\$info\\.Standard(Output|Error)Encoding.*\\r?\\n', ''",
    '    . ([scriptblock]::Create($old))',
    '    $oldResult = @(Get-TailscaleDns $fake *>&1)',
    '    $oldWarnings = @($oldResult | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })',
    '    $oldValues = @($oldResult | Where-Object { $null -ne $_ -and $_ -isnot [System.Management.Automation.WarningRecord] })',
    "    if ($oldValues.Count -ne 0 -or $oldWarnings.Count -ne 1 -or $oldWarnings[0].Message -cne 'Tailscale status returned invalid JSON') { throw 'the old decoder did not reject the corrupted JSON under code page 932' }",
    '    . ([scriptblock]::Create($definition))',
    '    $newResult = @(Get-TailscaleDns $fake *>&1)',
    '    $newWarnings = @($newResult | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })',
    '    $newValues = @($newResult | Where-Object { $null -ne $_ -and $_ -isnot [System.Management.Automation.WarningRecord] })',
    "    if ($newWarnings.Count -ne 0 -or $newValues.Count -ne 1 -or $newValues[0] -cne $expected) { throw 'the DNS name was not decoded as UTF-8' }",
    "    $result = @($(if ($env:AZITO_TEST_TAILSCALE_MODE -eq 'ascii') { 'local.example.ts.net' } else { 'UTF-8 DNS verified' }))",
    '  } else {',
    '    $result = @(Get-TailscaleDns $fake *>&1)',
    '  }',
    '} finally {',
    '  [Console]::OutputEncoding = $savedOutputEncoding',
    '}',
    '$result | Where-Object { $null -ne $_ } | ForEach-Object { Write-Output $_.ToString() }',
    '',
  ].join('\r\n'));
  // Each run compiles an isolated fake executable.
  const cases: Array<[string, string]> = [
    ['success', 'UTF-8 DNS verified'],
    ['ascii', 'local.example.ts.net'],
    ['start', 'could not start Tailscale'],
    ['invalid', 'Tailscale status returned invalid JSON'],
    ['exit', 'Tailscale status failed'],
    ['missing', 'Tailscale status has no DNS name'],
    ['timeout', 'Tailscale status timed out'],
  ];
  for (const [mode, expected] of cases) {
    if (fs.existsSync(fake)) fs.rmSync(fake);
    const r = powershell(['-File', script], { ...process.env, AZITO_TEST_TAILSCALE_MODE: mode });
    assert(r.status === 0 && r.output.trim() === expected, `${mode}: expected only the DNS or fixed reason`, r.output);
    assert(!/person@example\.com|fictional-peer|192\.0\.2\.55/.test(r.output), `${mode}: Tailscale response leaked`, r.output);
  }
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
    checkTailscaleDns(installPs1, work);
    checkVerification(installPs1, zip, sums, work);
    // Spaces and parentheses in the prefix: the shape of a profile folder like "C:\Users\Foo Bar (Work)".
    const prefix = path.join(work, 'Foo Bar (Work)', '.azito');
    checkInstall(installPs1, zip, sums, prefix, version as string);
    const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
    checkCli(azitoCmd, prefix, version as string);
    await checkOrphanLauncher(prefix);
    await checkShortProcessPath(prefix);
    checkRepairAndDiagnostics(installPs1, zip, sums, path.join(work, 'Amp&Co', '.azito'), version as string);
    await checkStart(installPs1, azitoCmd, prefix);
    checkAccessRules(prefix);
    checkUserPath(installPs1, work);
    checkUninstall(installPs1, prefix, version as string);
    await checkRemoveData(installPs1, zip, sums, path.join(work, 'remove-data', '.azito'));
  } finally {
    // A leftover file must not replace the failure that got us here.
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`[smoke-install] could not remove ${work}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  step('ok');
}

main().catch((err) => {
  console.error('[smoke-install] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
