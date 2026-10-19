import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { FileSearchService, type SearchOptions } from './FileSearchService';
import { CommandOutputLimitError, CommandSpawnError, CommandTimeoutError, type CommandSpec } from '../../shared/exec/commandSpec';
import { ShellFileOps } from '../servers/transport/ShellFileOps';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import type { IFileOps } from '../../shared/fs/fileOps';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { argvOfShellLine, argvOfSpec, failed, ok } from '../../shared/exec/testing/commandTesting';

type RunAnswer = ReturnType<typeof ok> | Error;
interface Answers {
  /** `rg --version` */
  rgVersion?: RunAnswer;
  /** the content search (rg or grep) */
  content?: RunAnswer;
  /** the name search of an agent without file operations (`find`, through exec) */
  find?: { stdout: string; stderr: string; code: number } | Error;
  /** the host's file operations; by default the shell ones of an agent whose OS was never recorded */
  files?: IFileOps;
}

function createMockTransportFactory(answers: Answers = {}) {
  const runSpecs: CommandSpec[] = [];
  const execCommands: string[] = [];
  const answer = (value: RunAnswer | undefined, fallback: RunAnswer): RunAnswer => value ?? fallback;
  const unwrap = <T>(value: T | Error): T => { if (value instanceof Error) throw value; return value; };

  const transport = {
    run: vi.fn(async (spec: CommandSpec) => {
      runSpecs.push(spec);
      if (spec.file === 'rg' && spec.args[0] === '--version') return unwrap(answer(answers.rgVersion, failed(1)));
      return unwrap(answer(answers.content, failed(1)));
    }),
    exec: vi.fn(async (command: string) => {
      execCommands.push(command);
      return unwrap(answers.find ?? { stdout: '', stderr: '', code: 1 });
    }),
  };
  const files = answers.files ?? new ShellFileOps(transport);
  return { factory: { getTransport: () => ({ ...transport, files: () => files }) } as any, runSpecs, execCommands, transport };
}

/** `rg` is not installed: the one case grep stands in for it. */
const NO_RG = new CommandSpawnError('ENOENT', 'spawn rg ENOENT');

const baseServer = {
  name: 'test-server', type: 'local' as const, host: '', agentPort: 0, agentToken: '',
  muxRuntime: 'tmux' as const, agentVersion: null, sshHost: null, sshHostFingerprint: null, createdAt: '',
} as any;

const baseOpts: SearchOptions = { query: 'test', root: '/project', caseSensitive: false, wholeWord: false, regex: false };

const rgMatch = (path: string, line: number, text: string): string => JSON.stringify({
  type: 'match',
  data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line, submatches: [{ match: { text: 'test' }, start: 0, end: 4 }] },
});

describe('FileSearchService', () => {
  describe('buildFindCommand', () => {
    it('builds case-insensitive glob command by default', () => {
      const service = new FileSearchService(createMockTransportFactory().factory);
      const cmd = service.buildFindCommand({ ...baseOpts, root: '/home/user/project' });

      expect(cmd).toContain('-iname');
      expect(cmd).toContain("'*test*'");
      expect(cmd).toContain("-name 'node_modules'");
      expect(cmd).toContain("-name '.git'");
      expect(cmd).toContain("-name 'dist'");
      expect(cmd).toContain("-name '.worktrees'");
      expect(cmd).toContain('head -200');
    });

    it('uses -name for case-sensitive search', () => {
      const service = new FileSearchService(createMockTransportFactory().factory);
      const cmd = service.buildFindCommand({ ...baseOpts, query: 'Test', caseSensitive: true });
      expect(cmd).toContain('-name');
      expect(cmd).not.toContain('-iname');
    });

    it('uses -iregex for regex mode', () => {
      const service = new FileSearchService(createMockTransportFactory().factory);
      const cmd = service.buildFindCommand({ ...baseOpts, query: '.*\\.test\\.ts$', regex: true });
      expect(cmd).toContain('-iregex');
    });
  });

  describe('buildRgArgs', () => {
    const service = new FileSearchService(createMockTransportFactory().factory);

    it('includes -F for literal search', () => {
      const args = service.buildRgArgs({ ...baseOpts, query: 'hello world' });
      expect(args).toContain('-F');
      expect(args).toContain('-i');
      expect(args).toContain('--json');
      expect(args).toContain('--max-count');
      expect(args).toContain('!node_modules');
      expect(args).toContain('!.git');
    });

    it('omits -F and -i for case-sensitive regex', () => {
      const args = service.buildRgArgs({ ...baseOpts, query: 'foo.*bar', caseSensitive: true, regex: true });
      expect(args).not.toContain('-F');
      expect(args).not.toContain('-i');
    });

    it('passes the query and root as whole arguments after `--`, whatever they contain', () => {
      const args = service.buildRgArgs({ ...baseOpts, query: "it's a -test; echo pwned", root: "/pro ject" });
      expect(args.slice(-3)).toEqual(['--', "it's a -test; echo pwned", '/pro ject']);
    });

    it('includes -w for whole-word search', () => {
      expect(service.buildRgArgs({ ...baseOpts, wholeWord: true })).toContain('-w');
    });

    it('adds an include glob for each pattern', () => {
      const args = service.buildRgArgs({ ...baseOpts, include: '*.ts,*.tsx' });
      expect(args.join(' ')).toContain('-g *.ts');
      expect(args.join(' ')).toContain('-g *.tsx');
    });

    it('adds extra exclusions after default exclusions', () => {
      const args = service.buildRgArgs({ ...baseOpts, excludeExtra: 'vendor,tmp' });
      expect(args).toContain('!vendor');
      expect(args).toContain('!tmp');
      expect(args.indexOf('!.worktrees')).toBeLessThan(args.indexOf('!vendor'));
    });
  });

  describe('buildGrepArgs', () => {
    const service = new FileSearchService(createMockTransportFactory().factory);

    it('includes -F for literal search', () => {
      const args = service.buildGrepArgs({ ...baseOpts, query: 'hello' });
      expect(args).toContain('-F');
      expect(args).toContain('-i');
      expect(args).toContain('-rn');
      expect(args).toContain('-H');
      expect(args).toContain('--exclude-dir=node_modules');
    });

    it('passes the query and root as whole arguments after `--`', () => {
      const args = service.buildGrepArgs({ ...baseOpts, query: "it's; rm -rf /" });
      expect(args.slice(-3)).toEqual(['--', "it's; rm -rf /", '/project']);
    });

    it('includes -w for whole-word search', () => {
      expect(service.buildGrepArgs({ ...baseOpts, wholeWord: true })).toContain('-w');
    });

    it('adds include globs', () => {
      expect(service.buildGrepArgs({ ...baseOpts, include: '*.ts' })).toContain('--include=*.ts');
    });

    it('adds extra file and directory exclusions', () => {
      const args = service.buildGrepArgs({ ...baseOpts, excludeExtra: 'vendor' });
      expect(args).toContain('--exclude=vendor');
      expect(args).toContain('--exclude-dir=vendor');
    });
  });

  // Each migrated call is pinned to what the old shell string became: the argv a real sh makes of the old command (without
  // its `| head -200`) equals `[program, ...args]`.
  describe.skipIf(process.platform === 'win32')('argv is the same as the old shell strings', () => {
    const service = new FileSearchService(createMockTransportFactory().factory);
    const opts: SearchOptions = { query: "it's -a test", root: "/pro ject", caseSensitive: false, wholeWord: true, regex: false, include: '*.ts,*.tsx', excludeExtra: 'vendor' };

    it('rg', () => {
      const old = "rg --json --line-number --color never --max-count 5 -F -i -w -g '!node_modules' -g '!.git' -g '!dist' -g '!.worktrees' -g '*.ts' -g '*.tsx' -g '!vendor' -- 'it'\\''s -a test' '/pro ject'";
      expect(['rg', ...service.buildRgArgs(opts)]).toEqual(argvOfShellLine(old));
    });

    it('grep', () => {
      const old = "grep -rn -H --binary-files=without-match -F -i -w --exclude-dir='node_modules' --exclude-dir='.git' --exclude-dir='dist' --exclude-dir='.worktrees' --include='*.ts' --include='*.tsx' --exclude='vendor' --exclude-dir='vendor' -- 'it'\\''s -a test' '/pro ject'";
      expect(['grep', ...service.buildGrepArgs(opts)]).toEqual(argvOfShellLine(old));
    });

    it('runs the engine the search chose with exactly those args', async () => {
      const grepSide = createMockTransportFactory({ rgVersion: NO_RG });
      await new FileSearchService(grepSide.factory).search(baseServer, opts);
      expect(argvOfSpec(grepSide.runSpecs.at(-1)!)).toEqual(['grep', ...service.buildGrepArgs(opts)]);

      const rgSide = createMockTransportFactory({ rgVersion: ok('ripgrep 14.1.0\n') });
      await new FileSearchService(rgSide.factory).search(baseServer, opts);
      expect(argvOfSpec(rgSide.runSpecs.at(-1)!)).toEqual(['rg', ...service.buildRgArgs(opts)]);
    });
  });

  describe('search', () => {
    it('detects rg availability with `rg --version` and caches the result', async () => {
      const { factory, runSpecs } = createMockTransportFactory({ rgVersion: ok('ripgrep 14.1.0\n') });
      const service = new FileSearchService(factory);

      const result = await service.search(baseServer, baseOpts);
      expect(result.engine).toBe('rg');
      expect(runSpecs[0]).toMatchObject({ file: 'rg', args: ['--version'], timeoutMs: 3000 });

      const checks = () => runSpecs.filter((s) => s.args[0] === '--version').length;
      const before = checks();
      await service.search(baseServer, { ...baseOpts, query: 'test2' });
      expect(checks()).toBe(before);
    });

    it('fails, instead of searching with grep, when rg is there but exits non-zero', async () => {
      const { factory, runSpecs } = createMockTransportFactory({ rgVersion: failed(2, 'rg: broken') });
      await expect(new FileSearchService(factory).search(baseServer, baseOpts)).rejects.toThrow(/rg --version exited with 2/);
      expect(runSpecs.every((s) => s.file === 'rg' && s.args[0] === '--version')).toBe(true);
    });

    it('fails when rg cannot be started for a reason other than not being installed', async () => {
      const { factory } = createMockTransportFactory({ rgVersion: new CommandSpawnError('EACCES', 'spawn rg EACCES') });
      await expect(new FileSearchService(factory).search(baseServer, baseOpts)).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('falls back to grep, and remembers it, only when rg is not installed', async () => {
      const { factory, runSpecs } = createMockTransportFactory({ rgVersion: NO_RG });
      const service = new FileSearchService(factory);
      expect((await service.search(baseServer, baseOpts)).engine).toBe('grep');
      await service.search(baseServer, baseOpts);
      expect(runSpecs.filter((s) => s.args[0] === '--version')).toHaveLength(1);
    });

    it('answers 504, not a grep result, when the rg check times out, and asks again next time', async () => {
      const { factory, runSpecs } = createMockTransportFactory({ rgVersion: new CommandTimeoutError(3000, '', '') });
      const service = new FileSearchService(factory);
      await expect(service.search(baseServer, baseOpts)).rejects.toMatchObject({ status: 504 });
      await expect(service.search(baseServer, baseOpts)).rejects.toMatchObject({ status: 504 });
      expect(runSpecs.filter((s) => s.args[0] === '--version')).toHaveLength(2);
      expect(runSpecs.some((s) => s.file === 'grep')).toBe(false);
    });

    it('returns rg content hits relative to the root', async () => {
      const { factory } = createMockTransportFactory({
        rgVersion: ok('ripgrep 14\n'),
        content: failed(2, 'rg: some/unreadable: Permission denied', rgMatch('/project/src/a.ts', 3, 'test one')),
      });
      const result = await new FileSearchService(factory).search(baseServer, baseOpts);
      expect(result.contentHits).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 3, text: expect.stringContaining('test one') })]);
    });

    it('returns no content hits when the search exits 1 with no output', async () => {
      const { factory } = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: failed(1) });
      expect((await new FileSearchService(factory).search(baseServer, baseOpts)).contentHits).toEqual([]);
    });

    it('parses grep output', async () => {
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, content: ok('/project/src/a.ts:3:a test line\n/project/b.ts:7:test\n') });
      const result = await new FileSearchService(factory).search(baseServer, baseOpts);
      expect(result.contentHits.map((h) => [h.path, h.line])).toEqual([['src/a.ts', 3], ['b.ts', 7]]);
    });

    it('uses the hits read before the output cap cut the search, without the half line, and says it was cut', async () => {
      const partial = '/project/a.ts:1:test\n/project/b.ts:2:test\n/project/c.ts:3:te';
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, content: new CommandOutputLimitError(1024 * 1024, partial, '') });
      const result = await new FileSearchService(factory).search(baseServer, baseOpts);
      expect(result.contentHits.map((h) => h.path)).toEqual(['a.ts', 'b.ts']);
      expect(result.truncated).toBe(true);
    });

    it('is not truncated when nothing was cut and there are few hits', async () => {
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, content: ok('/project/a.ts:1:test\n') });
      expect((await new FileSearchService(factory).search(baseServer, baseOpts)).truncated).toBe(false);
    });

    it('reports truncated when the output cap hit before even one whole line', async () => {
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, content: new CommandOutputLimitError(1024 * 1024, 'x'.repeat(100), '') });
      const result = await new FileSearchService(factory).search(baseServer, baseOpts);
      expect(result.contentHits).toEqual([]);
      expect(result.truncated).toBe(true);
    });

    it('returns the hits read when the deadline ended a large scan, as a truncated result, not a 504', async () => {
      const partial = '/project/a.ts:1:test\n/project/b.ts:2:te';
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, content: new CommandTimeoutError(10_000, partial, '') });
      const result = await new FileSearchService(factory).search(baseServer, baseOpts);
      expect(result.contentHits.map((h) => h.path)).toEqual(['a.ts']);
      expect(result.truncated).toBe(true);
    });

    it('answers 504 when the deadline ended an rg search that had only written `begin` records (no hit yet)', async () => {
      const beginOnly = JSON.stringify({ type: 'begin', data: { path: { text: '/project/a.ts' } } }) + '\n' + '{"type":"match","data":{"pa';
      const { factory } = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: new CommandTimeoutError(10_000, beginOnly, '') });
      await expect(new FileSearchService(factory).search(baseServer, baseOpts)).rejects.toMatchObject({ status: 504 });
    });

    it('returns a partial rg result when the deadline ended a search whose whole lines hold a hit', async () => {
      const partial = JSON.stringify({ type: 'begin', data: { path: { text: '/project/a.ts' } } }) + '\n' + rgMatch('/project/a.ts', 3, 'test one') + '\n{"type":"match","data":{"pa';
      const { factory } = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: new CommandTimeoutError(10_000, partial, '') });
      const result = await new FileSearchService(factory).search(baseServer, baseOpts);
      expect(result.contentHits.map((h) => h.path)).toEqual(['a.ts']);
      expect(result.truncated).toBe(true);
    });

    it('stops rg and grep at an output size that fits the 200 hits, not megabytes', async () => {
      const { factory, runSpecs } = createMockTransportFactory({ rgVersion: NO_RG });
      await new FileSearchService(factory).search(baseServer, baseOpts);
      const grep = runSpecs.find((s) => s.file === 'grep')!;
      expect(grep.maxOutputBytes).toBeLessThanOrEqual(1024 * 1024);
    });

    it('answers 504 when the content search times out', async () => {
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, content: new CommandTimeoutError(10_000, '', '') });
      await expect(new FileSearchService(factory).search(baseServer, baseOpts)).rejects.toMatchObject({ status: 504 });
    });

    it('returns name matches from find output (an agent without file operations)', async () => {
      const { factory, execCommands } = createMockTransportFactory({
        rgVersion: NO_RG,
        find: { stdout: '/project/src/test.ts\n/project/src/test.spec.ts\n', stderr: '', code: 0 },
      });
      const result = await new FileSearchService(factory).search(baseServer, { ...baseOpts, root: '/project/' });
      expect(result.nameMatches).toEqual(['src/test.ts', 'src/test.spec.ts']);
      expect(execCommands).toHaveLength(1);
      expect(execCommands[0]).toContain('find');
    });

    it('sets truncated when results exceed limit', async () => {
      const names = Array.from({ length: 200 }, (_, i) => `/project/file${i}.ts`).join('\n');
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, find: { stdout: names + '\n', stderr: '', code: 0 } });
      const result = await new FileSearchService(factory).search(baseServer, { ...baseOpts, query: 'file', root: '/project/' });
      expect(result.truncated).toBe(true);
      expect(result.nameMatches).toHaveLength(200);
    });
  });

  describe('name search with the host\'s file operations', () => {
    let root: string;

    beforeEach(() => {
      root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-filesearch-')));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function serviceOver(files: IFileOps): { service: FileSearchService; execCommands: string[] } {
      const { factory, execCommands } = createMockTransportFactory({ rgVersion: NO_RG, files });
      return { service: new FileSearchService(factory), execCommands };
    }

    function writeFiles(...names: string[]): void {
      for (const name of names) {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        writeFileSync(path.join(root, name), '');
      }
    }

    const local = (): LocalFileOps => new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: root }));

    it('lists names through IFileOps without running find, skipping the excluded directories', async () => {
      writeFiles('src/test.ts', 'src/test.spec.ts', 'node_modules/p/test.js', '.git/test', 'dist/test.js', 'readme.md');
      const { service, execCommands } = serviceOver(local());

      const result = await service.search(baseServer, { ...baseOpts, root });

      expect(result.nameMatches).toEqual(['src/test.spec.ts', 'src/test.ts']);
      expect(execCommands).toEqual([]);
    });

    it('applies include, exclude, case and regex as the find command did', async () => {
      writeFiles('A/Test.ts', 'A/test.js', 'B/test.ts', 'vendor/test.ts');
      const { service } = serviceOver(local());

      const names = async (o: Partial<SearchOptions>): Promise<string[]> => (await service.search(baseServer, { ...baseOpts, root, ...o })).nameMatches;

      expect(await names({ include: '*.ts', excludeExtra: 'vendor' })).toEqual(['A/Test.ts', 'B/test.ts']);
      expect(await names({ caseSensitive: true })).toEqual(['A/test.js', 'B/test.ts', 'vendor/test.ts']);
      expect(await names({ regex: true, query: '.*/B/.*' })).toEqual(['B/test.ts']);
    });

    it('is truncated at 200 names', async () => {
      writeFiles(...Array.from({ length: 205 }, (_, i) => `file${i}.ts`));
      const { service } = serviceOver(local());

      const result = await service.search(baseServer, { ...baseOpts, root, query: 'file' });

      expect(result.nameMatches).toHaveLength(200);
      expect(result.truncated).toBe(true);
    });

    it('lets a failure of the host propagate instead of answering with no names', async () => {
      const unreachable = { platform: 'linux', list: async () => { throw new Error('agent unreachable'); } } as unknown as IFileOps;

      await expect(serviceOver(unreachable).service.search(baseServer, baseOpts)).rejects.toThrow('agent unreachable');
    });
  });
});
