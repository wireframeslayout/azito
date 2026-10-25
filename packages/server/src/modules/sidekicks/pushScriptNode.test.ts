import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// harness/sidekicks/pushing-default/scripts/push.mjs (the Windows version of push.sh) run for real, on every OS: in a temp repository with a bare
// remote, with a fake `gh` first on PATH. The fake is a copy of the node executable named gh(.exe) that answers from a preloaded script
// (NODE_OPTIONS --require): it is found by the same executable lookup as a real gh.exe, which a .cmd or a shell script would not be on Windows.
// pushScript.test.ts holds the same scenarios for push.sh.
const PUSH_MJS = path.resolve(__dirname, '..', '..', '..', '..', '..', 'harness', 'sidekicks', 'pushing-default', 'scripts', 'push.mjs');
const GH_NAME = process.platform === 'win32' ? 'gh.exe' : 'gh';

const FAKE_GH_PRELOAD = `
const path = require('node:path');
const fs = require('node:fs');
if (path.basename(process.execPath).toLowerCase().startsWith('gh')) {
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  fs.appendFileSync(process.env.GH_CALL_LOG, args.join(' ') + '\\n');
  const key = args.slice(0, 2).join(' ');
  if (key === 'pr list') {
    process.stdout.write(fs.existsSync(process.env.GH_PR_LIST_OUTPUT_FILE) ? fs.readFileSync(process.env.GH_PR_LIST_OUTPUT_FILE, 'utf8') : '');
    process.exit(0);
  }
  if (key === 'pr create') {
    console.log('https://github.com/example/repo/pull/123');
    process.exit(0);
  }
  process.exit(1);
}
`;

let fakeBin: string;

beforeAll(() => {
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'push-mjs-fake-gh-'));
  fs.copyFileSync(process.execPath, path.join(fakeBin, GH_NAME));
  fs.writeFileSync(path.join(fakeBin, 'fake-gh.cjs'), FAKE_GH_PRELOAD);
});

afterAll(() => {
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

interface TestEnv {
  root: string;
  workDir: string;
  remoteDir: string;
  ghCallLog: string;
  ghPrListOutputFile: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** A work directory whose name has a space and a non-ASCII character: nothing about the script may depend on quoting or the code page. */
function setupRepo(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push mjs テスト-'));
  const remoteDir = path.join(root, 'remote.git');
  const workDir = path.join(root, 'work dir');
  execFileSync('git', ['init', '--bare', remoteDir]);
  fs.mkdirSync(workDir);
  git(workDir, ['init', '-b', 'master']);
  git(workDir, ['config', 'user.email', 'test@example.com']);
  git(workDir, ['config', 'user.name', 'Test']);
  git(workDir, ['config', 'core.autocrlf', 'false']);
  git(workDir, ['remote', 'add', 'origin', remoteDir]);
  fs.writeFileSync(path.join(workDir, 'README.md'), 'initial\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-m', 'initial']);
  git(workDir, ['push', '-u', 'origin', 'master']);
  const ghCallLog = path.join(root, 'gh-calls.log');
  fs.writeFileSync(ghCallLog, '');
  return { root, workDir, remoteDir, ghCallLog, ghPrListOutputFile: path.join(root, 'gh-pr-list-output.txt') };
}

function runPush(env: TestEnv, extraEnv: Record<string, string | undefined>): { stdout: string; stderr: string; status: number } {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(fakeBin, 'fake-gh.cjs'))}`,
    GH_CALL_LOG: env.ghCallLog,
    GH_PR_LIST_OUTPUT_FILE: env.ghPrListOutputFile,
    AZITO_COMMIT_MESSAGE: 'feat: test change',
    ...extraEnv,
  };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const result = spawnSync(process.execPath, [PUSH_MJS], { cwd: env.workDir, encoding: 'utf-8', env: childEnv as NodeJS.ProcessEnv });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1 };
}

describe('push.mjs', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupRepo();
    // The work branch with a change: the state AZITO's worktree contract leaves the task in.
    git(env.workDir, ['checkout', '-b', 'task/42-feature']);
    fs.writeFileSync(path.join(env.workDir, 'feature.txt'), 'change\n');
  });

  afterEach(() => {
    fs.rmSync(env.root, { recursive: true, force: true });
  });

  it('commits, pushes the CURRENT work branch, and creates a PR with --head <work branch>', () => {
    const { stdout, status } = runPush(env, { AZITO_PR_TITLE: 'My PR' });
    expect(status).toBe(0);
    expect(stdout).toContain('BRANCH: task/42-feature');
    expect(stdout).toContain('PR_URL: https://github.com/example/repo/pull/123');

    // The work branch is on the remote (the way PushVerifier checks it).
    const remoteHeads = git(env.workDir, ['ls-remote', '--heads', 'origin', 'task/42-feature']);
    expect(remoteHeads.trim()).not.toBe('');
    expect(remoteHeads).toContain(git(env.workDir, ['rev-parse', 'HEAD']).trim());
    expect(stdout).toContain(`COMMIT_SHA: ${git(env.workDir, ['rev-parse', 'HEAD']).trim()}`);

    // master did not move.
    expect(git(env.workDir, ['ls-remote', '--heads', 'origin', 'master']).slice(0, 40)).toBe(git(env.workDir, ['rev-parse', 'master']).trim());

    const calls = fs.readFileSync(env.ghCallLog, 'utf-8');
    expect(calls).toContain('pr create --head task/42-feature');
    expect(calls).toContain('--title My PR');
    expect(calls).not.toContain('--base');
  });

  it('commits with a message that has non-ASCII characters, spaces and quotes as it is', () => {
    const message = 'feat: "日本語" のコミット $HOME `x`';
    const { status } = runPush(env, { AZITO_COMMIT_MESSAGE: message, AZITO_SKIP_PR: '1' });
    expect(status).toBe(0);
    expect(git(env.workDir, ['log', '-1', '--format=%s']).trim()).toBe(message);
  });

  it('passes --base when AZITO_PR_BASE is set and the base exists on the remote', () => {
    const { status } = runPush(env, { AZITO_PR_BASE: 'master' });
    expect(status).toBe(0);
    expect(fs.readFileSync(env.ghCallLog, 'utf-8')).toContain('--base master');
  });

  it('creates a missing PR base branch from AZITO_PR_BASE_FROM without checking out', () => {
    const { stdout, status } = runPush(env, { AZITO_PR_BASE: 'release/v2', AZITO_PR_BASE_FROM: 'master' });
    expect(status).toBe(0);
    expect(stdout).toContain("Created PR base branch 'release/v2' from 'origin/master'.");
    expect(git(env.workDir, ['ls-remote', '--heads', 'origin', 'release/v2']).trim()).not.toBe('');
    expect(git(env.workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('task/42-feature');
  });

  it('fails with a clear error when AZITO_PR_BASE is missing on remote and AZITO_PR_BASE_FROM is not set', () => {
    const { stderr, status } = runPush(env, { AZITO_PR_BASE: 'release/v2' });
    expect(status).toBe(1);
    expect(stderr).toContain("PR base branch 'release/v2' does not exist on origin");
  });

  it('skips PR creation when AZITO_SKIP_PR=1 (still pushes)', () => {
    const { stdout, status } = runPush(env, { AZITO_SKIP_PR: '1' });
    expect(status).toBe(0);
    expect(stdout).toContain('Skipping PR creation');
    expect(git(env.workDir, ['ls-remote', '--heads', 'origin', 'task/42-feature']).trim()).not.toBe('');
    expect(fs.readFileSync(env.ghCallLog, 'utf-8')).not.toContain('pr create');
  });

  it('reuses an existing PR instead of creating a new one', () => {
    fs.writeFileSync(env.ghPrListOutputFile, 'https://github.com/example/repo/pull/99\n');
    const { stdout, status } = runPush(env, {});
    expect(status).toBe(0);
    expect(stdout).toContain('PR_URL: https://github.com/example/repo/pull/99 (already exists)');
    expect(fs.readFileSync(env.ghCallLog, 'utf-8')).not.toContain('pr create');
  });

  it('fails on detached HEAD without pushing anything', () => {
    git(env.workDir, ['add', '-A']);
    git(env.workDir, ['commit', '-m', 'wip']);
    git(env.workDir, ['checkout', git(env.workDir, ['rev-parse', 'HEAD']).trim()]);

    const { stderr, status } = runPush(env, {});
    expect(status).toBe(1);
    expect(stderr).toContain('detached HEAD');
    expect(git(env.workDir, ['ls-remote', '--heads', 'origin', 'task/42-feature']).trim()).toBe('');
  });

  it('warns when HEAD is not the branch the task expects, and still pushes HEAD', () => {
    const { stderr, status } = runPush(env, { AZITO_WORK_BRANCH: 'task/other', AZITO_SKIP_PR: '1' });
    expect(status).toBe(0);
    expect(stderr).toContain("HEAD branch 'task/42-feature' differs from expected 'task/other'");
  });

  it('fails when AZITO_COMMIT_MESSAGE is missing, before touching the repository', () => {
    const { status } = runPush(env, { AZITO_COMMIT_MESSAGE: '' });
    expect(status).not.toBe(0);
    expect(git(env.workDir, ['status', '--porcelain']).trim()).toContain('feature.txt');
  });

  it('succeeds with no changes to commit (push-only rerun)', () => {
    git(env.workDir, ['add', '-A']);
    git(env.workDir, ['commit', '-m', 'already committed']);
    const { stdout, status } = runPush(env, { AZITO_SKIP_PR: '1' });
    expect(status).toBe(0);
    expect(stdout).toContain('No changes to commit.');
    expect(stdout).toContain('BRANCH: task/42-feature');
  });

  it('commits only, and says so, when the hub pushes (AZITO_HUB_PUSH=1)', () => {
    const { stdout, status } = runPush(env, { AZITO_HUB_PUSH: '1' });
    expect(status).toBe(0);
    expect(stdout).toContain('=== Hub-proxied push mode ===');
    expect(git(env.workDir, ['ls-remote', '--heads', 'origin', 'task/42-feature']).trim()).toBe('');
    expect(git(env.workDir, ['log', '-1', '--format=%s']).trim()).toBe('feat: test change');
  });
});
