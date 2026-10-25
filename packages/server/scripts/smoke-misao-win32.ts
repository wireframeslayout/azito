import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * End-to-end check of the hub's own misao on a real Windows (Windows PowerShell 5.1, the real schtasks.exe, the real misao.exe of the
 * bundle, a real named pipe): install.ps1 WITHOUT -NoService installs the hub and misao into a throwaway prefix with spaces and
 * parentheses, then `azito misao status`, the hub's view of the daemon (`GET /api/system/misao`, the sessions listing), the local server on misao only (create / rename /
 * send-keys / capture / terminal WebSocket / tier0_mux / delete, and a worker command with shell syntax refused as unsupported_os), `azito stop` (misao keeps running), `azito start`, a repeated install / update (nothing is
 * restarted), `misao stop` and `azito misao start`. The tasks are deleted at the end whatever happened.
 * The tasks keep their product names: they only exist inside the CI runner. A skipped step is a failure, never a pass.
 * Usage: tsx smoke-misao-win32.ts <azito-hub-*-win32-x64.zip> <SHA256SUMS> <install.ps1>
 */

const HUB_TASK = 'AzitoHub';
const MISAO_TASK = 'AzitoMisao';
const PORT = 3001; // what init-env writes to hub\.env; install.ps1 starts the hub before any file can be edited
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SYSTEM_ROOT = process.env.SystemRoot ?? '';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const SCHTASKS = path.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');

interface Result { status: number | null; output: string }

function step(message: string): void {
  console.log(`[smoke-misao] ${message}`);
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
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
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

async function api(token: string, method: string, route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | unknown[] | null; text: string }> {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> | unknown[] | null = null;
  try { json = JSON.parse(text) as Record<string, unknown> | unknown[]; } catch { json = null; }
  return { status: res.status, json, text };
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

function readLog(logFile: string): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : `(no log file ${logFile})`;
}

function envValue(envFile: string, key: string): string | undefined {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Types `input` into a terminal WebSocket once it has sent its first frame; resolves with everything received as soon as `until` matches after that. */
function terminalRoundTrip(url: string, input: string, until: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let received = '';
    const timer = setTimeout(() => { socket.close(); reject(new Error(`the terminal did not answer ${until} within ${timeoutMs / 1000}s\n${received}`)); }, timeoutMs);
    // The hub reads input only once the pane is attached, and the first thing it sends is the pane's screen: type after that.
    let typed = false;
    socket.addEventListener('message', (event) => {
      received += String(event.data);
      if (!typed) { typed = true; socket.send(input); return; }
      if (until.test(received)) { clearTimeout(timer); socket.close(); resolve(received); }
    });
    socket.addEventListener('close', (event) => {
      if (until.test(received)) return;
      clearTimeout(timer);
      reject(new Error(`the terminal closed (${event.code} ${event.reason}) before it answered ${until}\n${received}`));
    });
  });
}

interface ActivityRow { windowId?: number; decidedBy: string; state: string }

/**
 * The local server of a Windows hub runs misao only (B4a): its tmux is closed with a reason, a window can be created, renamed,
 * typed into, read back, attached through the browser terminal WebSocket, seen by the activity detection (tier0_mux) and
 * deleted, and a worker command with shell syntax is `unsupported_os` (a worker is started as a program, #371). The server runs on the daemon this script installed.
 */
async function checkLocalServerOnMisaoOnly(token: string, hubLog: string): Promise<void> {
  step('the local server of a Windows hub: Windows, misao by default, no tmux');
  const server = await api(token, 'GET', '/api/servers/local');
  assert(server.status === 200, `GET /api/servers/local must answer 200 (got ${server.status})`, server.text);
  const info = server.json as { defaultMux?: string; hostProfile?: { platform?: string } | null; mux?: { kind?: string; kinds?: unknown[] } };
  assert(info.hostProfile?.platform === 'win32', 'the local server must report the hub\'s own host (win32)', server.text);
  assert(info.defaultMux === 'misao' && info.mux?.kind === 'misao' && info.mux.kinds === undefined, 'the local server must run misao only (no tmux kind listed)', server.text);
  const installStatus = await api(token, 'GET', '/api/servers/local/install-status');
  assert(installStatus.status === 200 && (installStatus.json as Record<string, unknown>).tmux === undefined && (installStatus.json as Record<string, unknown>).misao !== undefined, 'install-status must have a misao row and no tmux row', installStatus.text);
  const tmuxWindow = await api(token, 'POST', '/api/servers/local/mux/workspaces', { name: 'w851-tmux', kind: 'tmux' });
  assert(tmuxWindow.status === 409 && (tmuxWindow.json as { reason?: string } | null)?.reason === 'unsupported_os', 'a tmux window must be refused with the reason unsupported_os', tmuxWindow.text);
  const installTmux = await api(token, 'POST', '/api/servers/local/install-tmux', {});
  assert(installTmux.status === 501 && (installTmux.json as { code?: string } | null)?.code === 'unsupported_os', 'installing tmux must be refused as unsupported_os', installTmux.text);

  step('creating a misao window (the pane is cmd.exe) and renaming it');
  const created = await api(token, 'POST', '/api/servers/local/mux/workspaces', { name: 'w851b4a', kind: 'misao' });
  console.log(`[smoke-misao] POST /api/servers/local/mux/workspaces -> ${created.status} ${created.text}`);
  assert(created.status === 200, 'a misao window on a Windows hub must be created', `${created.text}\n--- hub.log ---\n${readLog(hubLog)}`);
  const ref = (created.json as { ref?: string } | null)?.ref;
  assert(typeof ref === 'string' && ref !== '', 'the create answer must carry the window ref', created.text);
  const windowBase = `/api/servers/local/mux/windows/${encodeURIComponent(ref!)}`;
  const renamed = await api(token, 'PUT', `${windowBase}/rename`, { name: 'w851-renamed' });
  assert(renamed.status === 200, 'renaming the window must work', renamed.text);

  step('send-keys and capture: the typed command ran in cmd.exe');
  const sent = await api(token, 'POST', `${windowBase}/panes/1/send-keys`, { keys: ['echo w851-b4a-%OS%', 'Enter'] });
  assert(sent.status === 200, 'send-keys must work', sent.text);
  let captured = '';
  await waitFor('the capture to show the output of the typed command', async () => {
    const res = await api(token, 'GET', `${windowBase}/panes/1/capture`);
    captured = res.text;
    // %OS% is only expanded by a shell that ran the line: the typed line itself still reads "%OS%".
    return res.status === 200 && captured.includes('w851-b4a-Windows_NT');
  }, 30_000, () => captured);

  step('the browser terminal WebSocket: one round trip through ConPTY');
  const wsUrl = `ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}&server=local&ref=${encodeURIComponent(ref!)}&pane=1&cols=100&rows=30`;
  await terminalRoundTrip(wsUrl, 'echo w851-ws-%OS%\r', /w851-ws-Windows_NT/, 30_000);

  step('a worker is started as a program, not typed (#371): shell syntax is unsupported_os, and a program that cannot be found leaves the shell pane as it was');
  const project = await api(token, 'POST', '/api/projects', { name: 'w851 b4a', slug: 'w851-b4a' });
  const projectId = (project.json as { id?: number } | null)?.id;
  assert(project.status === 200 && typeof projectId === 'number', 'a project must be created', project.text);
  const registered = await api(token, 'POST', `/api/projects/${projectId}/windows`, { server_name: 'local', ref, window_type: 'agent', worker_type: 'claude', label: 'w851-agent' });
  const windowId = (registered.json as { id?: number } | null)?.id;
  assert(registered.status === 200 && typeof windowId === 'number', 'the window must be registered as an agent window', registered.text);
  const launch = await api(token, 'POST', `/api/windows/${windowId}/launch-agent`, { command: 'claude | more' });
  assert(launch.status === 501 && (launch.json as { code?: string } | null)?.code === 'unsupported_os', 'a command with shell syntax must be refused as unsupported_os (a Windows host starts a program with its arguments)', launch.text);
  const missing = await api(token, 'POST', `/api/windows/${windowId}/launch-agent`, { command: 'azito-smoke-no-such-program' });
  assert(missing.status >= 400, 'a program that cannot be found must not be reported as launched', missing.text);
  const stillShell = await api(token, 'GET', `${windowBase}/panes/1/capture`);
  assert(stillShell.status === 200 && stillShell.text.includes('w851-b4a-Windows_NT'), 'the shell pane must be as it was after the refused launches', stillShell.text);

  step('activity detection: GET /api/debug/activity shows the window, decided by tier0_mux from the daemon\'s pane.state');
  // A burst of output, which the daemon reads as work and then as quiet.
  const burst = await api(token, 'POST', `${windowBase}/panes/1/send-keys`, { keys: ['for /L %i in (1,1,400) do @echo w851-burst-%i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Enter'] });
  assert(burst.status === 200, 'send-keys (burst) must work', burst.text);
  let rows = '';
  await waitFor('the window to be decided by tier0_mux in /api/debug/activity', async () => {
    const res = await api(token, 'GET', '/api/debug/activity');
    rows = res.text;
    const list = Array.isArray(res.json) ? res.json as ActivityRow[] : [];
    return res.status === 200 && list.some((row) => row.windowId === windowId && row.decidedBy === 'tier0_mux' && (row.state === 'working' || row.state === 'idle'));
  }, 60_000, () => `${rows}\n--- hub.log ---\n${readLog(hubLog)}`);

  step('deleting the window');
  const killed = await api(token, 'POST', `${windowBase}/kill`);
  assert(killed.status === 200, 'killing the window must work', killed.text);
  const after = await api(token, 'GET', '/api/servers/local/sessions?detail=1');
  const listed = ((after.json as { sessions?: Array<{ name: string; windows: unknown[] }> } | null)?.sessions ?? []).find((session) => session.name === 'w851b4a');
  // The workspace stays (empty) until it is deleted too, as on Unix.
  assert(listed === undefined || listed.windows.length === 0, 'the deleted window must not be listed any more', after.text);
  const removed = await api(token, 'DELETE', '/api/servers/local/mux/workspaces/w851b4a?kind=misao');
  assert(removed.status === 200, 'deleting the empty workspace must work', removed.text);
}

async function main(): Promise<void> {
  const [zipArg, sumsArg, installArg] = process.argv.slice(2);
  if (!zipArg || !sumsArg || !installArg) throw new Error('usage: smoke-misao-win32.ts <zip> <SHA256SUMS> <install.ps1>');
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-misao-smoke-'));
  // A prefix with spaces and parentheses, the shape of "C:\Users\Foo Bar (Work)".
  const prefix = path.join(work, 'Foo Bar (Work)', '.azito');
  const hubLog = path.join(prefix, 'logs', 'hub.log');
  const misaoRoot = path.join(prefix, 'misao');
  const misaoLog = path.join(misaoRoot, 'misao.log');
  const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
  const envFile = path.join(prefix, 'hub', '.env');
  const definitionCopy = path.join(os.homedir(), '.azito', 'service', `${HUB_TASK}.xml`);
  let pipe = '';
  let misaoVersion = '';
  let misaoExe = '';
  let cleanupFailure: string | undefined;

  const misaoStopCommand = (): Result => {
    const r = spawnSync(misaoExe, ['stop'], { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, MISAO_SOCKET: pipe } });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };

  try {
    step(`install.ps1 without -NoService into ${prefix}`);
    const installed = powershell(['-File', installPs1, '-ZipPath', zip, '-Sha256Sums', sums, '-Prefix', prefix, '-Yes', '-NoPath']);
    console.log(installed.output);
    assert(installed.status === 0, 'install.ps1 failed', `${installed.output}\n--- hub.log ---\n${readLog(hubLog)}\n--- misao.log ---\n${readLog(misaoLog)}`);
    assert(/Installing the misao service/.test(installed.output) && !/could not be installed/.test(installed.output), 'install.ps1 must install the misao service without a warning', installed.output);
    assert(/AZITO is running at http:\/\/localhost:3001\//.test(installed.output), 'install.ps1 must wait for /api/health and say the hub is running', installed.output);

    step('the files, the task and the hub .env');
    const versions = fs.readdirSync(misaoRoot).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
    assert(versions.length === 1, `exactly one release folder must be in ${misaoRoot} (found ${versions.join(', ') || 'none'})`);
    misaoVersion = versions[0];
    misaoExe = path.join(misaoRoot, misaoVersion, 'misao.exe');
    for (const file of ['misao.exe', 'LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.txt']) {
      assert(fs.existsSync(path.join(misaoRoot, misaoVersion, file)), `${file} must be in the release folder`);
    }
    assert(fs.readFileSync(path.join(misaoRoot, 'current'), 'utf-8').trim() === misaoVersion, 'the current file must name the release');
    const taskXml = schtasks(['/Query', '/TN', MISAO_TASK, '/XML']);
    assert(taskXml.status === 0, 'schtasks /Query failed for the misao task', taskXml.output);
    assert(/<LogonTrigger>/.test(taskXml.output) && /<RestartOnFailure>/.test(taskXml.output), 'the misao task must be a logon task that restarts on failure', taskXml.output);
    // The prefix has spaces and parentheses, which conhost.exe re-reads wrongly in a command line: the task runs a launcher script (-EncodedCommand), and the paths are in it, not in the command line.
    assert(/conhost\.exe/i.test(taskXml.output) && /--headless/.test(taskXml.output) && /-EncodedCommand/.test(taskXml.output), 'the misao task must run the launcher script under conhost.exe --headless', taskXml.output);
    const launcher = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(taskXml.output)?.[1] ?? '', 'base64').toString('utf16le');
    // The folder is named in its real spelling (the prefix was given with an 8.3 short name, RUNNER~1), the one every process of this host derives the pipe from.
    const realRoot = fs.realpathSync.native(misaoRoot);
    assert(launcher.toLowerCase().includes(path.join(realRoot, misaoVersion, 'misao.exe').toLowerCase()) && launcher.toLowerCase().includes(`'${realRoot.toLowerCase()}'`), 'the launcher script must name this release\'s misao.exe and the folder', launcher);
    assert(!taskXml.output.includes('Foo Bar'), 'no path of the prefix may be in the task\'s command line', taskXml.output);
    pipe = envValue(envFile, 'MISAO_SOCKET') ?? '';
    assert(/^\\\\\.\\pipe\\misao-[A-Za-z0-9._-]+-[0-9a-f]{16}$/.test(pipe), 'hub\\.env must name the misao named pipe as MISAO_SOCKET', pipe);
    const pids = misaoPids(pipe);
    assert(pids.length === 1, `exactly one misao.exe must serve ${pipe} (found ${pids.length})`, readLog(misaoLog));

    step('azito misao status (running, the hub points at the managed pipe)');
    const status = azito(azitoCmd, 'misao status');
    assert(status.status === 0, 'azito misao status failed', status.output);
    assert(/service:\s+taskscheduler \(active\)/.test(status.output), 'azito misao status must show the running task', status.output);
    assert(new RegExp(`installed:\\s+${misaoVersion.replace(/\./g, '\\.')}`).test(status.output) && /daemon:\s+reachable/.test(status.output), 'azito misao status must show the installed version and a reachable daemon', status.output);
    assert(status.output.includes(pipe) && !/restart the hub/.test(status.output), 'azito misao status must show the pipe and need no hub restart', status.output);

    step('the hub is connected to misao: GET /api/system/misao and the sessions listing');
    const tokenOut = azito(azitoCmd, 'token show');
    const token = tokenOut.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
    assert(tokenOut.status === 0 && token !== '', 'azito token show failed', tokenOut.output);
    let lastService = '';
    await waitFor('the hub to report the misao daemon reachable', async () => {
      const res = await api(token, 'GET', '/api/system/misao');
      lastService = res.text;
      return res.status === 200 && (res.json as { daemon?: { reachable?: boolean } } | null)?.daemon?.reachable === true;
    }, 60_000, () => `${lastService}\n--- hub.log ---\n${readLog(hubLog)}`);
    const service = (await api(token, 'GET', '/api/system/misao')).json as Record<string, unknown>;
    assert(service.managed === true && service.serviceInstalled === true && service.serviceState === 'active' && service.serviceManager === 'taskscheduler', 'GET /api/system/misao must show the managed running task', JSON.stringify(service));
    assert(service.installedVersion === misaoVersion && service.bundledVersion === misaoVersion && service.updateAvailable === false, 'installed and bundled versions must match', JSON.stringify(service));
    assert(service.socketPath === pipe && service.socketSetting === 'managed' && service.needsHubRestart === false, 'the hub must use the managed pipe (no restart needed)', JSON.stringify(service));
    const sessions = await api(token, 'GET', '/api/servers/local/sessions?detail=1');
    assert(sessions.status === 200, `GET /api/servers/local/sessions?detail=1 must answer 200 (got ${sessions.status})`, `${sessions.text}\n--- hub.log ---\n${readLog(hubLog)}`);
    const unavailable = (sessions.json as { unavailable?: Array<{ kind: string }> } | null)?.unavailable ?? [];
    assert(!unavailable.some((entry) => entry.kind === 'misao'), 'misao must not be unavailable on the local server', sessions.text);

    await checkLocalServerOnMisaoOnly(token, hubLog);

    step('azito stop ends the hub and leaves misao running');
    const before = misaoPids(pipe);
    const stop = azito(azitoCmd, 'stop');
    assert(stop.status === 0, 'azito stop failed', stop.output);
    assert((await healthStatus()) === null, '/api/health must not answer after azito stop');
    assert(JSON.stringify(misaoPids(pipe)) === JSON.stringify(before), 'azito stop must leave the same misao.exe running', `${before.join(',')} -> ${misaoPids(pipe).join(',')}`);
    const afterStop = azito(azitoCmd, 'misao status');
    assert(/service:\s+taskscheduler \(active\)/.test(afterStop.output) && /daemon:\s+reachable/.test(afterStop.output), 'misao must still be running and reachable after azito stop', afterStop.output);

    step('azito start: the hub connects to the same daemon again');
    const start = azito(azitoCmd, 'start');
    assert(start.status === 0, 'azito start failed', start.output);
    await waitFor('/api/health after azito start', async () => (await healthStatus()) === 200, 90_000, () => readLog(hubLog));
    await waitFor('the hub to reach misao again', async () => {
      const res = await api(token, 'GET', '/api/system/misao');
      return res.status === 200 && (res.json as { daemon?: { reachable?: boolean } } | null)?.daemon?.reachable === true;
    }, 60_000, () => readLog(hubLog));
    assert(JSON.stringify(misaoPids(pipe)) === JSON.stringify(before), 'the hub restart must not have restarted misao');

    step('a repeated install and an update to the same release change nothing');
    const again = azito(azitoCmd, 'misao install');
    assert(again.status === 0 && /misao install: done/.test(again.output), 'azito misao install again must succeed', again.output);
    const update = azito(azitoCmd, 'misao update --yes');
    assert(update.status === 0 && /misao update: done/.test(update.output), 'azito misao update (same release) must succeed', update.output);
    assert(JSON.stringify(misaoPids(pipe)) === JSON.stringify(before), 'neither may restart the running daemon', `${before.join(',')} -> ${misaoPids(pipe).join(',')}`);

    step('misao stop, then azito misao start');
    const stopped = misaoStopCommand();
    assert(stopped.status === 0, 'misao stop failed', stopped.output);
    await waitFor('the misao daemon to stop', () => misaoPids(pipe).length === 0, 30_000, () => readLog(misaoLog));
    await waitFor('the misao task to leave the running state', () => !/Running/i.test(schtasks(['/Query', '/TN', MISAO_TASK, '/FO', 'LIST']).output.split(/\r?\n/).filter((l) => /^Status:/i.test(l)).join('')), 30_000);
    const down = azito(azitoCmd, 'misao status');
    assert(/daemon:\s+not reachable/.test(down.output), 'azito misao status must say the daemon is down', down.output);
    const started = azito(azitoCmd, 'misao start');
    assert(started.status === 0 && /misao start: done/.test(started.output), 'azito misao start failed', `${started.output}\n--- misao.log ---\n${readLog(misaoLog)}`);
    assert(misaoPids(pipe).length === 1, 'azito misao start must bring one daemon up');
    assert(/daemon:\s+reachable/.test(azito(azitoCmd, 'misao status').output), 'the daemon must be reachable again');
  } catch (err) {
    console.error(`[smoke-misao] hub.log:\n${readLog(hubLog)}\n[smoke-misao] misao.log:\n${readLog(misaoLog)}`);
    console.error(`[smoke-misao] task state:\n${schtasks(['/Query', '/TN', MISAO_TASK, '/V', '/FO', 'LIST']).output}`);
    throw err;
  } finally {
    step('cleanup: stop the hub and misao, delete the tasks');
    if (fs.existsSync(azitoCmd)) azito(azitoCmd, 'stop');
    if (misaoExe !== '' && fs.existsSync(misaoExe)) misaoStopCommand();
    for (const task of [HUB_TASK, MISAO_TASK]) {
      schtasks(['/End', '/TN', task]);
      const deleted = schtasks(['/Delete', '/TN', task, '/F']);
      if (schtasks(['/Query', '/TN', task]).status === 0) cleanupFailure = `could not delete the task ${task}: ${deleted.output.trim()}`;
    }
    if (pipe !== '' && misaoPids(pipe).length > 0) cleanupFailure = `a misao.exe is still running for ${pipe}`;
    fs.rmSync(definitionCopy, { force: true });
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`[smoke-misao] could not remove ${work}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A task or a process left behind on the machine is a failure of the test, not a warning.
  if (cleanupFailure) throw new Error(cleanupFailure);
  step('ok');
}

main().catch((err) => {
  console.error('[smoke-misao] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
