import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommandSpec, runHostOf } from '../../exec/runCommandSpec';
import { resolveCurrentHostEnv } from '../hostEnv';
import { SchtasksClient, rawRunnerOf } from './schtasks';
import { buildTaskXml, encodeTaskXml } from './taskDefinition';
import { removeTaskIfPresent } from './testing/liveTask';

/**
 * The premise of the in-app update of a Windows hub (#381 U2), measured on a real Task Scheduler: the update runs as a task of its own
 * (`AzitoHubUpdate`) that the hub registers and starts from inside its own task (`AzitoHub`). It has to outlive the hub's task being ended
 * (`/End`, which the update does to restart the hub), and it deletes its own task when it is done, while it is still running. The two
 * tasks here are stand-ins with unique names, both `conhost.exe --headless node.exe <script>` like the real ones; the "hub" does not follow
 * its conhost.exe, so it is ended by the test as the hub sweep would end the hub (`endHubProcesses`).
 */
const SUFFIX = crypto.randomBytes(6).toString('hex');
const PARENT = `AzitoCiParent-${SUFFIX}`;
const CHILD = `AzitoCiChild-${SUFFIX}`;
const NO_INTERACTIVE_LOGON = new Set([0x8004130f, 0x80070520]);

let client: SchtasksClient;
let dir: string;
let systemRoot: string;

const file = (name: string): string => path.join(dir, name);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(name: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file(name)) && Date.now() < deadline) await sleep(300);
  return fs.existsSync(file(name));
}

const beats = (): number => Number(fs.readFileSync(file('child.beat'), 'utf-8'));
const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe.skipIf(process.platform !== 'win32')('a task started from inside another task', () => {
  beforeAll(async () => {
    const host = resolveCurrentHostEnv();
    systemRoot = host.systemRoot!;
    client = new SchtasksClient(rawRunnerOf((spec) => runCommandSpec(spec, { ...runHostOf(host), rawOutput: true })), host);
    dir = fs.mkdtempSync(path.join(host.tmpDir, 'azito-independence-'));
    expect(dir).not.toMatch(/\s/);
    const userId = `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`;
    const conhost = path.win32.join(systemRoot, 'System32', 'conhost.exe');
    const schtasks = path.win32.join(systemRoot, 'System32', 'schtasks.exe');
    // workingDirectory is NOT the folder the test deletes: a process keeps its working directory open.
    const base = { userId, description: 'AZITO CI test task (safe to delete)', workingDirectory: host.tmpDir, restartOnFailure: { intervalMinutes: 1, count: 1 }, trigger: 'on-demand' as const };
    const childXml = file('child.xml');
    fs.writeFileSync(childXml, encodeTaskXml(buildTaskXml({ ...base, executable: conhost, argumentsLine: `--headless "${host.execPath}" "${file('child.js')}"` })));
    fs.writeFileSync(file('child.js'), `
const fs = require('fs'); const cp = require('child_process');
fs.writeFileSync(${JSON.stringify(file('child.pid'))}, String(process.pid));
let n = 0; let deleted = false;
const timer = setInterval(() => {
  fs.writeFileSync(${JSON.stringify(file('child.beat'))}, String(++n));
  if (!deleted && fs.existsSync(${JSON.stringify(file('delete-me'))})) {
    deleted = true;
    const r = cp.spawnSync(${JSON.stringify(schtasks)}, ['/Delete', '/TN', ${JSON.stringify(CHILD)}, '/F'], { encoding: 'utf-8' });
    fs.writeFileSync(${JSON.stringify(file('self-delete.txt'))}, String(r.status));
  }
  if (fs.existsSync(${JSON.stringify(file('stop'))})) { fs.writeFileSync(${JSON.stringify(file('child.done'))}, 'x'); clearInterval(timer); process.exit(0); }
}, 300);
`);
    fs.writeFileSync(file('parent.js'), `
const fs = require('fs'); const cp = require('child_process');
fs.writeFileSync(${JSON.stringify(file('parent.pid'))}, String(process.pid));
const a = cp.spawnSync(${JSON.stringify(schtasks)}, ['/Create', '/XML', ${JSON.stringify(childXml)}, '/TN', ${JSON.stringify(CHILD)}, '/F'], { encoding: 'utf-8' });
const b = cp.spawnSync(${JSON.stringify(schtasks)}, ['/Run', '/TN', ${JSON.stringify(CHILD)}], { encoding: 'utf-8' });
fs.writeFileSync(${JSON.stringify(file('parent.registered'))}, a.status + ' ' + b.status);
setInterval(() => {}, 1000);
`);
    await client.register(PARENT, buildTaskXml({ ...base, executable: conhost, argumentsLine: `--headless "${host.execPath}" "${file('parent.js')}"` }));
  });

  afterAll(async () => {
    for (const name of [PARENT, CHILD]) await removeTaskIfPresent(client, name);
    await sleep(2000);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('keeps running after the task it was started from is ended, and can delete its own task while it runs', async (ctx) => {
    await client.start(PARENT);
    if (!(await waitForFile('child.beat', 60_000))) {
      const results = [await client.query(PARENT), await client.query(CHILD)].map((state) => (state.exists ? state.lastResult : -1));
      if (!results.some((r) => NO_INTERACTIVE_LOGON.has(r))) throw new Error(`The tasks did not run within 60 s (last results ${results.join(', ')}; the parent wrote ${fs.existsSync(file('parent.registered')) ? fs.readFileSync(file('parent.registered'), 'utf-8') : 'nothing'})`);
      const reason = `no interactive logon session on this machine (last results ${results.join(', ')})`;
      console.warn(`[taskIndependence.windows.test] SKIPPED: ${reason}`);
      ctx.skip(reason);
    }
    expect(fs.readFileSync(file('parent.registered'), 'utf-8')).toBe('0 0');
    const parentPid = Number(fs.readFileSync(file('parent.pid'), 'utf-8'));
    const childPid = Number(fs.readFileSync(file('child.pid'), 'utf-8'));
    expect(isAlive(parentPid) && isAlive(childPid)).toBe(true);

    // The start of the hub's own restart: End of the task the update was started from, and the sweep of what it leaves.
    const before = beats();
    await client.stop(PARENT);
    process.kill(parentPid);
    await sleep(5000);
    expect(isAlive(parentPid)).toBe(false);
    expect(isAlive(childPid)).toBe(true);
    expect(beats()).toBeGreaterThan(before);
    expect(await client.query(CHILD)).toMatchObject({ exists: true, running: true });

    // The update deletes its own task at the end, while it is still running.
    fs.writeFileSync(file('delete-me'), 'x');
    expect(await waitForFile('self-delete.txt', 15_000)).toBe(true);
    expect(fs.readFileSync(file('self-delete.txt'), 'utf-8')).toBe('0');
    expect((await client.query(CHILD)).exists).toBe(false);
    const afterDelete = beats();
    await sleep(2000);
    expect(isAlive(childPid)).toBe(true);
    expect(beats()).toBeGreaterThan(afterDelete);

    fs.writeFileSync(file('stop'), 'x');
    expect(await waitForFile('child.done', 15_000)).toBe(true);
  }, 180_000);
});
