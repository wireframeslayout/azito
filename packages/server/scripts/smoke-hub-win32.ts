import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { hostTar } from './archive';

/**
 * Smoke test for a Windows hub bundle (azito-hub-<ver>-win32-x64.zip): extracts it, starts the bundled `node.exe
 * azito-hub.cjs` straight from Node (run.ps1 is B2 of #380) with a throwaway data directory on a free loopback port,
 * waits for `/api/health` to answer 200 and stops the process again. A bundle that cannot boot on Windows (a missing
 * native module, a POSIX-only startup step) fails here instead of on a user's machine.
 * Usage: tsx smoke-hub-win32.ts <path to the zip>
 */

const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

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

async function waitForHealth(url: string, hasExited: () => boolean): Promise<Response> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error('the hub exited before /api/health answered');
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`/api/health did not answer within ${STARTUP_TIMEOUT_MS} ms (last: ${lastError})`);
}

async function main(): Promise<void> {
  const zip = process.argv[2];
  if (!zip) throw new Error('usage: smoke-hub-win32.ts <azito-hub-*-win32-x64.zip>');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-hub-smoke-'));
  const bundle = path.join(work, 'bundle');
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(bundle);
  execFileSync(hostTar(), ['-xf', path.resolve(zip), '-C', bundle]);

  const port = await freePort();
  let output = '';
  let exited = false;
  const hub = spawn(path.join(bundle, 'node.exe'), ['azito-hub.cjs'], {
    cwd: bundle,
    env: { ...process.env, AZITO_DATA_DIR: dataDir, AZITO_BIND: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  hub.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  hub.on('exit', () => { exited = true; });

  try {
    const res = await waitForHealth(`http://127.0.0.1:${port}/api/health`, () => exited);
    console.log(`[smoke-hub] /api/health -> ${res.status} ${JSON.stringify(await res.json())}`);
  } catch (err) {
    console.error(`[smoke-hub] hub output:\n${output}`);
    throw err;
  } finally {
    if (!exited) {
      hub.kill();
      await new Promise((r) => setTimeout(r, 1000));
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch((err) => {
  console.error('[smoke-hub] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
