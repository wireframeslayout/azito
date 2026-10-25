#!/usr/bin/env node
// pushing-default sidekick script, Node version (used on Windows; POSIX keeps push.sh). The same contract, the same environment
// variables and the same output lines as push.sh — change one, change the other (packages/server/.../pushScript.test.ts runs both):
//
//   - what is pushed is the worktree's CURRENT work branch; nothing is checked out. PushVerifier checks
//     `git ls-remote --heads origin <work branch>` and the provider's pull-request lookup, so this contract must not be broken;
//   - the PR base is AZITO_PR_BASE (a different thing from the work branch);
//   - creating the PR / MR is best-effort (the hub guarantees it when it sees the push): a missing or failing gh / glab never fails the script.
//
// Environment:
//   AZITO_GIT_PROVIDER    (optional) "github" (default) or "gitlab": which CLI makes the PR / MR
//   AZITO_COMMIT_MESSAGE  (required) the commit message (Conventional Commits)
//   AZITO_WORK_BRANCH     (optional) the branch the task expects; a warning when HEAD is another
//   AZITO_PR_BASE         (optional) the PR's base branch; unset: the CLI's repository default
//   AZITO_PR_BASE_FROM    (optional) where to create AZITO_PR_BASE from when origin has no such branch
//   AZITO_SKIP_PR         (optional) "1": push only
//   AZITO_PR_TITLE        (optional) default: the commit message
//   AZITO_PR_BODY         (optional) default: the commit message
//   AZITO_HUB_PUSH        (optional) "1": commit only, the hub pushes
//
// Run it inside the worktree. git is `git` on PATH (Git for Windows puts git.exe there); gh / glab are optional.
// Prints BRANCH / COMMIT_SHA / PR_URL lines on stdout. Exit codes: 0 done, 1 failed (git failed, detached HEAD, missing base), 2 bad environment.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** A failure that ends the script with a message on stderr. */
export class PushError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Runs `file args` in `cwd`; stdout is returned trimmed of its final newline. A non-zero exit throws unless `allowFailure`. */
function exec(file, args, { cwd, allowFailure = false, inheritStdout = false } = {}) {
  // A call that may fail on purpose (a CLI that is absent, a PR lookup) keeps its stderr to itself, like push.sh's `2>/dev/null`.
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', inheritStdout ? 'inherit' : 'pipe', allowFailure ? 'ignore' : 'inherit'] });
  if (result.error) {
    if (allowFailure) return { ok: false, stdout: '', missing: result.error.code === 'ENOENT' };
    throw new PushError(`${file} could not be run: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) throw new PushError(`${file} ${args.join(' ')} failed (exit ${result.status})`);
  return { ok: result.status === 0, stdout: (result.stdout ?? '').replace(/\r?\n$/, ''), missing: false };
}

/** Same checks as push.sh: a ref name git accepts as a branch. */
function assertBranchName(git, name) {
  if (!git(['check-ref-format', '--branch', name], { allowFailure: true }).ok) throw new PushError(`'${name}' is not a valid branch name`);
}

/**
 * Runs the push. `out` receives each stdout line, `err` each warning / error line; `env` and `cwd` are the process's own by default.
 * Resolves to the exit code.
 */
export function push({ env = process.env, cwd = process.cwd(), out = (line) => console.log(line), err = (line) => console.error(line) } = {}) {
  const commitMessage = env.AZITO_COMMIT_MESSAGE;
  if (!commitMessage) {
    err('AZITO_COMMIT_MESSAGE is required');
    return 2;
  }
  const provider = env.AZITO_GIT_PROVIDER || 'github';
  const skipPr = env.AZITO_SKIP_PR || '0';
  const prTitle = env.AZITO_PR_TITLE || commitMessage;
  const prBody = env.AZITO_PR_BODY || commitMessage;
  const prBase = env.AZITO_PR_BASE || '';
  const prBaseFrom = env.AZITO_PR_BASE_FROM || '';
  const git = (args, options = {}) => exec('git', args, { cwd, ...options });

  try {
    // ─── the current work branch (a detached HEAD fails; nothing is checked out) ───
    const workBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
    if (workBranch === 'HEAD') throw new PushError('ERROR: detached HEAD; cannot determine the work branch to push.');
    if (env.AZITO_WORK_BRANCH && workBranch !== env.AZITO_WORK_BRANCH) {
      err(`[WARN] HEAD branch '${workBranch}' differs from expected '${env.AZITO_WORK_BRANCH}'`);
    }
    assertBranchName(git, workBranch);
    if (prBase) assertBranchName(git, prBase);
    if (prBaseFrom) assertBranchName(git, prBaseFrom);

    // ─── commit ───
    if (git(['status', '--porcelain']).stdout !== '') {
      git(['add', '-A'], { inheritStdout: true });
      git(['commit', '-m', commitMessage], { inheritStdout: true });
    } else {
      out('No changes to commit.');
    }

    // ─── push (the work branch as it is) ───
    if (env.AZITO_HUB_PUSH === '1') {
      out(`BRANCH: ${workBranch}`);
      out(`COMMIT_SHA: ${git(['rev-parse', 'HEAD']).stdout}`);
      out('=== Hub-proxied push mode ===');
      out('Commit completed. Push will be handled by the hub.');
      return 0;
    }
    git(['push', '-u', 'origin', workBranch], { inheritStdout: true });
    out(`BRANCH: ${workBranch}`);
    out(`COMMIT_SHA: ${git(['rev-parse', 'HEAD']).stdout}`);
    if (skipPr === '1') {
      out('Skipping PR creation (AZITO_SKIP_PR=1).');
      return 0;
    }

    // ─── the PR base: created on origin from AZITO_PR_BASE_FROM when it is missing (no checkout) ───
    if (prBase && git(['ls-remote', '--heads', 'origin', prBase]).stdout === '') {
      if (!prBaseFrom) throw new PushError(`ERROR: PR base branch '${prBase}' does not exist on origin and AZITO_PR_BASE_FROM is not set.`);
      git(['fetch', 'origin'], { inheritStdout: true });
      git(['push', 'origin', `refs/remotes/origin/${prBaseFrom}:refs/heads/${prBase}`], { inheritStdout: true });
      out(`Created PR base branch '${prBase}' from 'origin/${prBaseFrom}'.`);
    }

    // ─── the PR (best-effort; the hub's PullRequestCreator is the guarantee) ───
    const cli = provider === 'gitlab' ? 'glab' : 'gh';
    const present = exec(cli, ['--version'], { allowFailure: true });
    if (!present.ok) {
      out(`PR_URL: (deferred to server; ${cli} CLI not found)`);
      return 0;
    }
    const existing = provider === 'gitlab' ? findGitlabMergeRequest(workBranch, cwd) : exec('gh', ['pr', 'list', '--head', workBranch, '--json', 'url', '--jq', '.[0].url'], { cwd, allowFailure: true }).stdout;
    if (existing) {
      out(`PR_URL: ${existing} (already exists)`);
      return 0;
    }
    const created = provider === 'gitlab'
      ? exec('glab', ['mr', 'create', '--source-branch', workBranch, ...(prBase ? ['--target-branch', prBase] : []), '--title', prTitle, '--description', prBody, '--no-editor', '--yes'], { cwd, allowFailure: true })
      : exec('gh', ['pr', 'create', '--head', workBranch, ...(prBase ? ['--base', prBase] : []), '--title', prTitle, '--body', prBody], { cwd, allowFailure: true });
    const url = created.ok ? (provider === 'gitlab' ? /https:\/\/\S+/.exec(created.stdout)?.[0] ?? '' : created.stdout) : '';
    out(url ? `PR_URL: ${url}` : `PR_URL: (deferred to server; ${cli} pr create failed)`);
    return 0;
  } catch (failure) {
    if (!(failure instanceof PushError)) throw failure;
    err(failure.message);
    return failure.exitCode;
  }
}

/** The web URL of the open merge request for the branch, or '' (no MR, or glab could not say). */
function findGitlabMergeRequest(branch, cwd) {
  const listed = exec('glab', ['api', `projects/:fullpath/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=1`], { cwd, allowFailure: true });
  if (!listed.ok) return '';
  try {
    return JSON.parse(listed.stdout)[0]?.web_url ?? '';
  } catch {
    return '';
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = push();
