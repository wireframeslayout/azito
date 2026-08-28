import { describe, it, expect, vi } from 'vitest';
import { RemoteBundleOps } from './RemoteBundleOps';
import { DUMMY_ORIGIN_URL } from './types';

// Issue #87 third-party review, seventh pass, Important finding 1: most of
// RemoteBundleOps's remote git calls now run through `execWithSentinel`,
// which appends `; echo "AZITO_RC:$?"` to the command and reads the REAL
// remote exit status back out of stdout — the only signal that survives an
// `ssh` transport's `code`/`stderr` masking unchanged (see
// `execWithSentinel`'s doc comment). This mock models that faithfully: when
// (and only when) the command under test actually carries the sentinel
// echo, `code` here is the REAL remote exit status the sentinel line would
// report — not the transport-level `code`/`stderr` an `ssh` transport
// returns (which this mock deliberately leaves untouched otherwise, so
// callers that don't use the sentinel — `getHeadSha`/`repoExists`/
// `getMirrorBranchSha`/etc. — are unaffected).
function mockTransport(responses: Record<string, { stdout: string; stderr: string; code: number }>) {
  return {
    exec: vi.fn(async (cmd: string) => {
      let result = { stdout: '', stderr: '', code: 0 };
      for (const [pattern, candidate] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          result = candidate;
          break;
        }
      }
      if (cmd.includes('AZITO_RC:$?')) {
        return { ...result, stdout: `${result.stdout}\nAZITO_RC:${result.code}` };
      }
      return result;
    }),
  } as any;
}

describe('RemoteBundleOps', () => {
  const ops = new RemoteBundleOps();

  describe('verify', () => {
    it('returns true when exit code is 0', async () => {
      const transport = mockTransport({ 'bundle verify': { stdout: 'ok', stderr: '', code: 0 } });
      expect(await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle')).toBe(true);
    });

    it('returns false when exit code is non-zero and stderr carries a git error: line', async () => {
      const transport = mockTransport({ 'bundle verify': { stdout: '', stderr: 'error: bundle mismatch', code: 1 } });
      expect(await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle')).toBe(false);
    });

    it('returns false when the sentinel reports a non-zero exit even though stderr also carries fatal:', async () => {
      const transport = mockTransport({ 'bundle verify': { stdout: '', stderr: 'fatal: bad bundle', code: 128 } });
      expect(await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle')).toBe(false);
    });

    // Issue #87 third-party review, seventh pass, Important finding 1: the
    // exit-status sentinel decides purely on the REAL remote exit code it
    // captures — not on `fatal:`/`error:` text — so this now also catches a
    // failure that never prints in git's own message format at all (e.g.
    // `sh: git: command not found`, `Permission denied`), which the old
    // text-only scan on an `ssh`-shaped transport (`code: 0`, `stderr: ''`)
    // used to miss entirely.
    it('returns false for an SSH-shaped transport (code 0, empty stderr) when the sentinel reports a non-git-formatted failure', async () => {
      const transport = mockTransport({
        'bundle verify': { stdout: 'sh: git: command not found', stderr: '', code: 127 },
      });
      expect(await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle')).toBe(false);
    });

    it('returns true for an SSH-shaped success result (code 0, empty stderr, ok text in stdout)', async () => {
      const transport = mockTransport({
        'bundle verify': { stdout: 'The bundle contains this ref:\n  refs/heads/main\nThe bundle records a complete history.', stderr: '', code: 0 },
      });
      expect(await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle')).toBe(true);
    });

    // Issue #87 third-party review, seventh pass, Important finding 1: when
    // the sentinel line never arrives at all (connection drop, command
    // timeout — the command never ran to completion), `verify()` must throw
    // `RemoteGitCommandError` with `transportFailure: true` rather than
    // silently treating the command as having succeeded or failed on text
    // content it doesn't have.
    it('throws RemoteGitCommandError with transportFailure: true when the sentinel is missing', async () => {
      const transport = mockTransport({ 'bundle verify': { stdout: 'connection reset by peer', stderr: '', code: 0 } });
      // NOTE: this mock intentionally does NOT get the sentinel appended,
      // even though the real command carries `; echo "AZITO_RC:$?"` — the
      // scenario under test is exactly that the shell never reached that
      // echo. mockTransport only appends the sentinel line automatically
      // for the happy path; simulate its absence by responding without it.
      transport.exec = vi.fn(async () => ({ stdout: 'connection reset by peer', stderr: '', code: 0 }));
      const err: any = await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('RemoteGitCommandError');
      expect(err.transportFailure).toBe(true);
    });

    // Issue #87 review, 8th pass, Minor finding 3: `transport.exec()`
    // rejecting outright (agent HTTP failure, dropped connection, thrown
    // timeout) is a different failure mode than resolving without the
    // sentinel line, but must be classified the same way —
    // `RemoteGitCommandError({ transportFailure: true })` — so
    // `FetchDistributionService.deliverToMirror()`'s incremental->full
    // fallback still skips it instead of retrying a bundle for a failure
    // that has nothing to do with the bundle's content.
    it('throws RemoteGitCommandError with transportFailure: true when transport.exec() itself rejects', async () => {
      const transport = { exec: vi.fn(async () => { throw new Error('agent unreachable: 502'); }) } as any;
      const err: any = await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('RemoteGitCommandError');
      expect(err.transportFailure).toBe(true);
    });

    // Issue #87 third-party review, fourth pass, Important finding 1:
    // `git bundle verify` needs a repository context to check the bundle's
    // prerequisite commits against; run without `-C <mirrorDir>` it fails
    // unconditionally with `error: need a repository to verify a bundle`,
    // breaking every distribution. Assert the mirror dir is actually passed
    // through to the command.
    it('runs bundle verify with -C <mirrorDir>', async () => {
      const transport = mockTransport({ 'bundle verify': { stdout: 'ok', stderr: '', code: 0 } });
      await ops.verify(transport, '/tmp/mirror.git', '/tmp/test.bundle');
      const cmd = (transport.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(cmd).toContain("git -C '/tmp/mirror.git' bundle verify '/tmp/test.bundle'");
    });
  });

  describe('getHeadSha', () => {
    it('returns sha when valid', async () => {
      const sha = 'a'.repeat(40);
      const transport = mockTransport({ 'git rev-parse HEAD': { stdout: sha + '\n', stderr: '', code: 0 } });
      expect(await ops.getHeadSha(transport, '/repo')).toBe(sha);
    });

    it('returns null for invalid sha', async () => {
      const transport = mockTransport({ 'git rev-parse HEAD': { stdout: 'not-a-sha\n', stderr: '', code: 0 } });
      expect(await ops.getHeadSha(transport, '/repo')).toBeNull();
    });

    it('returns null when command fails', async () => {
      const transport = mockTransport({ 'git rev-parse HEAD': { stdout: '', stderr: '', code: 128 } });
      expect(await ops.getHeadSha(transport, '/repo')).toBeNull();
    });
  });

  describe('repoExists', () => {
    it('returns true when .git exists', async () => {
      const transport = mockTransport({ 'test -d': { stdout: 'yes', stderr: '', code: 0 } });
      expect(await ops.repoExists(transport, '/repo')).toBe(true);
    });

    it('returns false when .git does not exist', async () => {
      const transport = mockTransport({ 'test -d': { stdout: 'no', stderr: '', code: 0 } });
      expect(await ops.repoExists(transport, '/repo')).toBe(false);
    });
  });

  describe('setDummyOrigin', () => {
    it('sets origin to the .invalid dummy URL', async () => {
      const transport = mockTransport({ 'git remote set-url': { stdout: '', stderr: '', code: 0 } });
      await ops.setDummyOrigin(transport, '/repo');
      expect(transport.exec).toHaveBeenCalledWith(
        expect.stringContaining(DUMMY_ORIGIN_URL),
        10_000,
      );
    });
  });

  describe('createFromWorktree', () => {
    it('creates bundle with --not clause when baseBranch is provided', async () => {
      const transport = mockTransport({ 'git bundle create': { stdout: '', stderr: '', code: 0 } });
      const path = await ops.createFromWorktree(transport, '/worktree', 'feature', 'main');
      expect(path).toMatch(/^\/tmp\/azito-push-[0-9a-f]+\.bundle$/);
      const cmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(cmd).toContain("--not 'origin/main'");
    });

    it('creates bundle without --not clause when baseBranch is null', async () => {
      const transport = mockTransport({ 'git bundle create': { stdout: '', stderr: '', code: 0 } });
      await ops.createFromWorktree(transport, '/worktree', 'feature', null);
      const cmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(cmd).not.toContain('--not');
    });

    it('rejects unsafe branch names', async () => {
      const transport = mockTransport({});
      await expect(ops.createFromWorktree(transport, '/worktree', 'feat; rm -rf /', null))
        .rejects.toThrow();
    });

    it('rejects unsafe baseBranch names', async () => {
      const transport = mockTransport({});
      await expect(ops.createFromWorktree(transport, '/worktree', 'feature', '$(evil)'))
        .rejects.toThrow();
    });

    it('throws on git failure', async () => {
      const transport = mockTransport({ 'git bundle create': { stdout: '', stderr: 'fatal: bad', code: 128 } });
      await expect(ops.createFromWorktree(transport, '/worktree', 'feature', null))
        .rejects.toThrow('git bundle create failed');
    });
  });

  describe('resolveHomeDir', () => {
    it('returns trimmed $HOME', async () => {
      const transport = mockTransport({ 'echo $HOME': { stdout: '/home/agent\n', stderr: '', code: 0 } });
      expect(await ops.resolveHomeDir(transport)).toBe('/home/agent');
    });

    it('throws when $HOME is empty', async () => {
      const transport = mockTransport({ 'echo $HOME': { stdout: '', stderr: '', code: 0 } });
      await expect(ops.resolveHomeDir(transport)).rejects.toThrow('$HOME');
    });
  });

  describe('mirrorDir', () => {
    it('builds the ~/.azito/repos/<hash>.git path', () => {
      expect(ops.mirrorDir('/home/agent', 'abc123')).toBe('/home/agent/.azito/repos/abc123.git');
    });
  });

  describe('mirrorExists', () => {
    it('returns true when HEAD file exists', async () => {
      const transport = mockTransport({ 'test -f': { stdout: 'yes', stderr: '', code: 0 } });
      expect(await ops.mirrorExists(transport, '/mirror')).toBe(true);
    });

    it('returns false when HEAD file is absent', async () => {
      const transport = mockTransport({ 'test -f': { stdout: 'no', stderr: '', code: 0 } });
      expect(await ops.mirrorExists(transport, '/mirror')).toBe(false);
    });
  });

  describe('ensureMirror', () => {
    it('does nothing when the mirror already exists', async () => {
      const transport = mockTransport({ 'test -f': { stdout: 'yes', stderr: '', code: 0 } });
      await ops.ensureMirror(transport, '/mirror');
      expect(transport.exec).toHaveBeenCalledTimes(1);
    });

    it('runs git init --bare when the mirror is missing', async () => {
      const transport = mockTransport({
        'test -f': { stdout: 'no', stderr: '', code: 0 },
        'git -c core.hooksPath=/dev/null init --bare': { stdout: '', stderr: '', code: 0 },
      });
      await ops.ensureMirror(transport, '/mirror');
      const cmd = (transport.exec as any).mock.calls[1][0] as string;
      expect(cmd).toContain('mkdir -p');
      expect(cmd).toContain('init --bare');
      expect(cmd).toContain('core.hooksPath=/dev/null');
    });

    it('throws when git init --bare fails', async () => {
      const transport = mockTransport({
        'test -f': { stdout: 'no', stderr: '', code: 0 },
        'init --bare': { stdout: '', stderr: 'fatal: cannot create', code: 128 },
      });
      await expect(ops.ensureMirror(transport, '/mirror')).rejects.toThrow('git init --bare for mirror failed');
    });
  });

  describe('getMirrorBranchSha', () => {
    it('returns the sha when the branch exists in the mirror', async () => {
      const sha = 'a'.repeat(40);
      const transport = mockTransport({ 'rev-parse --verify': { stdout: sha + '\n', stderr: '', code: 0 } });
      expect(await ops.getMirrorBranchSha(transport, '/mirror', 'main')).toBe(sha);
    });

    it('returns null when the branch is not present (never distributed)', async () => {
      const transport = mockTransport({ 'rev-parse --verify': { stdout: '', stderr: 'fatal: unknown revision', code: 128 } });
      expect(await ops.getMirrorBranchSha(transport, '/mirror', 'main')).toBeNull();
    });

    it('rejects unsafe branch names', async () => {
      const transport = mockTransport({});
      await expect(ops.getMirrorBranchSha(transport, '/mirror', 'feat; rm -rf /')).rejects.toThrow();
    });
  });

  describe('fetchBundleIntoMirror', () => {
    it('uses a forced refspec and --atomic', async () => {
      const transport = mockTransport({ 'git -C': { stdout: '', stderr: '', code: 0 } });
      await ops.fetchBundleIntoMirror(transport, '/mirror', '/tmp/dist.bundle', 'main');
      const cmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(cmd).toContain('--atomic');
      expect(cmd).toContain("'+refs/heads/main:refs/heads/main'");
      expect(cmd).toContain('core.hooksPath=/dev/null');
    });

    it('throws on fetch failure (e.g. would otherwise be non-fast-forward)', async () => {
      const transport = mockTransport({ 'git -C': { stdout: '', stderr: 'fatal: rejected', code: 1 } });
      await expect(ops.fetchBundleIntoMirror(transport, '/mirror', '/tmp/dist.bundle', 'main'))
        .rejects.toThrow('git fetch bundle into mirror failed');
    });

    // Issue #87 third-party review, seventh pass, Important finding 1: the
    // exit-status sentinel decides on the REAL remote exit code, so this
    // catches the failure even on an `ssh`-shaped transport (`code: 0`,
    // `stderr: ''`) and even when the remote failure text doesn't follow
    // git's own `fatal:`/`error:` format.
    it('throws on an SSH-shaped fetch failure (code 0, empty stderr, non-git-formatted failure text)', async () => {
      const transport = mockTransport({
        'git -C': { stdout: 'sh: git: command not found', stderr: '', code: 127 },
      });
      await expect(ops.fetchBundleIntoMirror(transport, '/mirror', '/tmp/dist.bundle', 'main'))
        .rejects.toThrow('git fetch bundle into mirror failed');
    });

    it('throws RemoteGitCommandError with transportFailure: true when the sentinel is missing', async () => {
      const transport = { exec: vi.fn(async () => ({ stdout: 'connection reset by peer', stderr: '', code: 0 })) } as any;
      const err: any = await ops.fetchBundleIntoMirror(transport, '/mirror', '/tmp/dist.bundle', 'main').catch((e: unknown) => e);
      expect(err.name).toBe('RemoteGitCommandError');
      expect(err.transportFailure).toBe(true);
    });
  });

  describe('cloneWorkingDirFromMirror', () => {
    it('clones with --no-local from the mirror path, with hooks disabled (no detach — see ensureDetachedHead)', async () => {
      const transport = mockTransport({
        'git -c core.hooksPath=/dev/null clone': { stdout: '', stderr: '', code: 0 },
      });
      await ops.cloneWorkingDirFromMirror(transport, '/mirror', '/repo', 'main');
      expect((transport.exec as any).mock.calls.length).toBe(1);
      const cloneCmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(cloneCmd).toContain('--no-local');
      expect(cloneCmd).toContain("--branch 'main'");
      expect(cloneCmd).toContain("'/mirror'");
      expect(cloneCmd).toContain('core.hooksPath=/dev/null');
      expect(cloneCmd).not.toContain('checkout --detach');
    });

    it('throws on clone failure', async () => {
      const transport = mockTransport({ 'git -c core.hooksPath=/dev/null clone': { stdout: '', stderr: 'fatal: not a bundle', code: 128 } });
      await expect(ops.cloneWorkingDirFromMirror(transport, '/mirror', '/repo', 'main'))
        .rejects.toThrow('git clone from mirror failed');
    });

    it('throws on an SSH-shaped clone failure (code 0, empty stderr, non-git-formatted failure text)', async () => {
      const transport = mockTransport({
        'git -c core.hooksPath=/dev/null clone': { stdout: 'sh: git: command not found', stderr: '', code: 127 },
      });
      await expect(ops.cloneWorkingDirFromMirror(transport, '/mirror', '/repo', 'main'))
        .rejects.toThrow('git clone from mirror failed');
    });
  });

  describe('ensureDetachedHead', () => {
    it('detaches HEAD with hooks disabled', async () => {
      const transport = mockTransport({
        'checkout --detach': { stdout: '', stderr: '', code: 0 },
      });
      await ops.ensureDetachedHead(transport, '/repo');
      expect((transport.exec as any).mock.calls.length).toBe(1);
      const detachCmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(detachCmd).toContain("git -C '/repo'");
      expect(detachCmd).toContain('checkout --detach');
      expect(detachCmd).toContain('core.hooksPath=/dev/null');
    });

    it('throws on detach failure', async () => {
      const transport = mockTransport({
        'checkout --detach': { stdout: '', stderr: 'fatal: could not detach', code: 128 },
      });
      await expect(ops.ensureDetachedHead(transport, '/repo'))
        .rejects.toThrow('git checkout --detach failed');
    });
  });

  describe('fetchWorkingDirFromMirror', () => {
    it('fetches the mirror path directly (not via origin), updating only the remote-tracking ref with a forced refspec, without touching the local branch', async () => {
      const transport = mockTransport({
        'fetch --atomic': { stdout: '', stderr: '', code: 0 },
      });
      await ops.fetchWorkingDirFromMirror(transport, '/mirror', '/repo', 'main');

      expect((transport.exec as any).mock.calls.length).toBe(1);
      const fetchCmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(fetchCmd).toContain('--atomic');
      expect(fetchCmd).toContain("'/mirror'");
      expect(fetchCmd).toContain("'+refs/heads/main:refs/remotes/origin/main'");
      expect(fetchCmd).not.toContain("refs/heads/main:refs/heads/main");
      expect(fetchCmd).not.toContain('checkout --detach');
    });

    it('throws on fetch failure', async () => {
      const transport = mockTransport({
        'fetch --atomic': { stdout: '', stderr: 'fatal: rejected', code: 1 },
      });
      await expect(ops.fetchWorkingDirFromMirror(transport, '/mirror', '/repo', 'main'))
        .rejects.toThrow('git fetch from mirror failed');
    });
  });
});
