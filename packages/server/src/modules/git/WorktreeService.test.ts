import { describe, it, expect } from 'vitest';
import { LocalWorktreeService } from './WorktreeService';

describe('LocalWorktreeService', () => {
  const svc = new LocalWorktreeService();

  describe('list()', () => {
    it('returns empty array for non-git directory', async () => {
      const tmpDir = '/tmp';
      const result = await svc.list(tmpDir);
      expect(result).toEqual([]);
    });

    it('throws on other git errors', async () => {
      await expect(svc.list('/nonexistent/path/that/does/not/exist')).rejects.toThrow();
    });
  });

  describe('create() input validation', () => {
    it('rejects workingDir with $() injection', async () => {
      await expect(svc.create('$(id)', 1, 'slug', 'main')).rejects.toThrow('Unsafe');
    });

    it('rejects taskSlug with shell metacharacters', async () => {
      await expect(svc.create('/tmp/repo', 1, '; touch x', 'main')).rejects.toThrow('Unsafe');
    });

    it('rejects baseBranch with $() injection', async () => {
      await expect(svc.create('/tmp/repo', 1, 'slug', '$(id)')).rejects.toThrow('Unsafe');
    });

    it('rejects branchName with backticks', async () => {
      await expect(svc.create('/tmp/repo', 1, 'slug', 'main', '`id`')).rejects.toThrow('Unsafe');
    });

    // Issue #87 third-party review, 12th round, Important finding 2:
    // assertSafeBranch used to also reject any fully-qualified ref
    // (refs/...), but a pre-existing task's persisted baseBranch/branch can
    // already be one (from before the API boundary rejected new refs/...
    // input) — it must not be rejected as "Unsafe" here. `/tmp/repo` is not
    // a git repository, so this still throws, but NOT the "Unsafe"/
    // "fully-qualified ref" validation error — it must get past validation
    // and fail later, on the actual git operation.
    it('does not reject baseBranch "refs/heads/main" as Unsafe (back-compat for pre-existing persisted values)', async () => {
      try {
        await svc.create('/tmp/repo', 1, 'slug', 'refs/heads/main');
      } catch (err) {
        expect(String(err instanceof Error ? err.message : err)).not.toMatch(/Unsafe|fully-qualified/);
      }
    });

    it('does not reject branchName "refs/heads/main" as Unsafe (back-compat for pre-existing persisted task.branch values)', async () => {
      try {
        await svc.create('/tmp/repo', 1, 'slug', 'main', 'refs/heads/main');
      } catch (err) {
        expect(String(err instanceof Error ? err.message : err)).not.toMatch(/Unsafe|fully-qualified/);
      }
    });
  });

  describe('remove() input validation', () => {
    it('rejects unsafe worktreePath', async () => {
      await expect(svc.remove('/tmp/repo', '$(rm -rf /)')).rejects.toThrow('Unsafe');
    });
  });

  describe('getDiff() input validation', () => {
    it('rejects unsafe baseBranch', async () => {
      await expect(svc.getDiff('/tmp/repo', '; cat /etc/passwd')).rejects.toThrow('Unsafe');
    });
  });

  describe('getBranch() input validation', () => {
    it('rejects unsafe worktreePath', async () => {
      await expect(svc.getBranch('$(id)')).rejects.toThrow('Unsafe');
    });
  });
});
