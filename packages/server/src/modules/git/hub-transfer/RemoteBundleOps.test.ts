import { describe, it, expect, vi } from 'vitest';
import { RemoteBundleOps } from './RemoteBundleOps';
import { DUMMY_ORIGIN_URL } from './types';

function mockTransport(responses: Record<string, { stdout: string; stderr: string; code: number }>) {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [pattern, result] of Object.entries(responses)) {
        if (cmd.includes(pattern)) return result;
      }
      return { stdout: '', stderr: '', code: 0 };
    }),
  } as any;
}

describe('RemoteBundleOps', () => {
  const ops = new RemoteBundleOps();

  describe('verify', () => {
    it('returns true when exit code is 0', async () => {
      const transport = mockTransport({ 'git bundle verify': { stdout: 'ok', stderr: '', code: 0 } });
      expect(await ops.verify(transport, '/tmp/test.bundle')).toBe(true);
    });

    it('returns false when exit code is non-zero', async () => {
      const transport = mockTransport({ 'git bundle verify': { stdout: '', stderr: 'error', code: 1 } });
      expect(await ops.verify(transport, '/tmp/test.bundle')).toBe(false);
    });

    it('returns false when stderr contains fatal:', async () => {
      const transport = mockTransport({ 'git bundle verify': { stdout: '', stderr: 'fatal: bad bundle', code: 0 } });
      expect(await ops.verify(transport, '/tmp/test.bundle')).toBe(false);
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
  });

  describe('cloneWorkingDirFromMirror', () => {
    it('clones with --no-local from the mirror path, with hooks disabled, then detaches HEAD', async () => {
      const transport = mockTransport({
        'git -c core.hooksPath=/dev/null clone': { stdout: '', stderr: '', code: 0 },
        'checkout --detach': { stdout: '', stderr: '', code: 0 },
      });
      await ops.cloneWorkingDirFromMirror(transport, '/mirror', '/repo', 'main');
      const cloneCmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(cloneCmd).toContain('--no-local');
      expect(cloneCmd).toContain("--branch 'main'");
      expect(cloneCmd).toContain("'/mirror'");
      expect(cloneCmd).toContain('core.hooksPath=/dev/null');

      const detachCmd = (transport.exec as any).mock.calls[1][0] as string;
      expect(detachCmd).toContain("git -C '/repo'");
      expect(detachCmd).toContain('checkout --detach');
      expect(detachCmd).toContain('core.hooksPath=/dev/null');
    });

    it('throws on clone failure', async () => {
      const transport = mockTransport({ 'git -c core.hooksPath=/dev/null clone': { stdout: '', stderr: 'fatal: not a bundle', code: 128 } });
      await expect(ops.cloneWorkingDirFromMirror(transport, '/mirror', '/repo', 'main'))
        .rejects.toThrow('git clone from mirror failed');
    });

    it('throws when the post-clone detach fails', async () => {
      const transport = mockTransport({
        'git -c core.hooksPath=/dev/null clone': { stdout: '', stderr: '', code: 0 },
        'checkout --detach': { stdout: '', stderr: 'fatal: could not detach', code: 128 },
      });
      await expect(ops.cloneWorkingDirFromMirror(transport, '/mirror', '/repo', 'main'))
        .rejects.toThrow('git checkout --detach after clone failed');
    });
  });

  describe('fetchWorkingDirFromMirror', () => {
    it('detaches HEAD idempotently, then fetches the mirror path directly (not via origin) updating both the local branch and the remote-tracking ref with forced refspecs', async () => {
      const transport = mockTransport({
        'checkout --detach': { stdout: '', stderr: '', code: 0 },
        'fetch --atomic': { stdout: '', stderr: '', code: 0 },
      });
      await ops.fetchWorkingDirFromMirror(transport, '/mirror', '/repo', 'main');

      const detachCmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(detachCmd).toContain("git -C '/repo'");
      expect(detachCmd).toContain('checkout --detach');

      const fetchCmd = (transport.exec as any).mock.calls[1][0] as string;
      expect(fetchCmd).toContain('--atomic');
      expect(fetchCmd).toContain("'/mirror'");
      expect(fetchCmd).toContain("'+refs/heads/main:refs/heads/main'");
      expect(fetchCmd).toContain("'+refs/heads/main:refs/remotes/origin/main'");
    });

    it('throws when the pre-fetch detach fails', async () => {
      const transport = mockTransport({
        'checkout --detach': { stdout: '', stderr: 'fatal: could not detach', code: 128 },
      });
      await expect(ops.fetchWorkingDirFromMirror(transport, '/mirror', '/repo', 'main'))
        .rejects.toThrow('git checkout --detach before fetch failed');
    });

    it('throws on fetch failure', async () => {
      const transport = mockTransport({
        'checkout --detach': { stdout: '', stderr: '', code: 0 },
        'fetch --atomic': { stdout: '', stderr: 'fatal: rejected', code: 1 },
      });
      await expect(ops.fetchWorkingDirFromMirror(transport, '/mirror', '/repo', 'main'))
        .rejects.toThrow('git fetch from mirror failed');
    });
  });
});
