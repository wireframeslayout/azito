import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import type { SchtasksClient } from '../../../shared/os/taskScheduler/schtasks';
import { HUB_UPDATE_TASK, buildHubUpdateScript, buildHubUpdateTaskXml, inspectHubUpdateTask, launchHubUpdateTask, type HubUpdateLaunch, type HubUpdateTaskInput } from '../windowsHubUpdateTask';
import { buildHubTaskXml, hubWindowsLayout } from '../windowsHubService';

const PREFIX = 'C:\\Users\\Foo Bar (Work)\\.azito';
const SYSTEM_ROOT = 'C:\\Windows';

const TASK: HubUpdateTaskInput = {
  userId: 'PC\\me',
  systemRoot: SYSTEM_ROOT,
  hubDir: `${PREFIX}\\hub`,
  nodePath: `${PREFIX}\\hub\\v1.0.0\\node.exe`,
  bundlePath: `${PREFIX}\\hub\\v1.0.0\\azito-hub.cjs`,
  updateArgs: ['--version', 'v1.1.0', '--health-url', 'http://127.0.0.1:3001/api/health'],
  outputLog: `${PREFIX}\\data\\update-run.out.log`,
};

function scriptOf(xml: string): string {
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(xml)?.[1];
  if (!encoded) throw new Error('the task has no -EncodedCommand');
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('buildHubUpdateTaskXml', () => {
  const xml = buildHubUpdateTaskXml(TASK);

  it('runs the script under conhost.exe --headless, with no path of the prefix in the command line (conhost re-reads spaces and parentheses wrongly)', () => {
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(xml).toMatch(/<Arguments>--headless C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoProfile /);
    expect(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)![1]).not.toContain('Foo Bar');
    expect(xml).toContain(`<WorkingDirectory>${PREFIX}\\hub</WorkingDirectory>`);
  });

  it('has no trigger (it is started by /Run only, and never again at a logon if it is left behind) and a time limit', () => {
    expect(xml).not.toMatch(/<Triggers>|<LogonTrigger>/);
    expect(xml).toContain('<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('runs the CURRENT version\'s node.exe and bundle with update-run and the arguments, never a token', () => {
    const script = scriptOf(xml);
    expect(script).toContain(`'${TASK.nodePath}' '${TASK.bundlePath}' 'update-run' '--version' 'v1.1.0' '--health-url' 'http://127.0.0.1:3001/api/health'`);
    expect(script).toContain(`Out-File -LiteralPath '${TASK.outputLog}'`);
    expect(script).toContain("$ErrorActionPreference = 'Continue'");
  });

  it('quotes a single quote in a path for PowerShell', () => {
    expect(buildHubUpdateScript({ ...TASK, updateArgs: ["--data-dir", "C:\\Users\\O'Neil\\data"] })).toContain("'C:\\Users\\O''Neil\\data'");
  });
});

describe('inspectHubUpdateTask', () => {
  it('reads the install back from a task this code registered', () => {
    expect(inspectHubUpdateTask(buildHubUpdateTaskXml(TASK), SYSTEM_ROOT)).toEqual({ hubDir: `${PREFIX}\\hub` });
  });

  it('does not recognise the hub task, a task with another action, or one with a second action', () => {
    const hubTask = buildHubTaskXml({ userId: 'PC\\me', systemRoot: SYSTEM_ROOT, layout: hubWindowsLayout(PREFIX) });
    expect(inspectHubUpdateTask(hubTask, SYSTEM_ROOT)).toBeUndefined();
    expect(inspectHubUpdateTask('<Task></Task>', SYSTEM_ROOT)).toBeUndefined();
    const withExtra = buildHubUpdateTaskXml(TASK).replace('</Actions>', '<Exec><Command>calc.exe</Command></Exec></Actions>');
    expect(inspectHubUpdateTask(withExtra, SYSTEM_ROOT)).toBeUndefined();
    const otherProgram = buildHubUpdateTaskXml(TASK).replace('conhost.exe', 'cmd.exe');
    expect(inspectHubUpdateTask(otherProgram, SYSTEM_ROOT)).toBeUndefined();
  });
});

describe('launchHubUpdateTask', () => {
  let dir: string;
  let launch: HubUpdateLaunch;
  const guard = new UnixSecretFileGuard();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-launch-'));
    launch = { task: TASK, tokenFile: path.join(dir, 'update-token'), token: 'secret-token' };
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A Task Scheduler with at most one task (`existing`: its XML and whether it runs); every call is recorded. */
  function fakeClient(existing?: { xml: string; running: boolean }) {
    const calls: string[] = [];
    let registered: string | undefined;
    const client = {
      query: vi.fn(async () => (existing === undefined ? { exists: false } : { exists: true, running: existing.running, failed: false, lastResult: 0 })),
      exportXml: vi.fn(async () => existing!.xml),
      stop: vi.fn(async () => { calls.push('stop'); if (existing) existing.running = false; }),
      delete: vi.fn(async () => { calls.push('delete'); existing = undefined; }),
      register: vi.fn(async (_name: string, xml: string) => { calls.push('register'); registered = xml; }),
      start: vi.fn(async () => { calls.push('start'); }),
    } as unknown as SchtasksClient;
    return { client, calls, registered: () => registered };
  }

  it('registers the task and starts it; the token is in its file (owner-only), not in the task', async () => {
    const { client, calls, registered } = fakeClient();
    await launchHubUpdateTask({ client, guard }, launch);
    expect(calls).toEqual(['register', 'start']);
    expect(registered()).not.toContain('secret-token');
    expect(scriptOf(registered()!)).not.toContain('secret-token');
    expect(fs.readFileSync(launch.tokenFile, 'utf-8')).toBe('secret-token');
    if (process.platform !== 'win32') expect(fs.statSync(launch.tokenFile).mode & 0o077).toBe(0);
  });

  it('writes no token file when there is no token', async () => {
    await launchHubUpdateTask({ client: fakeClient().client, guard }, { ...launch, token: undefined });
    expect(fs.existsSync(launch.tokenFile)).toBe(false);
  });

  it('replaces the leftover of an earlier update that is no longer running', async () => {
    const { client, calls } = fakeClient({ xml: buildHubUpdateTaskXml(TASK), running: false });
    await launchHubUpdateTask({ client, guard }, launch);
    expect(calls).toEqual(['delete', 'register', 'start']);
  });

  it('does not touch a task of that name that this code did not register', async () => {
    const { client, calls } = fakeClient({ xml: '<Task><Actions><Exec><Command>calc.exe</Command></Exec></Actions></Task>', running: false });
    await expect(launchHubUpdateTask({ client, guard }, launch)).rejects.toThrow(/did not register.*schtasks \/Delete/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(launch.tokenFile)).toBe(false);
  });

  it('does not stop an update of another install that is running', async () => {
    const other = buildHubUpdateTaskXml({ ...TASK, hubDir: 'C:\\Users\\other\\.azito\\hub' });
    const { client, calls } = fakeClient({ xml: other, running: true });
    await expect(launchHubUpdateTask({ client, guard }, launch)).rejects.toThrow(/another install \(C:\\Users\\other\\\.azito\\hub\) is running/);
    expect(calls).toEqual([]);
  });

  it('removes the token file and the half-registered task when the task cannot be started, and reports the original reason', async () => {
    const { client, calls } = fakeClient();
    (client.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('schtasks /Run failed'));
    await expect(launchHubUpdateTask({ client, guard }, launch)).rejects.toThrow('schtasks /Run failed');
    expect(calls).toEqual(['register', 'delete']);
    expect(fs.existsSync(launch.tokenFile)).toBe(false);
  });

  it('names the task AzitoHubUpdate', () => {
    expect(HUB_UPDATE_TASK).toBe('AzitoHubUpdate');
  });
});
