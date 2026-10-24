import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHubTaskXml, buildSingleRunLauncherScript, hubWindowsLayout, resolveWindowsUserId } from '../src/modules/system/windowsHubService';
import { powershellEncodedArgs } from '../src/shared/os/shellDialect';
import { encodeTaskXml } from '../src/shared/os/taskScheduler/taskDefinition';

/**
 * End-to-end check, on a real Windows (Windows PowerShell 5.1, the real schtasks.exe, node.exe, misao.exe), that the hub and the
 * hub's own misao come back from a crash by themselves (#380): `conhost.exe --headless` reports exit code 0 whatever its child did,
 * so the Task Scheduler never restarts either of them, and what does is the hub's launcher (AzitoHub) and the hub's watchdog (AzitoMisao).
 *
 * install.ps1 WITHOUT -NoService into a throwaway prefix, then:
 *  - the hub's node.exe is ended forcibly: /api/health answers again by itself, hub.log and `azito status` say so, and a second crash
 *    waits twice as long;
 *  - `azito service restart` still leaves exactly one hub (no port conflict) and a launcher with no restarts of its own;
 *  - misao.exe is ended forcibly: the hub's watchdog starts the task again and the pipe answers;
 *  - `azito stop` leaves the hub down (the launcher does not outlive the task);
 *  - a hub that follows a process that is gone shuts down gracefully with exit code 0 (so the launcher does not start it again);
 *  - the task as the first 0.12 builds registered it is replaced by `azito service install`.
 * The tasks are deleted at the end whatever happened. A skipped step is a failure, never a pass.
 * Usage: tsx smoke-recovery-win32.ts <azito-hub-*-win32-x64.zip> <SHA256SUMS> <install.ps1>
 */

const HUB_TASK = 'AzitoHub';
const MISAO_TASK = 'AzitoMisao';
const PORT = 3001; // what init-env writes to hub\.env; install.ps1 starts the hub before any file can be edited
const SIDE_PORT = 3101; // the hub started by hand to read its exit code
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SYSTEM_ROOT = process.env.SystemRoot ?? '';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const SCHTASKS = path.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');
/** The target for the hub to be back: the launcher waits 5 s, then run.ps1 and node start. */
const HUB_RECOVERY_TARGET_S = 30;
const HUB_RECOVERY_LIMIT_S = 60;

interface Result { status: number | null; output: string }

function step(message: string): void {
  console.log(`[smoke-recovery] ${message}`);
}

function assert(condition: boolean, message: string, detail = ''): void {
  if (!condition) throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function powershell(args: string[]): Result {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf-8', timeout: 300_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** The cmd.exe command line that runs `"<script>" <args>`: /s strips the outer quotes, so the script path keeps its own. */
function azito(azitoCmd: string, args: string): Result {
  const r = spawnSync(CMD, ['/d', '/s', '/c', `""${azitoCmd}" ${args}"`], { encoding: 'utf-8', timeout: 180_000, windowsVerbatimArguments: true });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function schtasks(args: string[]): Result {
  const r = spawnSync(SCHTASKS, args, { encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function healthStatus(port = PORT): Promise<number | null> {
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

/** The process ids of node.exe processes whose command line has the bundle's azito-hub.cjs. */
function hubNodePids(entryFragment: string): number[] {
  const script = [
    `$fragment = '${entryFragment.replace(/'/g, "''")}'`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }",
  ].join('\n');
  const r = powershell(['-Command', script]);
  assert(r.status === 0, 'could not list node.exe processes', r.output);
  return r.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
}

/** The process ids of the misao.exe processes of this user that serve `pipe` (its command line names the pipe). */
function misaoPids(pipe: string): number[] {
  const script = [
    `$pipe = '${pipe.replace(/'/g, "''")}'`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'misao.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($pipe, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }",
  ].join('\n');
  const r = powershell(['-Command', script]);
  assert(r.status === 0, 'could not list misao.exe processes', r.output);
  return r.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
}

/** Ends the process the way a crash would: no chance to shut down. */
function killForcibly(pids: number[]): void {
  const r = powershell(['-Command', `Stop-Process -Id ${pids.join(',')} -Force -ErrorAction Stop`]);
  assert(r.status === 0, `Stop-Process failed for ${pids.join(',')}`, r.output);
}

function readLog(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : `(no log file ${file})`;
}

function envValue(envFile: string, key: string): string | undefined {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Ends the hub with `kill`, and returns how many seconds it took for /api/health to answer again from a different node.exe. */
async function crashHubAndTimeRecovery(entryFragment: string, hubLog: string): Promise<number> {
  const before = hubNodePids(entryFragment);
  assert(before.length === 1, `exactly one hub node.exe must run before the crash (found ${before.length})`);
  const killedAt = Date.now();
  killForcibly(before);
  await waitFor('the hub to come back by itself', async () => {
    const now = hubNodePids(entryFragment);
    return now.length === 1 && now[0] !== before[0] && (await healthStatus()) === 200;
  }, HUB_RECOVERY_LIMIT_S * 1000, () => readLog(hubLog));
  return Math.round((Date.now() - killedAt) / 100) / 10;
}

async function main(): Promise<void> {
  const [zipArg, sumsArg, installArg] = process.argv.slice(2);
  if (!zipArg || !sumsArg || !installArg) throw new Error('usage: smoke-recovery-win32.ts <zip> <SHA256SUMS> <install.ps1>');
  const zip = path.resolve(zipArg);
  const sums = path.resolve(sumsArg);
  const installPs1 = path.resolve(installArg);
  const version = /^azito-hub-(.+)-win32-x64\.zip$/.exec(path.basename(zip))?.[1];
  assert(version !== undefined, `not an azito-hub-<tag>-win32-x64.zip: ${zip}`);
  assert(powershell(['-Command', '$PSVersionTable.PSVersion.Major']).output.trim() === '5', 'install.ps1 must be exercised by Windows PowerShell 5.1');
  for (const task of [HUB_TASK, MISAO_TASK]) {
    assert(schtasks(['/Query', '/TN', task]).status !== 0, `a task named ${task} already exists on this machine; this smoke test owns that name`);
  }
  assert((await healthStatus()) === null, `something already answers on ${BASE_URL}`);
  assert((await healthStatus(SIDE_PORT)) === null, `something already answers on port ${SIDE_PORT}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-recovery-smoke-'));
  // A prefix with spaces and parentheses, the shape of "C:\Users\Foo Bar (Work)".
  const prefix = path.join(work, 'Foo Bar (Work)', '.azito');
  const hubRoot = path.join(prefix, 'hub');
  const hubLog = path.join(prefix, 'logs', 'hub.log');
  const misaoRoot = path.join(prefix, 'misao');
  const misaoLog = path.join(misaoRoot, 'misao.log');
  const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
  const envFile = path.join(hubRoot, '.env');
  const definitionCopy = path.join(os.homedir(), '.azito', 'service', `${HUB_TASK}.xml`);
  let entryFragment = '';
  let pipe = '';
  let misaoExe = '';
  let cleanupFailure: string | undefined;

  const misaoStopCommand = (): void => {
    if (misaoExe === '' || !fs.existsSync(misaoExe) || pipe === '') return;
    spawnSync(misaoExe, ['stop'], { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, MISAO_SOCKET: pipe } });
  };

  try {
    step(`install.ps1 without -NoService into ${prefix}`);
    const installed = powershell(['-File', installPs1, '-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath']);
    console.log(installed.output);
    assert(installed.status === 0, 'install.ps1 failed', `${installed.output}\n--- hub.log ---\n${readLog(hubLog)}`);
    entryFragment = fs.realpathSync.native(path.join(hubRoot, version as string, 'azito-hub.cjs'));
    assert((await healthStatus()) === 200, '/api/health must answer 200 after the install');
    pipe = envValue(envFile, 'MISAO_SOCKET') ?? '';
    assert(/^\\\\\.\\pipe\\misao-/.test(pipe), 'hub\\.env must name the misao named pipe as MISAO_SOCKET', pipe);
    const release = fs.readdirSync(misaoRoot).find((name) => /^\d+\.\d+\.\d+$/.test(name));
    assert(release !== undefined, `a misao release folder must be in ${misaoRoot}`);
    misaoExe = path.join(misaoRoot, release as string, 'misao.exe');
    assert(misaoPids(pipe).length === 1, `exactly one misao.exe must serve ${pipe}`, readLog(misaoLog));
    const first = azito(azitoCmd, 'status');
    assert(/launcher:\s+no restart since the launcher began/.test(first.output), 'azito status must say the launcher has not restarted the hub yet', first.output);

    step('the hub crashes (node.exe ended forcibly): the launcher starts it again by itself');
    const firstSeconds = await crashHubAndTimeRecovery(entryFragment, hubLog);
    console.log(`[smoke-recovery] hub back after ${firstSeconds}s (target ${HUB_RECOVERY_TARGET_S}s)`);
    assert(firstSeconds <= HUB_RECOVERY_LIMIT_S, `the hub must come back within ${HUB_RECOVERY_LIMIT_S}s (took ${firstSeconds}s)`);
    let log = readLog(hubLog);
    assert(/launcher: run\.ps1 \(.+\) exited with code -?[1-9]\d*/.test(log) && /launcher: start 2 in 5s/.test(log), 'hub.log must record the exit code and the restart (5s)', log);
    const afterFirst = azito(azitoCmd, 'status');
    assert(/launcher:\s+1 restart since .*\(last exit code -?[1-9]\d*/.test(afterFirst.output), 'azito status must show the restart and the last exit code', afterFirst.output);
    assert(/service:\s+taskscheduler \(active\)/.test(afterFirst.output), 'the task is still the one running (Last Result stays 0 whatever happened)', afterFirst.output);

    step('a second crash right after: the wait doubles');
    const secondSeconds = await crashHubAndTimeRecovery(entryFragment, hubLog);
    console.log(`[smoke-recovery] hub back after ${secondSeconds}s (the wait is 10s this time)`);
    log = readLog(hubLog);
    assert(/launcher: start 3 in 10s/.test(log), 'the second restart must wait 10s', log);

    step('azito service restart: exactly one hub, no port conflict, and the new launcher has no restarts');
    const logBefore = readLog(hubLog).length;
    const restart = azito(azitoCmd, 'service restart');
    assert(restart.status === 0 && !/forcibly/.test(restart.output), 'azito service restart failed', restart.output);
    await waitFor('/api/health after restart', async () => (await healthStatus()) === 200, 90_000, () => readLog(hubLog));
    await sleep(8000); // a second hub from a launcher that did not end would have shown itself by now
    assert(hubNodePids(entryFragment).length === 1, 'exactly one hub node.exe after the restart');
    assert(!/EADDRINUSE/.test(readLog(hubLog).slice(logBefore)), 'the restart must not meet the old hub on the port', readLog(hubLog).slice(logBefore));
    assert(/launcher:\s+no restart since the launcher began/.test(azito(azitoCmd, 'status').output), 'the new launcher starts with no restarts');

    step('misao.exe crashes (ended forcibly): the hub starts its task again');
    const misaoBefore = misaoPids(pipe);
    assert(misaoBefore.length === 1, 'one misao.exe before the crash');
    const misaoKilledAt = Date.now();
    killForcibly(misaoBefore);
    await waitFor('the misao daemon to answer again (the hub\'s watchdog)', () => {
      const now = misaoPids(pipe);
      return now.length === 1 && now[0] !== misaoBefore[0] && /daemon:\s+reachable/.test(azito(azitoCmd, 'misao status').output);
    }, 240_000, () => `${readLog(hubLog)}\n--- misao.log ---\n${readLog(misaoLog)}`);
    console.log(`[smoke-recovery] misao back after ${Math.round((Date.now() - misaoKilledAt) / 1000)}s`);
    log = readLog(hubLog);
    assert(/\[misao-recovery\] the misao does not answer; trying to bring it back in 60s/.test(log) && /\[misao-recovery\] tried to bring the misao back \(attempt 1\): started/.test(log), 'hub.log must record the watchdog\'s attempt', log);

    step('azito stop: the hub stays down (the launcher ends with the task) and misao keeps running');
    const misaoNow = misaoPids(pipe);
    const stop = azito(azitoCmd, 'stop');
    assert(stop.status === 0, 'azito stop failed', stop.output);
    await sleep(30_000); // longer than the first waits of the launcher
    assert(hubNodePids(entryFragment).length === 0 && (await healthStatus()) === null, 'the hub must stay down after azito stop');
    assert(JSON.stringify(misaoPids(pipe)) === JSON.stringify(misaoNow), 'azito stop must leave misao as it was');
    assert(!/launcher: start \d+ in/.test(readLog(hubLog).slice(log.length)), 'no restart may be logged after azito stop', readLog(hubLog).slice(log.length));

    step('a hub whose followed process is gone shuts down gracefully with exit code 0');
    const sacrificial = spawn(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Seconds 600'], { stdio: 'ignore' });
    const bundle = path.join(hubRoot, version as string);
    const sideData = path.join(work, 'side-data');
    let sideOutput = '';
    const side = spawn(path.join(bundle, 'node.exe'), ['azito-hub.cjs'], {
      cwd: bundle,
      env: { ...process.env, AZITO_DATA_DIR: sideData, AZITO_BIND: '127.0.0.1', PORT: String(SIDE_PORT), MISAO_SOCKET: pipe, NODE_PATH: path.join(bundle, 'node_modules'), AZITO_HUB_EXIT_WITH_PID: String(sacrificial.pid) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    side.stdout.on('data', (chunk: Buffer) => { sideOutput += chunk.toString('utf-8'); });
    side.stderr.on('data', (chunk: Buffer) => { sideOutput += chunk.toString('utf-8'); });
    const sideExit = new Promise<number | null>((resolve) => { side.once('exit', (code) => resolve(code)); });
    try {
      await waitFor('the side hub to answer', async () => (await healthStatus(SIDE_PORT)) === 200, 90_000, () => sideOutput);
      sacrificial.kill();
      const code = await Promise.race([sideExit, sleep(60_000).then(() => 'timeout' as const)]);
      console.log(`[smoke-recovery] graceful shutdown exit code: ${code}`);
      assert(code === 0, `a hub that shuts down because the process it follows is gone must exit with code 0 (got ${code})`, sideOutput);
      assert(/shutting down/.test(sideOutput), 'the side hub must have logged its shutdown', sideOutput);
    } finally {
      sacrificial.kill();
      side.kill();
    }

    step('the task as the first 0.12 builds registered it is replaced by azito service install');
    const layout = hubWindowsLayout(fs.realpathSync.native(prefix));
    const current = buildHubTaskXml({ userId: resolveWindowsUserId(process.env), systemRoot: SYSTEM_ROOT, layout });
    const old = current.replace(/-EncodedCommand [A-Za-z0-9+/=]+/, `-EncodedCommand ${powershellEncodedArgs(buildSingleRunLauncherScript(layout)).at(-1)}`);
    assert(old !== current, 'the old definition must differ from the current one');
    const oldFile = path.join(work, 'old-task.xml');
    fs.writeFileSync(oldFile, encodeTaskXml(old));
    const created = schtasks(['/Create', '/TN', HUB_TASK, '/XML', oldFile, '/F']);
    assert(created.status === 0, 'could not register the old-format task', created.output);
    const oldStatus = azito(azitoCmd, 'status');
    assert(oldStatus.status === 0 && !/not registered any more/.test(oldStatus.output), 'azito status must still work for the old-format task', oldStatus.output);
    const replaced = azito(azitoCmd, 'service install');
    assert(replaced.status === 0 && !/already registered/.test(replaced.output), 'azito service install must replace the old-format task', replaced.output);
    const registered = schtasks(['/Query', '/TN', HUB_TASK, '/XML']).output;
    const launcher = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(registered)?.[1] ?? '', 'base64').toString('utf16le');
    assert(launcher.includes('while ($true)'), 'the registered launcher must now be the looping one', launcher);
    const again = azito(azitoCmd, 'service install');
    assert(again.status === 0 && /already registered/.test(again.output), 'a second azito service install changes nothing', again.output);
    assert(azito(azitoCmd, 'start').status === 0, 'azito start after the replacement');
    await waitFor('/api/health after the replacement', async () => (await healthStatus()) === 200, 90_000, () => readLog(hubLog));
    const finalSeconds = await crashHubAndTimeRecovery(entryFragment, hubLog);
    console.log(`[smoke-recovery] hub back after ${finalSeconds}s with the replaced task`);
  } catch (err) {
    console.error(`[smoke-recovery] hub.log:\n${readLog(hubLog)}\n[smoke-recovery] misao.log:\n${readLog(misaoLog)}`);
    console.error(`[smoke-recovery] task state:\n${schtasks(['/Query', '/TN', HUB_TASK, '/V', '/FO', 'LIST']).output}`);
    throw err;
  } finally {
    step('cleanup: stop the hub and misao, delete the tasks');
    if (fs.existsSync(azitoCmd)) azito(azitoCmd, 'stop');
    misaoStopCommand();
    for (const task of [HUB_TASK, MISAO_TASK]) {
      schtasks(['/End', '/TN', task]);
      const deleted = schtasks(['/Delete', '/TN', task, '/F']);
      if (schtasks(['/Query', '/TN', task]).status === 0) cleanupFailure = `could not delete the task ${task}: ${deleted.output.trim()}`;
    }
    if (pipe !== '' && misaoPids(pipe).length > 0) cleanupFailure = `a misao.exe is still running for ${pipe}`;
    if (entryFragment !== '' && hubNodePids(entryFragment).length > 0) cleanupFailure = 'a hub node.exe is still running';
    fs.rmSync(definitionCopy, { force: true });
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`[smoke-recovery] could not remove ${work}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A task or a process left behind on the machine is a failure of the test, not a warning.
  if (cleanupFailure) throw new Error(cleanupFailure);
  step('ok');
}

main().catch((err) => {
  console.error('[smoke-recovery] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
