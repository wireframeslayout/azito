import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// harness/sidekicks/pushing-default/scripts/push.sh の bash 単体テスト。
// temp git repo（bare remote 付き）+ fake gh を PATH 先頭に置いて実行する。
const PUSH_SH = path.resolve(__dirname, '..', '..', '..', '..', '..', 'harness', 'sidekicks', 'pushing-default', 'scripts', 'push.sh');

const FAKE_GH = `#!/usr/bin/env bash
# fake gh: 呼び出しをログに記録し、canned レスポンスを返す
echo "$@" >> "$GH_CALL_LOG"
case "$1 $2" in
  "pr list")
    cat "$GH_PR_LIST_OUTPUT_FILE" 2>/dev/null || echo ""
    ;;
  "pr create")
    echo "https://github.com/example/repo/pull/123"
    ;;
  *)
    exit 1
    ;;
esac
`;

interface TestEnv {
  workDir: string;
  remoteDir: string;
  binDir: string;
  ghCallLog: string;
  ghPrListOutputFile: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function setupRepo(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-sh-test-'));
  const remoteDir = path.join(root, 'remote.git');
  const workDir = path.join(root, 'work');
  const binDir = path.join(root, 'bin');
  const ghCallLog = path.join(root, 'gh-calls.log');
  const ghPrListOutputFile = path.join(root, 'gh-pr-list-output.txt');

  execFileSync('git', ['init', '--bare', remoteDir]);
  fs.mkdirSync(workDir);
  git(workDir, ['init', '-b', 'master']);
  git(workDir, ['config', 'user.email', 'test@example.com']);
  git(workDir, ['config', 'user.name', 'Test']);
  git(workDir, ['remote', 'add', 'origin', remoteDir]);
  fs.writeFileSync(path.join(workDir, 'README.md'), 'initial\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-m', 'initial']);
  git(workDir, ['push', '-u', 'origin', 'master']);

  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH);
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);
  fs.writeFileSync(ghCallLog, '');

  return { workDir, remoteDir, binDir, ghCallLog, ghPrListOutputFile };
}

function runPushSh(env: TestEnv, extraEnv: Record<string, string>): { stdout: string; status: number } {
  try {
    const stdout = execSync(`bash ${JSON.stringify(PUSH_SH)}`, {
      cwd: env.workDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${env.binDir}:${process.env.PATH}`,
        GH_CALL_LOG: env.ghCallLog,
        GH_PR_LIST_OUTPUT_FILE: env.ghPrListOutputFile,
        AZITO_COMMIT_MESSAGE: 'feat: test change',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

describe('push.sh', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupRepo();
    // 作業ブランチを切って変更を作る（AZITO の worktree 契約と同じ状態）
    git(env.workDir, ['checkout', '-b', 'task/42-feature']);
    fs.writeFileSync(path.join(env.workDir, 'feature.txt'), 'change\n');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(env.remoteDir), { recursive: true, force: true });
  });

  it('commits, pushes the CURRENT work branch, and creates a PR with --head <work branch>', () => {
    const { stdout, status } = runPushSh(env, { AZITO_PR_TITLE: 'My PR' });
    expect(status).toBe(0);
    expect(stdout).toContain('BRANCH: task/42-feature');
    expect(stdout).toContain('PR_URL: https://github.com/example/repo/pull/123');

    // 作業ブランチが remote に push されている（PushVerifier と同じ検証方法）
    const remoteHeads = git(env.workDir, ['ls-remote', '--heads', 'origin', 'task/42-feature']);
    expect(remoteHeads.trim()).not.toBe('');
    const localSha = git(env.workDir, ['rev-parse', 'HEAD']).trim();
    expect(remoteHeads).toContain(localSha);

    // master は動いていない（checkout -B のような base 破壊がない）
    const masterRemote = git(env.workDir, ['ls-remote', '--heads', 'origin', 'master']).slice(0, 40);
    const masterLocal = git(env.workDir, ['rev-parse', 'master']).trim();
    expect(masterRemote).toBe(masterLocal);

    // gh pr create は --head 作業ブランチ で呼ばれている
    const calls = fs.readFileSync(env.ghCallLog, 'utf-8');
    expect(calls).toContain('pr create --head task/42-feature');
    // AZITO_PR_BASE 未指定なら --base を付けない
    expect(calls).not.toContain('--base');
  });

  it('passes --base when AZITO_PR_BASE is set and the base exists on the remote', () => {
    const { status } = runPushSh(env, { AZITO_PR_BASE: 'master' });
    expect(status).toBe(0);
    const calls = fs.readFileSync(env.ghCallLog, 'utf-8');
    expect(calls).toContain('--base master');
  });

  it('creates a missing PR base branch from AZITO_PR_BASE_FROM without checking out', () => {
    const { status } = runPushSh(env, { AZITO_PR_BASE: 'release/v2', AZITO_PR_BASE_FROM: 'master' });
    expect(status).toBe(0);
    // base ブランチがリモートに作成されている
    const remoteHeads = git(env.workDir, ['ls-remote', '--heads', 'origin', 'release/v2']);
    expect(remoteHeads.trim()).not.toBe('');
    // 現在ブランチは変わっていない（checkout していない）
    expect(git(env.workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('task/42-feature');
  });

  it('fails with a clear error when AZITO_PR_BASE is missing on remote and AZITO_PR_BASE_FROM is not set', () => {
    const { status } = runPushSh(env, { AZITO_PR_BASE: 'release/v2' });
    expect(status).toBe(1);
  });

  it('skips PR creation when AZITO_SKIP_PR=1 (still pushes)', () => {
    const { stdout, status } = runPushSh(env, { AZITO_SKIP_PR: '1' });
    expect(status).toBe(0);
    expect(stdout).toContain('Skipping PR creation');
    const remoteHeads = git(env.workDir, ['ls-remote', '--heads', 'origin', 'task/42-feature']);
    expect(remoteHeads.trim()).not.toBe('');
    const calls = fs.readFileSync(env.ghCallLog, 'utf-8');
    expect(calls).not.toContain('pr create');
  });

  it('reuses an existing PR instead of creating a new one', () => {
    fs.writeFileSync(env.ghPrListOutputFile, 'https://github.com/example/repo/pull/99\n');
    const { stdout, status } = runPushSh(env, {});
    expect(status).toBe(0);
    expect(stdout).toContain('PR_URL: https://github.com/example/repo/pull/99 (already exists)');
    const calls = fs.readFileSync(env.ghCallLog, 'utf-8');
    expect(calls).not.toContain('pr create');
  });

  it('fails on detached HEAD without pushing anything', () => {
    git(env.workDir, ['add', '-A']);
    git(env.workDir, ['commit', '-m', 'wip']);
    const sha = git(env.workDir, ['rev-parse', 'HEAD']).trim();
    git(env.workDir, ['checkout', sha]);

    const { status } = runPushSh(env, {});
    expect(status).toBe(1);
    const remoteHeads = git(env.workDir, ['ls-remote', '--heads', 'origin', 'task/42-feature']);
    expect(remoteHeads.trim()).toBe('');
  });

  it('fails when AZITO_COMMIT_MESSAGE is missing', () => {
    const { status } = runPushSh(env, { AZITO_COMMIT_MESSAGE: '' });
    expect(status).not.toBe(0);
  });

  it('succeeds with no changes to commit (push-only rerun)', () => {
    git(env.workDir, ['add', '-A']);
    git(env.workDir, ['commit', '-m', 'already committed']);
    const { stdout, status } = runPushSh(env, { AZITO_SKIP_PR: '1' });
    expect(status).toBe(0);
    expect(stdout).toContain('No changes to commit.');
    expect(stdout).toContain('BRANCH: task/42-feature');
  });
});
