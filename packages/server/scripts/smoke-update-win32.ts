import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { createHubLock } from '../src/modules/system/hubLock';
import { createSecretFileGuard } from '../src/shared/os/secretFileGuard';
import { extractZipSafely } from '../src/shared/fs/safeArchive';

/**
 * End-to-end check of the in-app update of a Windows hub (#381 U2), on a real Windows (Windows PowerShell 5.1, the real schtasks.exe, the real
 * tar.exe, the bundle's node.exe and misao.exe). A fake release server on the loopback (`AZITO_UPDATE_API_BASE`, the test-only way to point the
 * release API somewhere else) serves two builds of the very bundle under test as the releases v0.0.0-ci.a and v0.0.0-ci.b, and three bad ones.
 *
 *   1. install.ps1 installs a (task AzitoHub, misao); a misao window is created.
 *   2. update to a zip whose SHA256 does not match: the update stops, a is still running, the hub was never restarted.
 *   3. update to a build whose `--version` is wrong: stops at the smoke test, the hub was never restarted, its folder is removed.
 *   4. update while another process holds the hub lock: the update stops with the reason, and `azito service restart` is refused too.
 *   5. update to a build that passes `--version` and never serves: the hub is restarted on it, never gets healthy, and is put back on a.
 *   5b. a download that stops answering: the update task is ended (`/End`), the update process ends by itself (it follows its conhost.exe), the
 *      hub is untouched, and the next update runs.
 *   6. update to b: the hub is b (health, current.txt), the update task and the token file are gone, the token never was on a command line,
 *      misao.exe was not restarted and the window is still there.
 *   7. the Setup row's misao update (`POST /api/system/misao/update`) runs once.
 *   8. a real release zip passes `extractZipSafely` (the update used it for b; this runs it once more on the zip itself).
 * The tasks are deleted at the end whatever happened. A skipped step is a failure, never a pass.
 * Usage: tsx smoke-update-win32.ts <azito-hub-*-win32-x64.zip> <SHA256SUMS> <install.ps1>
 */

const HUB_TASK = 'AzitoHub';
const MISAO_TASK = 'AzitoMisao';
const UPDATE_TASK = 'AzitoHubUpdate';
const REPO = 'ci/azito';
const TOKEN_VALUE = 'ci-update-token-0123456789abcdef';
const PORT = 3001; // what init-env writes to hub\.env
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SYSTEM_ROOT = process.env.SystemRoot ?? '';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const SCHTASKS = path.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');
const TAR = path.join(SYSTEM_ROOT, 'System32', 'tar.exe');

const TAG_A = 'v0.0.0-ci.a';
const TAG_B = 'v0.0.0-ci.b';
const TAG_CORRUPT = 'v0.0.0-ci.c';
const TAG_UNBOOTABLE = 'v0.0.0-ci.d';
const TAG_BADVERSION = 'v0.0.0-ci.e';
const TAG_STALLED = 'v0.0.0-ci.f';

interface Result { status: number | null; output: string }

function step(message: string): void {
  console.log(`[smoke-update] ${message}`);
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
  const r = spawnSync(CMD, ['/d', '/s', '/c', `""${azitoCmd}" ${args}"`], { encoding: 'utf-8', timeout: 240_000, windowsVerbatimArguments: true });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function schtasks(args: string[]): Result {
  const r = spawnSync(SCHTASKS, args, { encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, condition: () => Promise<boolean> | boolean, timeoutMs: number, detail: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(500);
  }
  throw new Error(`${what} (waited ${timeoutMs / 1000}s)\n${detail()}`);
}

async function health(): Promise<{ status: number; version: string | null } | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => null) as { version?: string } | null;
    return { status: res.status, version: body?.version ?? null };
  } catch {
    return null;
  }
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

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : `(no file ${file})`;
}

/** The hub's node.exe processes (any version folder under `hub\` of this CI run, never the update process). */
function hubPids(): number[] {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'hub\\\\v0\\.0\\.0-ci\\.[a-z]\\\\azito-hub\\.cjs' -and $_.CommandLine -notmatch 'update-run' } | ForEach-Object { $_.ProcessId }",
  ].join('\n');
  const r = powershell(['-Command', script]);
  assert(r.status === 0, 'could not list node.exe processes', r.output);
  return r.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number).sort((x, y) => x - y);
}

/** The update processes: node.exe running `azito-hub.cjs update-run`. */
function updateRunPids(): number[] {
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'azito-hub\\.cjs.* update-run' } | ForEach-Object { $_.ProcessId }";
  const r = powershell(['-Command', script]);
  assert(r.status === 0, 'could not list node.exe processes', r.output);
  return r.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
}

function misaoPids(pipe: string): number[] {
  const script = [
    `$pipe = '${pipe.replace(/'/g, "''")}'`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'misao.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($pipe, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }",
  ].join('\n');
  const r = powershell(['-Command', script]);
  assert(r.status === 0, 'could not list misao.exe processes', r.output);
  return r.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number).sort((x, y) => x - y);
}

function envValue(envFile: string, key: string): string | undefined {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

// ── the zips ──────────────────────────────────────────────────────────────

function tar(args: string[], cwd?: string): void {
  const r = spawnSync(TAR, args, { encoding: 'utf-8', timeout: 600_000, ...(cwd ? { cwd } : {}) });
  assert(r.status === 0, `tar ${args.join(' ')} failed`, `${r.stdout}${r.stderr}`);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The built bundle with another version in release.json and version.txt: a different release of the same bundle. */
function repackWithVersion(baseZip: string, tag: string, outZip: string, work: string): void {
  const stage = fs.mkdtempSync(path.join(work, 'stage-'));
  tar(['-xf', baseZip, '-C', stage]);
  const releaseFile = path.join(stage, 'release.json');
  const release = JSON.parse(fs.readFileSync(releaseFile, 'utf-8')) as { version: string };
  release.version = tag;
  fs.writeFileSync(releaseFile, JSON.stringify(release, null, 2) + '\n');
  const versionFile = path.join(stage, 'version.txt');
  const lines = fs.readFileSync(versionFile, 'utf-8').split('\n');
  lines[0] = tag;
  fs.writeFileSync(versionFile, lines.join('\n'));
  tar(['-a', '-c', '-f', outZip, '-C', stage, ...fs.readdirSync(stage)]);
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

/**
 * A small "bundle" that is the bundle's own node.exe and run.ps1 around a stub azito-hub.cjs: `--version` answers `versionAnswer`, and
 * anything else (the hub proper) exits at once, so it never serves.
 */
function buildStubZip(baseZip: string, versionAnswer: string, outZip: string, work: string): void {
  const stage = fs.mkdtempSync(path.join(work, 'stub-'));
  const full = fs.mkdtempSync(path.join(work, 'full-'));
  tar(['-xf', baseZip, '-C', full]);
  for (const file of ['node.exe', 'run.ps1']) fs.copyFileSync(path.join(full, file), path.join(stage, file));
  fs.writeFileSync(path.join(stage, 'release.json'), JSON.stringify({ version: versionAnswer, commit: 'stub', bundleHash: 'stub', channel: { repo: REPO } }));
  fs.writeFileSync(path.join(stage, 'azito-hub.cjs'), `if (process.argv[2] === '--version') { console.log(${JSON.stringify(versionAnswer)}); process.exit(0); }\nconsole.error('stub hub: does not serve');\nprocess.exit(1);\n`);
  tar(['-a', '-c', '-f', outZip, '-C', stage, ...fs.readdirSync(stage)]);
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

// ── the fake release server ───────────────────────────────────────────────

interface FakeRelease { tag: string; zipName: string; zipBytes: Buffer; sumsText: string }

interface FakeServer {
  port: number;
  /** Authorization headers the downloads came with. */
  downloadAuth: string[];
  /** Requests for the stalled release's zip so far (the server never finishes the answer). */
  stalledRequests: number;
  /** The task XML read while the b zip was being downloaded (the update process was running then). */
  taskXmlDuringDownload: string | null;
  close(): Promise<void>;
}

function releaseOf(tag: string, zip: string, claimedSha: string | undefined): FakeRelease {
  const zipName = `azito-hub-${tag}-win32-x64.zip`;
  return { tag, zipName, zipBytes: fs.readFileSync(zip), sumsText: `${claimedSha ?? sha256(zip)}  ${zipName}\n` };
}

async function startFakeReleaseServer(releases: FakeRelease[], watchTag: string): Promise<FakeServer> {
  const state: FakeServer = { port: 0, downloadAuth: [], stalledRequests: 0, taskXmlDuringDownload: null, close: async () => undefined };
  const byTag = new Map(releases.map((r) => [r.tag, r]));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${state.port}`;
    const releaseJson = (r: FakeRelease): object => ({
      tag_name: r.tag, body: null, published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: true,
      assets: [
        { name: r.zipName, browser_download_url: `${origin}/dl/${r.tag}/${r.zipName}` },
        { name: 'SHA256SUMS', browser_download_url: `${origin}/dl/${r.tag}/SHA256SUMS` },
      ],
    });
    const send = (status: number, type: string, body: Buffer | string): void => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    const tagRoute = new RegExp(`^/repos/${REPO}/releases/tags/(.+)$`).exec(url.pathname);
    if (tagRoute) {
      const release = byTag.get(decodeURIComponent(tagRoute[1]));
      return release ? send(200, 'application/json', JSON.stringify(releaseJson(release))) : send(404, 'application/json', '{}');
    }
    if (url.pathname === `/repos/${REPO}/releases/latest`) return send(200, 'application/json', JSON.stringify(releaseJson(byTag.get(TAG_B)!)));
    if (url.pathname === `/repos/${REPO}/releases`) return send(200, 'application/json', JSON.stringify([...byTag.values()].map(releaseJson)));
    const download = /^\/dl\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (download) {
      const release = byTag.get(decodeURIComponent(download[1]));
      if (!release) return send(404, 'text/plain', 'no such release');
      state.downloadAuth.push(String(req.headers.authorization ?? ''));
      if (decodeURIComponent(download[2]) === 'SHA256SUMS') return send(200, 'text/plain', release.sumsText);
      if (release.tag === TAG_STALLED) {
        // Answers the first bytes and then nothing, for ever: a download that has stopped.
        state.stalledRequests++;
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(release.zipBytes.length) });
        res.write(release.zipBytes.subarray(0, 1024));
        return;
      }
      if (release.tag === watchTag) {
        // The update process is running right now: its task must not carry the token on its command line.
        state.taskXmlDuringDownload = schtasks(['/Query', '/TN', UPDATE_TASK, '/XML']).output;
      }
      return send(200, 'application/zip', release.zipBytes);
    }
    return send(404, 'text/plain', 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return state;
}

// ── polling the update ────────────────────────────────────────────────────

interface UpdateState { status: string; step: string; toVersion: string; startedAt: string; error?: string; steps: Array<{ step: string; status: string; message: string }> }

/** Waits until the update to `toVersion` that started after `since` has ended; the hub may be down for a while in between. */
async function waitForUpdateEnd(token: string, toVersion: string, since: number, timeoutMs: number, detail: () => string): Promise<UpdateState> {
  let last: UpdateState | null = null;
  await waitFor(`the update to ${toVersion} to end`, async () => {
    try {
      const res = await api(token, 'GET', '/api/system/update/progress');
      const state = (res.json as { state?: UpdateState | null } | null)?.state ?? null;
      if (state && state.toVersion === toVersion && Date.parse(state.startedAt) >= since) {
        last = state;
        return state.status !== 'running';
      }
    } catch {
      // the hub is being restarted
    }
    return false;
  }, timeoutMs, () => `${JSON.stringify(last)}\n${detail()}`);
  return last!;
}

async function startUpdate(token: string, tag: string): Promise<number> {
  const startedAt = Date.now() - 2000; // the clocks are the same machine's; a margin for the state's own timestamp
  const res = await api(token, 'POST', '/api/system/update', { version: tag });
  assert(res.status === 202, `POST /api/system/update for ${tag} must be accepted`, res.text);
  return startedAt;
}

async function main(): Promise<void> {
  const [zipArg, , installArg] = process.argv.slice(2);
  if (!zipArg || !process.argv[3] || !installArg) throw new Error('usage: smoke-update-win32.ts <zip> <SHA256SUMS> <install.ps1>');
  const baseZip = path.resolve(zipArg);
  const installPs1 = path.resolve(installArg);
  assert(powershell(['-Command', '$PSVersionTable.PSVersion.Major']).output.trim() === '5', 'install.ps1 must be exercised by Windows PowerShell 5.1');
  for (const task of [HUB_TASK, MISAO_TASK, UPDATE_TASK]) {
    assert(schtasks(['/Query', '/TN', task]).status !== 0, `a task named ${task} already exists on this machine; this smoke test owns that name`);
  }
  assert((await health()) === null, `something already answers on ${BASE_URL}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-smoke-'));
  // A prefix with spaces and parentheses, the shape of "C:\Users\Foo Bar (Work)".
  const prefix = path.join(work, 'Foo Bar (Work)', '.azito');
  const hubDir = path.join(prefix, 'hub');
  const hubLog = path.join(prefix, 'logs', 'hub.log');
  const azitoCmd = path.join(prefix, 'bin', 'azito.cmd');
  const envFile = path.join(hubDir, '.env');
  const pointer = path.join(hubDir, 'current.txt');
  const definitionCopy = path.join(os.homedir(), '.azito', 'service', `${HUB_TASK}.xml`);
  let dataDir = '';
  let fake: FakeServer | undefined;
  let pipe = '';
  let misaoExe = '';
  let cleanupFailure: string | undefined;
  const pointerValue = (): string => fs.readFileSync(pointer, 'utf-8').trim();
  const updateLog = (): string => `--- update.log ---\n${readText(path.join(dataDir, 'update.log'))}\n--- update-run.out.log ---\n${readText(path.join(dataDir, 'update-run.out.log'))}\n--- hub.log ---\n${readText(hubLog)}`;

  try {
    step('building the releases: a and b are the bundle under test with another version; three bad ones');
    const zipA = path.join(work, `azito-hub-${TAG_A}-win32-x64.zip`);
    const zipB = path.join(work, `azito-hub-${TAG_B}-win32-x64.zip`);
    const zipUnbootable = path.join(work, `azito-hub-${TAG_UNBOOTABLE}-win32-x64.zip`);
    const zipBadVersion = path.join(work, `azito-hub-${TAG_BADVERSION}-win32-x64.zip`);
    repackWithVersion(baseZip, TAG_A, zipA, work);
    repackWithVersion(baseZip, TAG_B, zipB, work);
    buildStubZip(baseZip, TAG_UNBOOTABLE, zipUnbootable, work);
    buildStubZip(baseZip, 'v9.9.9-not-the-tag', zipBadVersion, work);
    const sumsA = path.join(work, 'SHA256SUMS-a');
    fs.writeFileSync(sumsA, `${sha256(zipA)}  ${path.basename(zipA)}\n`);

    step('step 8 (early): a real release zip passes extractZipSafely');
    const probe = path.join(work, 'extract-probe');
    await extractZipSafely({ archive: zipB, destination: probe, tar: TAR });
    assert(fs.existsSync(path.join(probe, 'node.exe')) && fs.existsSync(path.join(probe, 'azito-hub.cjs')) && fs.existsSync(path.join(probe, 'run.ps1')), 'the extracted release must hold node.exe, azito-hub.cjs and run.ps1');
    fs.rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

    const corruptZip = path.join(work, `azito-hub-${TAG_CORRUPT}-win32-x64.zip`);
    const bytes = fs.readFileSync(zipB);
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
    fs.writeFileSync(corruptZip, bytes);
    fake = await startFakeReleaseServer([
      releaseOf(TAG_B, zipB, undefined),
      releaseOf(TAG_CORRUPT, corruptZip, sha256(zipB)),
      releaseOf(TAG_UNBOOTABLE, zipUnbootable, undefined),
      releaseOf(TAG_BADVERSION, zipBadVersion, undefined),
      releaseOf(TAG_STALLED, zipUnbootable, undefined),
    ], TAG_B);

    step(`step 1: install.ps1 installs ${TAG_A} (hub task and misao) into ${prefix}`);
    const installed = powershell(['-File', installPs1, '-ZipPath', zipA, '-Sha256Sums', sumsA, '-Prefix', prefix, '-Yes', '-NoPath']);
    console.log(installed.output);
    assert(installed.status === 0, 'install.ps1 failed', `${installed.output}\n--- hub.log ---\n${readText(hubLog)}`);
    dataDir = envValue(envFile, 'AZITO_DATA_DIR') ?? '';
    assert(dataDir !== '', 'hub\\.env must name AZITO_DATA_DIR');
    pipe = envValue(envFile, 'MISAO_SOCKET') ?? '';
    assert(/^\\\\\.\\pipe\\misao-/.test(pipe), 'hub\\.env must name the misao pipe', pipe);
    const misaoRoot = path.join(prefix, 'misao');
    const misaoRelease = fs.readdirSync(misaoRoot).find((name) => /^\d+\.\d+\.\d+$/.test(name));
    assert(misaoRelease !== undefined, 'the misao release folder must exist');
    misaoExe = path.join(misaoRoot, misaoRelease!, 'misao.exe');

    // The hub is pointed at the fake release server and given a token the downloads must carry; it picks hub\.env up when it restarts.
    fs.appendFileSync(envFile, `\r\nAZITO_RELEASE_REPO=${REPO}\r\nAZITO_UPDATE_API_BASE=http://127.0.0.1:${fake.port}\r\nAZITO_GITHUB_TOKEN=${TOKEN_VALUE}\r\n`);
    const restarted = azito(azitoCmd, 'service restart');
    assert(restarted.status === 0, 'azito service restart failed', restarted.output);
    await waitFor(`/api/health to answer ${TAG_A}`, async () => (await health())?.version === TAG_A, 90_000, () => readText(hubLog));

    const tokenOut = azito(azitoCmd, 'token show');
    const token = tokenOut.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
    assert(tokenOut.status === 0 && token !== '', 'azito token show failed', tokenOut.output);

    step('the update is offered on a Windows hub: deploy mode, no "disabled", the versions of the fake server');
    const status = await api(token, 'GET', '/api/system/update/status');
    const statusBody = status.json as { deployMode?: string; status?: string; disabledReason?: string | null } | null;
    assert(status.status === 200 && statusBody?.deployMode === 'taskscheduler' && statusBody.status !== 'disabled' && statusBody.disabledReason === null, 'GET /api/system/update/status must offer the update on a task', status.text);
    const versions = await api(token, 'GET', '/api/system/update/versions');
    assert(versions.status === 200 && versions.text.includes(TAG_B), 'GET /api/system/update/versions must list the fake releases', versions.text);

    step('a misao window exists; the hub and misao processes are recorded');
    const created = await api(token, 'POST', '/api/servers/local/mux/workspaces', { name: 'w851upd', kind: 'misao' });
    assert(created.status === 200, 'a misao window must be created', `${created.text}\n${readText(hubLog)}`);
    const windowRef = (created.json as { ref?: string } | null)?.ref;
    assert(typeof windowRef === 'string' && windowRef !== '', 'the create answer must carry the window ref', created.text);
    const listWindows = async (): Promise<string> => (await api(token, 'GET', '/api/servers/local/sessions?detail=1')).text;
    assert((await listWindows()).includes('w851upd'), 'the new workspace must be listed');
    const misaoBefore = misaoPids(pipe);
    assert(misaoBefore.length === 1, `exactly one misao.exe must serve ${pipe} (found ${misaoBefore.length})`);
    const hubBefore = hubPids();
    assert(hubBefore.length === 1, `exactly one hub node.exe must run (found ${hubBefore.length})`);

    step(`step 2: ${TAG_CORRUPT} (SHA256 does not match) stops the update and leaves ${TAG_A} running, never restarted`);
    let since = await startUpdate(token, TAG_CORRUPT);
    let ended = await waitForUpdateEnd(token, TAG_CORRUPT, since, 180_000, updateLog);
    assert(ended.status === 'failed' && /SHA256 mismatch/.test(ended.error ?? '') && ended.step === 'verify', 'the update must fail at verify with the mismatch', JSON.stringify(ended));
    assert(pointerValue() === TAG_A && (await health())?.version === TAG_A, 'the hub must still be a');
    assert(JSON.stringify(hubPids()) === JSON.stringify(hubBefore), 'the hub must not have been restarted', `${hubBefore.join(',')} -> ${hubPids().join(',')}`);
    assert(!fs.existsSync(path.join(hubDir, TAG_CORRUPT)), 'nothing may be extracted for a failed verify');
    await waitFor('the update task to be deleted', () => schtasks(['/Query', '/TN', UPDATE_TASK]).status !== 0, 60_000, updateLog);
    assert(!fs.existsSync(path.join(dataDir, 'update-token')), 'the token file must be gone');
    assert(fake.downloadAuth.length > 0 && fake.downloadAuth.every((h) => h === `Bearer ${TOKEN_VALUE}`), 'the update process must have downloaded with the token from the file', fake.downloadAuth.join(' | '));

    step(`step 3: ${TAG_BADVERSION} (--version says another version) stops at the smoke test, the hub is never restarted, the folder is removed`);
    since = await startUpdate(token, TAG_BADVERSION);
    ended = await waitForUpdateEnd(token, TAG_BADVERSION, since, 180_000, updateLog);
    assert(ended.status === 'failed' && ended.step === 'smoke-test' && /Smoke test version mismatch/.test(ended.error ?? ''), 'the update must fail at the smoke test', JSON.stringify(ended));
    assert(pointerValue() === TAG_A && JSON.stringify(hubPids()) === JSON.stringify(hubBefore), 'the hub must be a, not restarted');
    assert(!fs.existsSync(path.join(hubDir, TAG_BADVERSION)), 'the folder this run made must be removed');
    await waitFor('the update task to be deleted', () => schtasks(['/Query', '/TN', UPDATE_TASK]).status !== 0, 60_000, updateLog);

    step('step 4: while another process holds the hub lock, the update and `azito service restart` both stop with the reason and change nothing');
    const lock = createHubLock(hubDir, createSecretFileGuard(process.platform, process.env), SYSTEM_ROOT);
    await lock.run(async () => {
      const refused = azito(azitoCmd, 'service restart');
      assert(refused.status !== 0 && /Another AZITO hub operation/.test(refused.output), 'azito service restart must be refused while the lock is held', refused.output);
      const lockedSince = await startUpdate(token, TAG_B);
      const lockedEnd = await waitForUpdateEnd(token, TAG_B, lockedSince, 120_000, updateLog);
      assert(lockedEnd.status === 'failed' && /Another AZITO hub operation/.test(lockedEnd.error ?? ''), 'the update must fail with the lock as the reason', JSON.stringify(lockedEnd));
    });
    assert(pointerValue() === TAG_A && JSON.stringify(hubPids()) === JSON.stringify(hubBefore), 'a refused update must change nothing');
    assert(!fs.existsSync(path.join(hubDir, TAG_B)), 'a refused update must extract nothing');
    await waitFor('the update task to be deleted', () => schtasks(['/Query', '/TN', UPDATE_TASK]).status !== 0, 60_000, updateLog);

    step(`step 5: ${TAG_UNBOOTABLE} passes --version and never serves: the hub is restarted on it, never gets healthy, and is put back on ${TAG_A}`);
    since = await startUpdate(token, TAG_UNBOOTABLE);
    ended = await waitForUpdateEnd(token, TAG_UNBOOTABLE, since, 420_000, updateLog);
    assert(ended.status === 'failed' && ended.step === 'health-check' && /Health check timed out/.test(ended.error ?? ''), 'the update must fail at the health check', `${JSON.stringify(ended)}\n${updateLog()}`);
    assert(!/going back to .* also failed/.test(ended.error ?? ''), 'the rollback must have worked', JSON.stringify(ended));
    assert(pointerValue() === TAG_A, 'current.txt must be back on a');
    await waitFor(`the hub to answer ${TAG_A} again`, async () => (await health())?.version === TAG_A, 120_000, updateLog);
    assert(hubPids().length === 1, 'exactly one hub must run after the rollback', hubPids().join(','));
    assert(!fs.existsSync(path.join(hubDir, TAG_UNBOOTABLE)), 'the folder this run made must be removed after the rollback');
    await waitFor('the update task to be deleted', () => schtasks(['/Query', '/TN', UPDATE_TASK]).status !== 0, 60_000, updateLog);
    const hubAfterRollback = hubPids();

    step('step 5b: a download that stops answering; ending the update task ends the update process, and the next update runs');
    since = await startUpdate(token, TAG_STALLED);
    await waitFor('the stalled download to be requested', () => fake!.stalledRequests > 0, 120_000, updateLog);
    assert(updateRunPids().length === 1, 'exactly one update process must run during the download', updateRunPids().join(','));
    assert(schtasks(['/End', '/TN', UPDATE_TASK]).status === 0, 'schtasks /End of the update task failed');
    await waitFor('the update process to end by itself after /End', () => updateRunPids().length === 0, 60_000, updateLog);
    ended = await waitForUpdateEnd(token, TAG_STALLED, since, 60_000, updateLog);
    assert(ended.status === 'failed' && /task was ended/.test(ended.error ?? ''), 'the update must be recorded as failed because its task was ended', JSON.stringify(ended));
    assert(pointerValue() === TAG_A && JSON.stringify(hubPids()) === JSON.stringify(hubAfterRollback), 'the hub must be untouched');
    assert(!fs.existsSync(path.join(dataDir, 'update-token')), 'the token file must be gone');
    await waitFor('the update task to be deleted', () => schtasks(['/Query', '/TN', UPDATE_TASK]).status !== 0, 60_000, updateLog);

    step(`step 6: ${TAG_B}: the hub is b, the update task and the token file are gone, misao is untouched and the window is still there`);
    since = await startUpdate(token, TAG_B);
    ended = await waitForUpdateEnd(token, TAG_B, since, 420_000, updateLog);
    assert(ended.status === 'success', 'the update to b must succeed', `${JSON.stringify(ended)}\n${updateLog()}`);
    assert(pointerValue() === TAG_B && (await health())?.version === TAG_B, 'the hub must be b (current.txt and /api/health)');
    const hubAfter = hubPids();
    assert(hubAfter.length === 1 && hubAfter[0] !== hubAfterRollback[0], 'one new hub process must run', `${hubAfterRollback.join(',')} -> ${hubAfter.join(',')}`);
    assert(fs.existsSync(path.join(hubDir, TAG_A)) && fs.existsSync(path.join(hubDir, TAG_B)), 'both version folders must exist (the old one is kept)');
    await waitFor('the update task to be deleted', () => schtasks(['/Query', '/TN', UPDATE_TASK]).status !== 0, 60_000, updateLog);
    assert(!fs.existsSync(path.join(dataDir, 'update-token')), 'the token file must be gone');
    const taskXml = fake.taskXmlDuringDownload ?? '';
    assert(/conhost\.exe/i.test(taskXml) && /--headless/.test(taskXml), 'the update task (read while it ran) must run under conhost.exe --headless', taskXml || '(the task could not be read)');
    assert(!/<LogonTrigger>/.test(taskXml), 'the update task must have no logon trigger', taskXml);
    const script = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(taskXml)?.[1] ?? '', 'base64').toString('utf16le');
    assert(script.includes('update-run') && script.includes('--health-url') && script.includes('--token-file'), 'the update task\'s script must run update-run with the health URL and the token file', script);
    assert(!taskXml.includes(TOKEN_VALUE) && !script.includes(TOKEN_VALUE), 'the update task must not carry the token on its command line', script);
    const logs = `${readText(path.join(dataDir, 'update.log'))}${readText(path.join(dataDir, 'update-run.out.log'))}`;
    assert(!logs.includes(TOKEN_VALUE), 'the token must not be in the update logs');
    assert(JSON.stringify(misaoPids(pipe)) === JSON.stringify(misaoBefore), 'misao.exe must not have been restarted by the update', `${misaoBefore.join(',')} -> ${misaoPids(pipe).join(',')}`);
    assert((await listWindows()).includes('w851upd'), 'the window must still be listed after the update');
    const sessions = await api(token, 'GET', '/api/servers/local/sessions?detail=1');
    assert(sessions.status === 200 && !((sessions.json as { unavailable?: Array<{ kind: string }> } | null)?.unavailable ?? []).some((e) => e.kind === 'misao'), 'the new hub must reach misao', sessions.text);

    step('step 7: the Setup row\'s misao update (POST /api/system/misao/update) runs once, on the updated hub');
    const misaoUpdate = await api(token, 'POST', '/api/system/misao/update', { closeAllPanes: true });
    assert(misaoUpdate.status === 200, 'the misao update must succeed', `${misaoUpdate.text}\n${readText(hubLog)}`);
    const misaoState = await api(token, 'GET', '/api/system/misao');
    assert((misaoState.json as { daemon?: { reachable?: boolean } } | null)?.daemon?.reachable === true, 'the daemon must be reachable after the misao update', misaoState.text);
  } catch (err) {
    console.error(`[smoke-update] ${updateLog()}`);
    console.error(`[smoke-update] tasks:\n${[HUB_TASK, MISAO_TASK, UPDATE_TASK].map((t) => `${t}: ${schtasks(['/Query', '/TN', t, '/FO', 'LIST']).output.trim()}`).join('\n')}`);
    throw err;
  } finally {
    step('cleanup: stop the hub and misao, delete the tasks');
    if (fs.existsSync(azitoCmd)) azito(azitoCmd, 'stop');
    if (misaoExe !== '' && fs.existsSync(misaoExe)) spawnSync(misaoExe, ['stop'], { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, MISAO_SOCKET: pipe } });
    for (const task of [UPDATE_TASK, HUB_TASK, MISAO_TASK]) {
      schtasks(['/End', '/TN', task]);
      const deleted = schtasks(['/Delete', '/TN', task, '/F']);
      if (schtasks(['/Query', '/TN', task]).status === 0) cleanupFailure = `could not delete the task ${task}: ${deleted.output.trim()}`;
    }
    if (pipe !== '' && misaoPids(pipe).length > 0) cleanupFailure = `a misao.exe is still running for ${pipe}`;
    if (hubPids().length > 0) cleanupFailure = `a hub node.exe is still running: ${hubPids().join(', ')}`;
    await fake?.close();
    fs.rmSync(definitionCopy, { force: true });
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`[smoke-update] could not remove ${work}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A task or a process left behind on the machine is a failure of the test, not a warning.
  if (cleanupFailure) throw new Error(cleanupFailure);
  step('ok');
}

main().catch((err) => {
  console.error('[smoke-update] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
