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

  describe('applyClone', () => {
    it('clones from bundle and sets dummy origin', async () => {
      const transport = mockTransport({
        'git clone': { stdout: '', stderr: '', code: 0 },
        'git remote set-url': { stdout: '', stderr: '', code: 0 },
      });
      await ops.applyClone(transport, '/tmp/dist.bundle', '/repo', 'main');
      expect(transport.exec).toHaveBeenCalledTimes(2);
      expect((transport.exec as any).mock.calls[1][0]).toContain(DUMMY_ORIGIN_URL);
    });

    it('throws on clone failure', async () => {
      const transport = mockTransport({ 'git clone': { stdout: '', stderr: 'fatal: not a bundle', code: 128 } });
      await expect(ops.applyClone(transport, '/tmp/dist.bundle', '/repo', 'main'))
        .rejects.toThrow('git clone from bundle failed');
    });
  });

  describe('applyFetch', () => {
    it('constructs correct refspec', async () => {
      const transport = mockTransport({ 'git fetch': { stdout: '', stderr: '', code: 0 } });
      await ops.applyFetch(transport, '/tmp/dist.bundle', '/repo', 'main');
      const cmd = (transport.exec as any).mock.calls[0][0] as string;
      expect(cmd).toContain("'main:refs/remotes/origin/main'");
    });
  });
});
