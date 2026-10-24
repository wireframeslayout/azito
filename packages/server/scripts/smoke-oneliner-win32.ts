import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { readEnvValue } from '../src/shared/envFile';

/**
 * End-to-end check of install.ps1 run as TEXT on a real Windows PowerShell 5.1 (the way `irm <url> | iex` and
 * `& ([scriptblock]::Create((irm <url>))) <args>` run it), not as a file:
 *  - `Get-Content -Raw install.ps1 | iex` with the options given by AZITO_INSTALL_* variables, and the real `irm | iex` from a local
 *    web server that answers with the content type GitHub uses for release assets;
 *  - the script block with arguments (`-Port`, `-Yes`, ...) and the Task Scheduler task, `azito restart`;
 *  - the caller's session survives (the next line runs), keeps its $ErrorActionPreference and gets no variable, function or temp folder;
 *  - a failure (SHA256 mismatch, no git) stops with a reason and a non-zero exit, and the guidance for a missing git;
 *  - a release-stamped installer names its own tag and does not ask for "latest".
 * Usage: tsx smoke-oneliner-win32.ts <azito-hub-*-win32-x64.zip> <SHA256SUMS> <install.ps1>
 */

const STARTUP_TIMEOUT_MS = 90_000;
const RELEASE_TAG_PLACEHOLDER = '__AZITO_RELEASE_TAG__';
const TASK_NAME = 'AzitoHub';
const MISAO_TASK_NAME = 'AzitoMisao';
const SYSTEM_ROOT = process.env.SystemRoot ?? '';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const TASKKILL = path.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');
const SCHTASKS = path.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');

interface Result { status: number | null; output: string }

function step(message: string): void {
  console.log(`[smoke-oneliner] ${message}`);
}

function assert(condition: boolean, message: string, detail = ''): void {
  if (!condition) throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function powershell(args: string[], env: NodeJS.ProcessEnv = process.env): Result {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf-8', timeout: 300_000, env });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function schtasks(args: string[]): Result {
  const r = spawnSync(SCHTASKS, args, { encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** The cmd.exe command line that runs `"<script>" <args>`: /s strips the outer quotes, so the script path keeps its own. */
function cmdLine(script: string, args: string): string[] {
  return ['/d', '/s', '/c', `""${script}" ${args}"`];
}

function azito(azitoCmd: string, args: string): Result {
  const r = spawnSync(CMD, cmdLine(azitoCmd, args), { encoding: 'utf-8', timeout: 180_000, windowsVerbatimArguments: true });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

async function healthStatus(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return null;
  }
}

async function waitFor(what: string, condition: () => Promise<boolean> | boolean, timeoutMs: number, detail: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(500);
  }
  throw new Error(`${what} (waited ${timeoutMs / 1000}s)\n${detail()}`);
}

function installTempFolders(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('azito-install-') && !name.startsWith('azito-install-smoke-'));
}

/** The node.exe processes of this user whose command line names the bundle's azito-hub.cjs. */
function hubNodePids(entryFragment: string): number[] {
  const script = [
    `$fragment = ${psQuote(entryFragment)}`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }",
  ].join('\n');
  const r = powershell(['-Command', script]);
  assert(r.status === 0, 'could not list node.exe processes', r.output);
  return r.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
}

/** `misao stop` of the release install.ps1 put under `<prefix>\misao`, on the pipe hub\.env names (nothing is done when it was never installed). */
function stopInstalledMisao(prefix: string): void {
  const root = path.join(prefix, 'misao');
  const envFile = path.join(prefix, 'hub', '.env');
  if (!fs.existsSync(root) || !fs.existsSync(envFile)) return;
  const pipe = readEnvValue(envFile, 'MISAO_SOCKET');
  const release = fs.readdirSync(root).find((name) => /^\d+\.\d+\.\d+$/.test(name));
  if (!pipe || !release) return;
  spawnSync(path.join(root, release, 'misao.exe'), ['stop'], { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, MISAO_SOCKET: pipe } });
}

/** The way install.ps1 is given to a PowerShell that runs it as text, and what the caller's session looks like afterwards. */
function callerScript(work: string, name: string, invocation: string): string {
  const file = path.join(work, `${name}.ps1`);
  fs.writeFileSync(file, [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'Continue'",
    "$functionsBefore = @(Get-ChildItem Function: | ForEach-Object { $_.Name })",
    '$variablesBefore = @(Get-Variable | ForEach-Object { $_.Name })',
    invocation,
    "Write-Output 'CALLER-CONTINUES'",
    'Write-Output "preferences=$ErrorActionPreference/$ProgressPreference"',
    // LASTEXITCODE is the one variable every native command sets in the global scope.
    "Write-Output ('leaked-variables=' + (@(Get-Variable | ForEach-Object { $_.Name } | Where-Object { ($variablesBefore -notcontains $_) -and ($_ -ne 'LASTEXITCODE') }) -join ','))",
    "Write-Output ('leaked-functions=' + (@(Get-ChildItem Function: | ForEach-Object { $_.Name } | Where-Object { $functionsBefore -notcontains $_ }) -join ','))",
    '',
  ].join('\r\n'));
  return file;
}

function assertCallerSurvived(r: Result, what: string): void {
  assert(r.output.includes('CALLER-CONTINUES'), `${what}: the line after the installer must run (the installer must not end the caller's PowerShell)`, r.output);
  assert(r.output.includes('preferences=Continue/Continue'), `${what}: $ErrorActionPreference / $ProgressPreference must be the caller's`, r.output);
  assert(/^leaked-variables=$/m.test(r.output), `${what}: no variable may be left in the caller's session`, r.output);
  assert(/^leaked-functions=$/m.test(r.output), `${what}: no function may be left in the caller's session`, r.output);
}

function assertPortConfigured(prefix: string, port: number): void {
  const envFile = path.join(prefix, 'hub', '.env');
  assert(readEnvValue(envFile, 'PORT') === String(port), `hub/.env must hold PORT=${port}`, fs.readFileSync(envFile, 'utf-8'));
  const origins = readEnvValue(envFile, 'AZITO_ALLOWED_ORIGINS') ?? '';
  assert(origins.split(',').includes(`http://localhost:${port}`) && origins.split(',').includes(`http://127.0.0.1:${port}`), `AZITO_ALLOWED_ORIGINS must name port ${port}`, origins);
  assert(!origins.includes('3001'), 'AZITO_ALLOWED_ORIGINS must not keep the default port', origins);
}

/** `azito run` (the hub in the foreground, with the PORT of hub\.env) and /api/health on the expected port. */
async function runHubAndCheck(azitoCmd: string, port: number): Promise<void> {
  let output = '';
  let failure: Error | null = null;
  let exited = false;
  const child: ChildProcess = spawn(CMD, cmdLine(azitoCmd, 'run'), { stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true });
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.on('error', (err) => { failure = new Error(`could not start azito run: ${err.message}`); exited = true; });
  child.on('exit', (code) => { failure ??= new Error(`azito run exited (code ${code}) before /api/health answered`); exited = true; });
  try {
    await waitFor(`/api/health on port ${port}`, async () => {
      if (failure) throw failure;
      return (await healthStatus(port)) === 200;
    }, STARTUP_TIMEOUT_MS, () => output);
    console.log(`[smoke-oneliner] /api/health on ${port} -> 200`);
  } catch (err) {
    console.error(`[smoke-oneliner] hub output:\n${output}`);
    throw err;
  } finally {
    if (!exited && child.pid) {
      spawnSync(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf-8' });
      await sleep(1500);
    }
  }
}

/** Serves install.ps1 the way GitHub serves a release asset (application/octet-stream), for the real `irm | iex`. */
function serveInstaller(text: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(text);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/install.ps1`, close: () => server.close() });
    });
  });
}

function offlineEnv(zip: string, sums: string, prefix: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AZITO_INSTALL_ZIPPATH: zip,
    AZITO_INSTALL_SHA256SUMS: sums,
    AZITO_INSTALL_PREFIX: prefix,
    AZITO_INSTALL_PORT: String(port),
    AZITO_INSTALL_YES: '1',
    AZITO_INSTALL_NOPATH: '1',
    AZITO_INSTALL_NOSERVICE: '1',
  };
}

async function checkIex(installPs1: string, zip: string, sums: string, work: string): Promise<void> {
  step('Get-Content -Raw install.ps1 | iex: installs from AZITO_INSTALL_* variables, the caller goes on and is left clean');
  const port = await freePort();
  const prefix = path.join(work, 'iex', 'Foo Bar (Work)', '.azito');
  const tempBefore = installTempFolders();
  const script = callerScript(work, 'iex-caller', `Get-Content -Raw -LiteralPath ${psQuote(installPs1)} | Invoke-Expression`);
  const r = powershell(['-File', script], offlineEnv(zip, sums, prefix, port));
  assert(r.status === 0 && r.output.includes('Installation complete!'), 'the iex install must succeed', r.output);
  assertCallerSurvived(r, 'iex');
  assert(installTempFolders().length === tempBefore.length, 'the installer must remove its temporary folder', installTempFolders().join(', '));
  assertPortConfigured(prefix, port);
  assert(fs.existsSync(path.join(prefix, 'bin', 'azito.cmd')), 'missing bin/azito.cmd');
  const usage = azito(path.join(prefix, 'bin', 'azito.cmd'), '');
  assert(usage.status === 0 && /restart/.test(usage.output), 'azito usage must list restart', usage.output);
  await runHubAndCheck(path.join(prefix, 'bin', 'azito.cmd'), port);

  step('a failed iex install stops the caller\'s command with the reason and a non-zero exit, and the caller\'s session goes on');
  const bad = path.join(work, 'SHA256SUMS.bad');
  fs.writeFileSync(bad, fs.readFileSync(sums, 'utf-8').replace(/^[0-9a-f]/i, (c) => (c === '0' ? '1' : '0')));
  const failPrefix = path.join(work, 'iex-fail', '.azito');
  const failEnv = offlineEnv(zip, bad, failPrefix, port);
  const guarded = callerScript(work, 'iex-fail-caller', [
    'try {',
    `  Get-Content -Raw -LiteralPath ${psQuote(installPs1)} | Invoke-Expression`,
    "  Write-Output 'NOT-REACHED'",
    '} catch {',
    '  Write-Output "CAUGHT: $($_.Exception.Message)"',
    '}',
  ].join('\r\n'));
  const caught = powershell(['-File', guarded], failEnv);
  assert(/CAUGHT: .*SHA256 mismatch/.test(caught.output) && !caught.output.includes('NOT-REACHED'), 'a mismatch must be thrown to the caller with its reason', caught.output);
  assertCallerSurvived(caught, 'iex failure');
  assert(!fs.existsSync(path.join(failPrefix, 'hub')), 'nothing may be written under the prefix after a mismatch');
  const plain = powershell(['-Command', `Get-Content -Raw -LiteralPath ${psQuote(installPs1)} | Invoke-Expression`], failEnv);
  assert(plain.status !== 0 && /SHA256 mismatch/.test(plain.output), 'an uncaught failure must exit non-zero and say why', plain.output);
}

async function checkIrm(installPs1: string, zip: string, sums: string, work: string): Promise<void> {
  step('the real `irm <url> | iex` (a local server answering application/octet-stream like a GitHub release asset)');
  const port = await freePort();
  const prefix = path.join(work, 'irm', '.azito');
  const server = await serveInstaller(fs.readFileSync(installPs1, 'utf-8'));
  try {
    const r = powershell(['-Command', `irm ${server.url} | iex`], offlineEnv(zip, sums, prefix, port));
    assert(r.status === 0 && r.output.includes('Installation complete!'), '`irm | iex` must install', r.output);
    assertPortConfigured(prefix, port);
  } finally {
    server.close();
  }
}

async function checkMissingGit(installPs1: string, zip: string, sums: string, work: string): Promise<void> {
  step('without git on the PATH the installer stops before writing anything and says how to install it');
  const prefix = path.join(work, 'nogit', '.azito');
  // The variable is `Path` on Windows: drop every spelling of it before setting ours, or the child may get both.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
  env.Path = [path.join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT].join(';');
  const r = powershell(['-File', installPs1, '-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath', '-NoService'], env);
  assert(r.status !== 0, 'a missing git must fail the install', r.output);
  assert(r.output.includes('winget install --id Git.Git -e --source winget'), 'the winget command must be shown', r.output);
  assert(r.output.includes('https://git-scm.com/download/win'), 'the download page must be shown', r.output);
  assert(/NEW PowerShell/.test(r.output), 'it must say to open a new PowerShell window', r.output);
  assert(!fs.existsSync(path.join(prefix, 'hub')), 'nothing may be written under the prefix');
}

function checkStamp(text: string, work: string): void {
  step('a release-stamped installer installs the tag it carries and does not ask for "latest"');
  assert(text.split(RELEASE_TAG_PLACEHOLDER).length === 2, `install.ps1 must hold ${RELEASE_TAG_PLACEHOLDER} exactly once (release.yml replaces it)`);
  const stamped = path.join(work, 'install-stamped.txt');
  fs.writeFileSync(stamped, text.replace(RELEASE_TAG_PLACEHOLDER, 'v9.9.9'));
  const prefix = path.join(work, 'stamped', '.azito');
  const r = powershell(['-Command', `& ([scriptblock]::Create((Get-Content -Raw -LiteralPath ${psQuote(stamped)}))) -Yes -NoPath -NoService -Prefix ${psQuote(prefix)}`]);
  // v9.9.9 does not exist: the download fails, after the installer said which release it went for.
  assert(r.status !== 0 && /Version:\s+v9\.9\.9/.test(r.output) && r.output.includes('Downloading azito-hub-v9.9.9-win32-x64.zip'), 'the stamped tag must decide the version', r.output);
  assert(!r.output.includes('Fetching latest release'), 'a stamped installer must not look up "latest"', r.output);
  assert(!fs.existsSync(path.join(prefix, 'hub', 'current.txt')), 'a failed download must leave no pointer');
}

async function checkScriptBlock(installPs1: string, zip: string, sums: string, work: string, version: string): Promise<void> {
  step('& ([scriptblock]::Create(...)) -Port -Yes ...: arguments, the Task Scheduler task and azito restart');
  const port = await freePort();
  const prefix = path.join(work, 'sb', 'Foo Bar (Work)', '.azito');
  const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
  const entryFragment = path.join(prefix, 'hub', version, 'azito-hub.cjs');
  const invocation = [
    `$text = Get-Content -Raw -LiteralPath ${psQuote(installPs1)}`,
    `& ([scriptblock]::Create($text)) -ZipPath ${psQuote(zip)} -Sha256Sums ${psQuote(sums)} -Prefix ${psQuote(prefix)} -Port ${port} -Yes -NoPath`,
  ].join('\r\n');
  try {
    // $text is the caller's own variable: the leak check starts after it exists, so it is not counted.
    const script = callerScript(work, 'sb-caller', `$text = $null\r\n$variablesBefore = @(Get-Variable | ForEach-Object { $_.Name })\r\n${invocation}`);
    const r = powershell(['-File', script]);
    assert(r.status === 0 && new RegExp(`AZITO is running at http://localhost:${port}/`).test(r.output), 'the script block install must start the hub on the given port', r.output);
    assertCallerSurvived(r, 'script block');
    assertPortConfigured(prefix, port);
    assert((await healthStatus(port)) === 200, `/api/health on ${port}`);

    const before = hubNodePids(fs.realpathSync.native(entryFragment));
    assert(before.length === 1, `exactly one hub node.exe before the restart (found ${before.length})`);
    step('azito restart starts the hub again on the same port');
    const restart = azito(azitoCmd, 'restart');
    assert(restart.status === 0, 'azito restart failed', restart.output);
    await waitFor('/api/health after azito restart', async () => (await healthStatus(port)) === 200, STARTUP_TIMEOUT_MS);
    const after = hubNodePids(fs.realpathSync.native(entryFragment));
    assert(after.length === 1 && after[0] !== before[0], 'azito restart must replace the hub process', `${before.join(',')} -> ${after.join(',')}\n${restart.output}`);

    step('a SHA256 mismatch through the script block stops with a non-zero exit');
    const bad = path.join(work, 'SHA256SUMS.bad2');
    fs.writeFileSync(bad, fs.readFileSync(sums, 'utf-8').replace(/^[0-9a-f]/i, (c) => (c === '0' ? '1' : '0')));
    const failed = powershell(['-Command', `& ([scriptblock]::Create((Get-Content -Raw -LiteralPath ${psQuote(installPs1)}))) -ZipPath ${psQuote(zip)} -Sha256Sums ${psQuote(bad)} -Prefix ${psQuote(path.join(work, 'sb-fail', '.azito'))} -Yes -NoPath -NoService`]);
    assert(failed.status !== 0 && /SHA256 mismatch/.test(failed.output), 'a mismatch must fail the script block form', failed.output);
  } finally {
    step('cleanup: stop and delete the tasks');
    if (fs.existsSync(azitoCmd)) azito(azitoCmd, 'stop');
    schtasks(['/End', '/TN', TASK_NAME]);
    schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
    stopInstalledMisao(prefix);
    schtasks(['/End', '/TN', MISAO_TASK_NAME]);
    schtasks(['/Delete', '/TN', MISAO_TASK_NAME, '/F']);
    fs.rmSync(path.join(os.homedir(), '.azito', 'service', `${TASK_NAME}.xml`), { force: true });
  }
  assert(schtasks(['/Query', '/TN', TASK_NAME]).status !== 0, `the task ${TASK_NAME} must be gone after the cleanup`);
  assert(schtasks(['/Query', '/TN', MISAO_TASK_NAME]).status !== 0, `the task ${MISAO_TASK_NAME} must be gone after the cleanup`);
}

async function main(): Promise<void> {
  const [zipArg, sumsArg, installArg] = process.argv.slice(2);
  if (!zipArg || !sumsArg || !installArg) throw new Error('usage: smoke-oneliner-win32.ts <zip> <SHA256SUMS> <install.ps1>');
  const zip = path.resolve(zipArg);
  const sums = path.resolve(sumsArg);
  const installPs1 = path.resolve(installArg);
  const version = /^azito-hub-(.+)-win32-x64\.zip$/.exec(path.basename(zip))?.[1];
  assert(version !== undefined, `not an azito-hub-<tag>-win32-x64.zip: ${zip}`);
  assert(powershell(['-Command', '$PSVersionTable.PSVersion.Major']).output.trim() === '5', 'install.ps1 must be exercised by Windows PowerShell 5.1');
  assert(schtasks(['/Query', '/TN', TASK_NAME]).status !== 0, `a task named ${TASK_NAME} already exists on this machine; this smoke test owns that name`);
  assert(schtasks(['/Query', '/TN', MISAO_TASK_NAME]).status !== 0, `a task named ${MISAO_TASK_NAME} already exists on this machine; this smoke test owns that name`);

  const text = fs.readFileSync(installPs1, 'utf-8');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-install-smoke-oneliner-'));
  try {
    await checkIex(installPs1, zip, sums, work);
    await checkIrm(installPs1, zip, sums, work);
    await checkMissingGit(installPs1, zip, sums, work);
    checkStamp(text, work);
    await checkScriptBlock(installPs1, zip, sums, work, version as string);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`[smoke-oneliner] could not remove ${work}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  step('ok');
}

main().catch((err) => {
  console.error('[smoke-oneliner] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
