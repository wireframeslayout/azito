import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * End-to-end check of the hub as a Task Scheduler task on a real Windows (Windows PowerShell 5.1, the real schtasks.exe):
 * install.ps1 WITHOUT -NoService registers the task `AzitoHub` for a throwaway prefix and starts it (a `/Run`, not a logon), then
 * `/api/health`, `azito status`, the log, `azito stop` (no node.exe left), `schtasks /End` alone (the hub ends by itself when its
 * conhost.exe is gone), `azito start` and `azito service restart`. The task is deleted at the end whatever happened.
 * The task keeps its product name: it only exists inside the CI runner. A skipped step is a failure, never a pass.
 * Usage: tsx smoke-service-win32.ts <azito-hub-*-win32-x64.zip> <SHA256SUMS> <install.ps1>
 */

const TASK_NAME = 'AzitoHub';
const PORT = 3001; // what init-env writes to hub\.env; install.ps1 starts the hub before any file can be edited
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const SYSTEM_ROOT = process.env.SystemRoot ?? '';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const SCHTASKS = path.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');

interface Result { status: number | null; output: string }

function step(message: string): void {
  console.log(`[smoke-service] ${message}`);
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

async function healthStatus(): Promise<number | null> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
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

/** The process ids of node.exe processes of this user whose command line has the bundle's azito-hub.cjs. */
function hubNodePids(entryFragment: string): number[] {
  const script = [
    `$fragment = '${entryFragment.replace(/'/g, "''")}'`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }",
  ].join('\n');
  const r = powershell(['-Command', script]);
  assert(r.status === 0, 'could not list node.exe processes', r.output);
  return r.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
}

/** `pid` and its ancestors (name + id), for the diagnosis of what survives the Task Scheduler's End. */
function ancestorsOf(pid: number): Array<{ pid: number; name: string }> {
  const script = [
    `$id = ${pid}`,
    'while ($id) { $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id"; if (-not $p) { break }; "$($p.ProcessId) $($p.Name)"; $id = $p.ParentProcessId }',
  ].join('\n');
  const r = powershell(['-Command', script]);
  return r.output.split(/\r?\n/).map((l) => /^(\d+) (\S+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ pid: Number(m[1]), name: m[2] }));
}

function processAlive(pid: number): boolean {
  const r = powershell(['-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`]);
  return r.output.trim() === 'yes';
}

function readLog(logFile: string): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '(no log file)';
}

async function main(): Promise<void> {
  const [zipArg, sumsArg, installArg] = process.argv.slice(2);
  if (!zipArg || !sumsArg || !installArg) throw new Error('usage: smoke-service-win32.ts <zip> <SHA256SUMS> <install.ps1>');
  const zip = path.resolve(zipArg);
  const sums = path.resolve(sumsArg);
  const installPs1 = path.resolve(installArg);
  const version = /^azito-hub-(.+)-win32-x64\.zip$/.exec(path.basename(zip))?.[1];
  assert(version !== undefined, `not an azito-hub-<tag>-win32-x64.zip: ${zip}`);
  assert(powershell(['-Command', '$PSVersionTable.PSVersion.Major']).output.trim() === '5', 'install.ps1 must be exercised by Windows PowerShell 5.1');
  assert(schtasks(['/Query', '/TN', TASK_NAME]).status !== 0, `a task named ${TASK_NAME} already exists on this machine; this smoke test owns that name`);
  assert((await healthStatus()) === null, `something already answers on ${HEALTH_URL}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-service-smoke-'));
  // A prefix with spaces and parentheses, the shape of "C:\Users\Foo Bar (Work)".
  const prefix = path.join(work, 'Foo Bar (Work)', '.azito');
  const hubRoot = path.join(prefix, 'hub');
  const logFile = path.join(prefix, 'logs', 'hub.log');
  const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
  
  let entryFragment = '';
  let azito2 = '';
  let cleanupFailure: string | undefined;
  const definitionCopy = path.join(os.homedir(), '.azito', 'service', `${TASK_NAME}.xml`);

  try {
    step(`install.ps1 without -NoService into ${prefix}`);
    const installed = powershell(['-File', installPs1, '-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath']);
    console.log(installed.output);
    // The hub's command line has the path as PowerShell resolved it (8.3 short names such as RUNNER~1 come out long).
    entryFragment = fs.realpathSync.native(path.join(hubRoot, version as string, 'azito-hub.cjs'));
    assert(installed.status === 0, 'install.ps1 failed', `${installed.output}\n--- hub.log ---\n${readLog(logFile)}`);
    assert(/AZITO is running at http:\/\/localhost:3001\//.test(installed.output), 'install.ps1 must wait for /api/health and say the hub is running', installed.output);

    step('the task is registered for the logon of this user and is started by /Run (not by a logon)');
    const query = schtasks(['/Query', '/TN', TASK_NAME, '/XML']);
    assert(query.status === 0, 'schtasks /Query failed', query.output);
    assert(/<LogonTrigger>/.test(query.output) && /<RestartOnFailure>/.test(query.output), 'the registered task must be a logon task that restarts on failure', query.output);
    assert(/conhost\.exe/i.test(query.output) && /--headless/.test(query.output), 'the task must run under conhost.exe --headless', query.output);
    assert(fs.existsSync(definitionCopy), `the definition copy ${definitionCopy} must exist`);
    assert(!fs.readFileSync(definitionCopy).toString('utf16le').includes(version as string), 'the task definition must not name a version: an update only switches current.txt');

    step('/api/health 200 and azito status (running)');
    assert((await healthStatus()) === 200, '/api/health must answer 200');
    const status = azito(azitoCmd, 'status');
    assert(status.status === 0 && /service:\s+taskscheduler \(active\)/.test(status.output) && status.output.includes(logFile), 'azito status must show the running task and the log', status.output);
    const log = readLog(logFile);
    assert(/Server listening|\[azito\]/.test(log), 'the hub\'s stdout/stderr must be in hub.log', log);
    const running = hubNodePids(entryFragment);
    assert(running.length === 1, `exactly one hub node.exe must run for this install (found ${running.length})`);

    step('running install.ps1 again changes nothing and keeps the hub running');
    const again = powershell(['-File', installPs1, '-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath']);
    assert(again.status === 0 && /already installed/.test(again.output), 'a re-run must report the install', again.output);
    assert((await healthStatus()) === 200, 'the hub must still answer after a re-run');
    const reinstall = azito(azitoCmd, 'service install');
    assert(reinstall.status === 0 && /already registered/.test(reinstall.output), 'azito service install again must be a no-op', reinstall.output);

    step('azito stop leaves no node.exe');
    const stop = azito(azitoCmd, 'stop');
    assert(stop.status === 0, 'azito stop failed', stop.output);
    assert(hubNodePids(entryFragment).length === 0, 'azito stop must leave no hub node.exe', stop.output);
    assert((await healthStatus()) === null, '/api/health must not answer after azito stop');
    // Observation only: on the runner the Task Scheduler's End ends the whole process tree at once, so the hub may never get to log its shutdown.
    console.log(`[smoke-service] graceful shutdown logged after azito stop: ${/shutting down gracefully/.test(readLog(logFile))}`);
    console.log(`[smoke-service] azito stop output: ${stop.output.trim()}`);
    const stopped = azito(azitoCmd, 'status');
    assert(/service:\s+taskscheduler \((inactive|failed)\)/.test(stopped.output), 'azito status must show the task stopped', stopped.output);

    step('azito start');
    const start = azito(azitoCmd, 'start');
    assert(start.status === 0, 'azito start failed', start.output);
    await waitFor('/api/health after azito start', async () => (await healthStatus()) === 200, 90_000, () => readLog(logFile));

    step('the Task Scheduler\'s own End (no sweep): the hub follows its conhost.exe and ends by itself');
    const chain = ancestorsOf(hubNodePids(entryFragment)[0]);
    console.log(`[smoke-service] process chain of the hub before End: ${chain.map((p) => `${p.name}(${p.pid})`).join(' <- ')}`);
    const endedAt = Date.now();
    const end = schtasks(['/End', '/TN', TASK_NAME]);
    assert(end.status === 0, 'schtasks /End failed', end.output);
    const seen: string[] = [];
    await waitFor('the hub node.exe to end after /End', () => {
      const alive = chain.filter((p) => processAlive(p.pid)).map((p) => `${p.name}(${p.pid})`).join(',');
      seen.push(`${Math.round((Date.now() - endedAt) / 1000)}s: ${alive || 'none'}`);
      return hubNodePids(entryFragment).length === 0;
    }, 60_000, () => `still running: ${hubNodePids(entryFragment).join(', ')}\n${readLog(logFile)}`);
    console.log(`[smoke-service] alive after End (chain members): ${[...new Set(seen)].join(' | ')}`);
    console.log(`[smoke-service] hub log lines about the parent: ${readLog(logFile).split(/\r?\n/).filter((l) => /parent|conhost|shutting down/.test(l)).join(' // ')}`);
    assert((await healthStatus()) === null, '/api/health must not answer after /End');

    step('azito service restart');
    const restart = azito(azitoCmd, 'service restart');
    assert(restart.status === 0, 'azito service restart failed', restart.output);
    await waitFor('/api/health after restart', async () => (await healthStatus()) === 200, 90_000, () => readLog(logFile));
    const restarted = hubNodePids(entryFragment);
    assert(restarted.length === 1, `exactly one hub node.exe after restart (found ${restarted.length})`);
    step('a restart after current.txt was switched to another version folder waits for the old version (no port conflict)');
    const hubDir = path.join(prefix, 'hub');
    const newVersion = 'v0.0.1-ci';
    fs.cpSync(path.join(hubDir, version as string), path.join(hubDir, newVersion), { recursive: true });
    fs.writeFileSync(path.join(hubDir, 'current.txt'), `${newVersion}\r\n`);
    const logBefore = readLog(logFile).length;
    const switched = azito(azitoCmd, 'service restart');
    assert(switched.status === 0 && !/forcibly/.test(switched.output), 'azito service restart after the switch failed', switched.output);
    await waitFor('/api/health after the switch', async () => (await healthStatus()) === 200, 90_000, () => readLog(logFile));
    const newEntry = fs.realpathSync.native(path.join(hubDir, newVersion, 'azito-hub.cjs'));
    assert(hubNodePids(entryFragment).length === 0, 'the old version must have ended');
    assert(hubNodePids(newEntry).length === 1, 'exactly one hub of the new version must run');
    assert(!/EADDRINUSE/.test(readLog(logFile).slice(logBefore)), 'the new version must not meet the old one on the port', readLog(logFile).slice(logBefore));
    assert((await healthStatus()) === 200, '/api/health after the switch');
    assert(azito(azitoCmd, 'stop').status === 0 && hubNodePids(newEntry).length === 0, 'azito stop must end the new version');
    fs.writeFileSync(path.join(hubDir, 'current.txt'), `${version}\r\n`);

    step('a task deleted by hand (its definition copy left) is registered again by azito service install');
    assert(schtasks(['/Delete', '/TN', TASK_NAME, '/F']).status === 0, 'could not delete the task');
    assert(fs.existsSync(definitionCopy), 'the definition copy stays after a delete by hand');
    const missing = azito(azitoCmd, 'status');
    assert(/not registered any more/.test(missing.output), 'azito status must say the task is gone', missing.output);
    const noStart = azito(azitoCmd, 'start');
    assert(noStart.status !== 0 && /azito service install/.test(noStart.output), 'azito start must say how to register the task again', noStart.output);
    const reregistered = azito(azitoCmd, 'service install');
    assert(reregistered.status === 0 && !/already registered/.test(reregistered.output), 'azito service install must register the task again', reregistered.output);
    assert(schtasks(['/Query', '/TN', TASK_NAME]).status === 0, 'the task must exist again');
    assert(azito(azitoCmd, 'start').status === 0, 'azito start after the re-registration');
    await waitFor('/api/health after the re-registration', async () => (await healthStatus()) === 200, 90_000, () => readLog(logFile));
    assert(azito(azitoCmd, 'stop').status === 0, 'azito stop');

    step('a task registered for another install is not operated from this one, and is replaced only with --yes');
    const prefix2 = path.join(work, 'Second (Prefix)', '.azito');
    const second = powershell(['-File', installPs1, '-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix2, '-Yes', '-NoPath', '-NoService']);
    assert(second.status === 0, 'the second install failed', second.output);
    azito2 = path.join(prefix2, 'bin', 'azito.cmd');
    for (const command of ['start', 'stop', 'service restart']) {
      const refused = azito(azito2, command);
      assert(refused.status !== 0 && /belongs to another install/.test(refused.output), `azito ${command} of another install must be refused`, refused.output);
    }
    const noYes = azito(azito2, 'service install');
    assert(noYes.status !== 0 && /--yes/.test(noYes.output), 'replacing another install\'s task needs --yes', noYes.output);
    const replaced = azito(azito2, 'service install --yes');
    assert(replaced.status === 0 && /replacing the task registered for/.test(replaced.output), 'service install --yes must replace it and say so', replaced.output);
    const old = azito(azitoCmd, 'start');
    assert(old.status !== 0 && /belongs to another install/.test(old.output), 'the first install must now be refused', old.output);
    assert(azito(azito2, 'start').status === 0, 'the second install can start its task');
    await waitFor('/api/health of the second install', async () => (await healthStatus()) === 200, 90_000, () => readLog(path.join(prefix2, 'logs', 'hub.log')));
    assert(azito(azito2, 'stop').status === 0, 'azito stop of the second install');
    assert((await healthStatus()) === null, 'nothing must answer after the stop');
  } catch (err) {
    console.error(`[smoke-service] hub.log:\n${readLog(logFile)}`);
    throw err;
  } finally {
    step('cleanup: stop and delete the task');
    for (const cmd of [azitoCmd, azito2]) if (cmd !== '' && fs.existsSync(cmd)) azito(cmd, 'stop');
    schtasks(['/End', '/TN', TASK_NAME]);
    const deleted = schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
    if (deleted.status !== 0 && schtasks(['/Query', '/TN', TASK_NAME]).status === 0) cleanupFailure = `could not delete the task: ${deleted.output.trim()}`;
    else if (schtasks(['/Query', '/TN', TASK_NAME]).status === 0) cleanupFailure = 'the task still exists after it was deleted';
    fs.rmSync(definitionCopy, { force: true });
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`[smoke-service] could not remove ${work}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A task left behind on the machine is a failure of the test, not a warning.
  if (cleanupFailure) throw new Error(cleanupFailure);
  step('ok');
}

main().catch((err) => {
  console.error('[smoke-service] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
