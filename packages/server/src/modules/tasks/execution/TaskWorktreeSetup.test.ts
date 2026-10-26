import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import { createTaskWorktree, type TaskWorktreeDeps, type TaskWorktreeRequest } from './TaskWorktreeSetup';

// Issue #532: a codex worker is trusted in the host's codex config when its worktree is made, like a Claude worker in `~/.claude.json`.
let home: string;
let worktree: string;

function depsFor(codexHome: string | null) {
  const files = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: home }));
  const transport = { files: () => files, run: vi.fn(async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' })) };
  const appendLog = vi.fn();
  const deps: TaskWorktreeDeps = {
    taskRepo: { update: vi.fn() },
    contentExtractor: { generateSlug: vi.fn(async () => 'slug') },
    transportFactory: { getTransport: () => transport, getFileOps: () => files },
    worktreeServiceFactory: { create: () => ({ create: async () => ({ path: worktree, branch: 'azito/task-1' }), remove: vi.fn() }) },
    hubGitIdentity: null,
    localHomes: { claudeConfigDir: null, codexHome },
    appendLog,
  } as unknown as TaskWorktreeDeps;
  return { deps, appendLog };
}

const request = (workerType: string): TaskWorktreeRequest => ({
  server: { name: 'local', type: 'local' } as never,
  task: { id: 1, title: 't', branch: null },
  unitId: 7,
  workerType,
  workingDir: home,
  allowedRoot: null,
  baseBranch: 'main',
  distStatus: null,
  slug: 'slug',
});

describe('createTaskWorktree — host trust for the worker', () => {
  beforeEach(() => {
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'wt-trust-')));
    worktree = join(home, 'wt');
    mkdirSync(worktree);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('registers the worktree in ~/.codex/config.toml for a codex worker, and logs it', async () => {
    const { deps, appendLog } = depsFor(null);
    await createTaskWorktree(deps, request('codex'), async () => {});
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(`[projects.${JSON.stringify(worktree)}]\ntrust_level = "trusted"\n`);
    expect(appendLog).toHaveBeenCalledWith(1, 7, 'command', { type: 'codex_trust_registered', path: worktree });
  });

  it('honours CODEX_HOME of the hub for its own server', async () => {
    const codexHome = join(home, 'custom-codex');
    const { deps } = depsFor(codexHome);
    await createTaskWorktree(deps, request('codex'), async () => {});
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain(`[projects.${JSON.stringify(worktree)}]`);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('does not touch the codex config for a Claude worker', async () => {
    const { deps } = depsFor(null);
    await createTaskWorktree(deps, request('claude'), async () => {});
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('logs codex_trust_failed (and goes on) when the config cannot be extended', async () => {
    mkdirSync(join(home, '.codex'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(home, '.codex', 'config.toml'), 'not = = toml');
    const { deps, appendLog } = depsFor(null);
    await createTaskWorktree(deps, request('codex'), async () => {});
    expect(appendLog).toHaveBeenCalledWith(1, 7, 'command', expect.objectContaining({ type: 'codex_trust_failed' }));
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('not = = toml');
  });
});
