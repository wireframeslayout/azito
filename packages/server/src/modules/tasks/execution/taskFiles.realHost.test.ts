import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { LocalTransport } from '../../servers/transport/LocalTransport';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { ServerConfig } from '../../servers/Server';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { resolveCurrentHostEnv } from '../../../shared/os/hostEnv';
import { toHostProfile } from '../../../shared/os/hostProfile';
import { GitInfoCollector } from './GitInfoCollector';
import { WorkerWaiter } from './WorkerWaiter';

/**
 * The task's own files and git state on the machine the test runs on (the Windows CI runner included), through LocalTransport:
 * the temp folder of the host, a file written and read back by the host's own file operations, and git run as an argv in a
 * working directory with a space and Japanese characters.
 */
const hostEnv = resolveCurrentHostEnv();
const profile = toHostProfile(hostEnv.platform, hostEnv.arch);
const taskTempFiles = TaskTempFiles.fromHostEnv(hostEnv);
const transport = new LocalTransport({ bin: 'tmux', baseArgs: [] } as never, 'http://hub', hostEnv, taskTempFiles, profile);
const factory = { getTransport: () => transport, getFileOps: () => transport.files() } as unknown as TransportFactory;
const server = { name: 'local', type: 'local' } as unknown as ServerConfig;
const local = { type: 'local' } as const;

const collector = new GitInfoCollector(factory);
const waiter = new WorkerWaiter(undefined as never, factory, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'azito-taskfiles-')));
  repo = join(root, 'my repo 日本語');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'checkout', '-q', '-b', 'task/1-x');
  writeFileSync(join(repo, 'b 日本語.txt'), 'two\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'second');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('task temp files on this host', () => {
  it('names them in the host temp folder, in the host notation', () => {
    const output = taskTempFiles.outputFile(local, 91, 'abc');
    expect(output.startsWith(hostEnv.tmpDir)).toBe(true);
    expect(output).toContain('azito-output-91-abc.md');
  });

  it('writes a rules file (multi-line, non-ASCII) and reads the output back, removing it', async () => {
    const rules = taskTempFiles.rulesFile(local, 92, 'n1');
    const text = "ルール\nit's $(id) `x`\r\nlast\n";
    await collector.writeRemoteFile(server, rules, text);
    try {
      expect(readFileSync(rules, 'utf-8')).toBe(text);
    } finally {
      rmSync(rules, { force: true });
    }

    const output = taskTempFiles.outputFile(local, 92, 'n1');
    writeFileSync(output, '  plan body 日本語\n\n');
    expect(await waiter.readPhaseOutputFile(server, output)).toBe('plan body 日本語');
    expect(existsSync(output)).toBe(false);
  });

  it('tells a missing output file (null) from an empty one (null, removed) and from one that cannot be read (thrown)', async () => {
    const missing = taskTempFiles.outputFile(local, 93, 'none');
    expect(await waiter.readPhaseOutputFile(server, missing)).toBeNull();

    const empty = taskTempFiles.outputFile(local, 93, 'empty');
    writeFileSync(empty, '\n');
    expect(await waiter.readPhaseOutputFile(server, empty)).toBeNull();
    expect(existsSync(empty)).toBe(false);

    const unreadable = taskTempFiles.outputFile(local, 93, 'dir');
    mkdirSync(unreadable);
    try {
      await expect(waiter.readPhaseOutputFile(server, unreadable)).rejects.toMatchObject({ name: 'FileOpsError' });
    } finally {
      rmSync(unreadable, { recursive: true, force: true });
    }
  });
});

describe('GitInfoCollector against a real repository', () => {
  it('reports the branch and the changed files against the base branch', async () => {
    const info = await collector.collectGitInfo(server, repo, 'main');
    expect(info.branch).toBe('task/1-x');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'A', file: 'b 日本語.txt' }]));
  });

  it('falls back to the previous commit without a usable base branch', async () => {
    const info = await collector.collectGitInfo(server, repo, 'no-such-branch');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'A', file: 'b 日本語.txt' }]));
  });

  it('gives null (not an error) in a folder that is not a repository', async () => {
    const notRepo = join(root, 'plain');
    mkdirSync(notRepo);
    const info = await collector.collectGitInfo(server, notRepo, 'main');
    expect(info).toEqual({ branch: null, changedFiles: null });
  });
});
