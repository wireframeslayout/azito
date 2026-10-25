import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCleanupScript, buildRecordProcessScript, parseCleanupOutcome, parseRecordedProcess } from './unixAgentCleanup';

// The scripts are run for real, with sh, against real processes in a temporary HOME (Linux: they read /proc).
describe.skipIf(process.platform !== 'linux')('unix agent cleanup scripts', () => {
  let home: string;
  let entry: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-cleanup-'));
    fs.mkdirSync(path.join(home, '.azito', 'agent', 'current'), { recursive: true });
    entry = path.join(home, '.azito', 'agent', 'current', 'azito-agent.cjs');
    fs.writeFileSync(entry, 'setInterval(() => {}, 1000);\n');
    fs.writeFileSync(path.join(home, '.azito', 'agent', 'install.id'), 'abc123');
  });

  afterEach(() => {
    for (const c of children.splice(0)) if (c.pid && isAlive(c.pid)) process.kill(c.pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  });

  const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const run = (script: string): string => spawnSync('sh', ['-c', script], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }).stdout;
  const startOf = (pid: number): string => { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]!; };
  const launch = (args: string[]): ChildProcess => { const c = spawn(process.execPath, args, { stdio: 'ignore' }); children.push(c); return c; };
  const writePid = (pid: number): void => fs.writeFileSync(path.join(home, '.azito', 'agent', 'agent.pid'), String(pid));
  const cleanup = (process?: { pid: number; startedAt: string }): ReturnType<typeof parseCleanupOutcome> =>
    parseCleanupOutcome(run(buildCleanupScript({ installId: 'abc123', startMethod: 'nohup', process })));
  const waitGone = async (pid: number): Promise<void> => { for (let i = 0; i < 50 && isAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100)); };

  it('records the agent process (entry path as a whole argument) and stops exactly it, then removes the folder', async () => {
    const agent = launch([entry]);
    writePid(agent.pid!);
    await new Promise((r) => setTimeout(r, 300));
    const recorded = parseRecordedProcess(run(buildRecordProcessScript()));
    expect(recorded).toEqual({ pid: agent.pid, startedAt: startOf(agent.pid!) });
    expect(cleanup(recorded as { pid: number; startedAt: string })).toEqual({ kind: 'removed' });
    await waitGone(agent.pid!);
    expect(isAlive(agent.pid!)).toBe(false);
    expect(fs.existsSync(path.join(home, '.azito', 'agent'))).toBe(false);
  });

  it('does not record, and does not stop, a process that only contains the entry path inside a longer argument', async () => {
    const decoy = launch(['-e', 'setInterval(() => {}, 1000)', `${entry}.bak`]);
    writePid(decoy.pid!);
    await new Promise((r) => setTimeout(r, 300));
    expect(parseRecordedProcess(run(buildRecordProcessScript()))).toHaveProperty('error');
    // Even with the right pid and start time (a reused pid), the arguments do not match: it is left alone.
    expect(cleanup({ pid: decoy.pid!, startedAt: startOf(decoy.pid!) })).toEqual({ kind: 'removed' });
    expect(isAlive(decoy.pid!)).toBe(true);
  });

  it('does not stop a process with the recorded pid but another start time (the pid was reused)', async () => {
    const agent = launch([entry]);
    await new Promise((r) => setTimeout(r, 300));
    expect(cleanup({ pid: agent.pid!, startedAt: '1' })).toEqual({ kind: 'removed' });
    expect(isAlive(agent.pid!)).toBe(true);
  });

  it('treats a process that no longer exists as the end of the agent, and removes the folder', () => {
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    expect(cleanup({ pid: gone, startedAt: '1' })).toEqual({ kind: 'removed' });
  });

  it('touches nothing when the folder holds another install\'s id', async () => {
    const agent = launch([entry]);
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(home, '.azito', 'agent', 'install.id'), 'other');
    expect(cleanup({ pid: agent.pid!, startedAt: startOf(agent.pid!) })).toEqual({ kind: 'not_owner', found: 'other' });
    expect(isAlive(agent.pid!)).toBe(true);
    expect(fs.existsSync(entry)).toBe(true);
  });

  it('stops nothing and keeps the folder when no process was recorded', () => {
    expect(cleanup(undefined)).toMatchObject({ kind: 'not_stopped' });
    expect(fs.existsSync(entry)).toBe(true);
  });
});
