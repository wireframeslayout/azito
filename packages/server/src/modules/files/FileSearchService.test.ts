import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileSearchService } from './FileSearchService';

function createMockTransportFactory(execResults: Record<string, { stdout: string; stderr: string; code: number }> = {}) {
  const execFn = vi.fn(async (cmd: string) => {
    for (const [key, result] of Object.entries(execResults)) {
      if (cmd.includes(key)) return result;
    }
    return { stdout: '', stderr: '', code: 1 };
  });

  return {
    factory: {
      getTransport: () => ({
        exec: execFn,
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      }),
    } as any,
    execFn,
  };
}

const baseServer = {
  name: 'test-server', type: 'local' as const, host: '', agentPort: 0, agentToken: '',
  muxRuntime: 'tmux' as const, agentVersion: null, sshHost: null, sshHostFingerprint: null, createdAt: '',
} as any;

describe('FileSearchService', () => {
  describe('buildFindCommand', () => {
    it('builds case-insensitive glob command by default', () => {
      const { factory } = createMockTransportFactory();
      const service = new FileSearchService(factory);

      const cmd = service.buildFindCommand({
        query: 'test',
        root: '/home/user/project',
        matchName: true,
        matchContent: false,
        caseSensitive: false,
        regex: false,
      });

      expect(cmd).toContain('-iname');
      expect(cmd).toContain("'*test*'");
      expect(cmd).toContain("'*/node_modules/*'");
      expect(cmd).toContain("'*/.git/*'");
      expect(cmd).toContain("'*/dist/*'");
      expect(cmd).toContain("'*/.worktrees/*'");
      expect(cmd).toContain('head -200');
    });

    it('uses -name for case-sensitive search', () => {
      const { factory } = createMockTransportFactory();
      const service = new FileSearchService(factory);

      const cmd = service.buildFindCommand({
        query: 'Test',
        root: '/project',
        matchName: true,
        matchContent: false,
        caseSensitive: true,
        regex: false,
      });

      expect(cmd).toContain('-name');
      expect(cmd).not.toContain('-iname');
    });

    it('uses -iregex for regex mode', () => {
      const { factory } = createMockTransportFactory();
      const service = new FileSearchService(factory);

      const cmd = service.buildFindCommand({
        query: '.*\\.test\\.ts$',
        root: '/project',
        matchName: true,
        matchContent: false,
        caseSensitive: false,
        regex: true,
      });

      expect(cmd).toContain('-iregex');
    });
  });

  describe('buildRgCommand', () => {
    it('includes -F for literal search', () => {
      const { factory } = createMockTransportFactory();
      const service = new FileSearchService(factory);

      const cmd = service.buildRgCommand({
        query: 'hello world',
        root: '/project',
        matchName: false,
        matchContent: true,
        caseSensitive: false,
        regex: false,
      });

      expect(cmd).toContain('-F');
      expect(cmd).toContain('-i');
      expect(cmd).toContain('--json');
      expect(cmd).toContain('--max-count');
      expect(cmd).toContain("'!node_modules'");
      expect(cmd).toContain("'!.git'");
    });

    it('omits -F and -i for case-sensitive regex', () => {
      const { factory } = createMockTransportFactory();
      const service = new FileSearchService(factory);

      const cmd = service.buildRgCommand({
        query: 'foo.*bar',
        root: '/project',
        matchName: false,
        matchContent: true,
        caseSensitive: true,
        regex: true,
      });

      expect(cmd).not.toContain('-F');
      expect(cmd).not.toContain('-i');
    });

    it('quotes the query with shellQuote', () => {
      const { factory } = createMockTransportFactory();
      const service = new FileSearchService(factory);

      const cmd = service.buildRgCommand({
        query: "it's a test",
        root: '/project',
        matchName: false,
        matchContent: true,
        caseSensitive: false,
        regex: false,
      });

      expect(cmd).toContain("'it'\\''s a test'");
    });
  });

  describe('buildGrepCommand', () => {
    it('includes -F for literal search', () => {
      const { factory } = createMockTransportFactory();
      const service = new FileSearchService(factory);

      const cmd = service.buildGrepCommand({
        query: 'hello',
        root: '/project',
        matchName: false,
        matchContent: true,
        caseSensitive: false,
        regex: false,
      });

      expect(cmd).toContain('-F');
      expect(cmd).toContain('-i');
      expect(cmd).toContain('-rn');
      expect(cmd).toContain('-H');
      expect(cmd).toContain("--exclude-dir='node_modules'");
      expect(cmd).toContain('head -200');
    });
  });

  describe('search', () => {
    it('detects rg availability and caches the result', async () => {
      const { factory, execFn } = createMockTransportFactory({
        'command -v rg': { stdout: '/usr/bin/rg\n', stderr: '', code: 0 },
      });
      const service = new FileSearchService(factory);

      const result = await service.search(baseServer, {
        query: 'test',
        root: '/project',
        matchName: false,
        matchContent: true,
        caseSensitive: false,
        regex: false,
      });

      expect(result.engine).toBe('rg');

      // Second call should use cache (no new command -v rg call)
      const rgCheckCount = execFn.mock.calls.filter(c => c[0].includes('command -v rg')).length;
      await service.search(baseServer, {
        query: 'test2',
        root: '/project',
        matchName: false,
        matchContent: true,
        caseSensitive: false,
        regex: false,
      });
      const rgCheckCount2 = execFn.mock.calls.filter(c => c[0].includes('command -v rg')).length;
      expect(rgCheckCount2).toBe(rgCheckCount);
    });

    it('falls back to grep when rg is not available', async () => {
      const { factory } = createMockTransportFactory({
        'command -v rg': { stdout: '', stderr: '', code: 1 },
      });
      const service = new FileSearchService(factory);

      const result = await service.search(baseServer, {
        query: 'test',
        root: '/project',
        matchName: false,
        matchContent: true,
        caseSensitive: false,
        regex: false,
      });

      expect(result.engine).toBe('grep');
    });

    it('returns name matches from find output', async () => {
      const { factory } = createMockTransportFactory({
        'command -v rg': { stdout: '', stderr: '', code: 1 },
        'find': { stdout: '/project/src/test.ts\n/project/src/test.spec.ts\n', stderr: '', code: 0 },
      });
      const service = new FileSearchService(factory);

      const result = await service.search(baseServer, {
        query: 'test',
        root: '/project/',
        matchName: true,
        matchContent: false,
        caseSensitive: false,
        regex: false,
      });

      expect(result.nameMatches).toEqual(['src/test.ts', 'src/test.spec.ts']);
    });

    it('sets truncated when results exceed limit', async () => {
      const names = Array.from({ length: 200 }, (_, i) => `/project/file${i}.ts`).join('\n');
      const { factory } = createMockTransportFactory({
        'command -v rg': { stdout: '', stderr: '', code: 1 },
        'find': { stdout: names + '\n', stderr: '', code: 0 },
      });
      const service = new FileSearchService(factory);

      const result = await service.search(baseServer, {
        query: 'file',
        root: '/project/',
        matchName: true,
        matchContent: false,
        caseSensitive: false,
        regex: false,
      });

      expect(result.truncated).toBe(true);
      expect(result.nameMatches).toHaveLength(200);
    });
  });
});
