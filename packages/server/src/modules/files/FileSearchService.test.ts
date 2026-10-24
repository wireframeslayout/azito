import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { FileSearchService, type SearchOptions } from './FileSearchService';
import { CommandOutputLimitError, CommandSpawnError, CommandTimeoutError, type CommandSpec } from '../../shared/exec/commandSpec';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { ShellFileOps } from '../servers/transport/ShellFileOps';
import { AgentFileOpOutdatedError } from '../servers/transport/agentFileOpsProtocol';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { argvOfShellLine, argvOfSpec, failed, ok } from '../../shared/exec/testing/commandTesting';

type RunAnswer = ReturnType<typeof ok> | Error;
interface Answers {
  /** `rg --version` */
  rgVersion?: RunAnswer;
  /** `grep --version`; by default grep is there */
  grepVersion?: RunAnswer;
  /** the content search (rg or grep) */
  content?: RunAnswer;
  /** the host's file operations; by default a host with no files, where the name search finds nothing */
  files?: IFileOps;
  /** the host's OS as the hub recorded it; by default none (a Unix host) */
  platform?: 'linux' | 'darwin' | 'win32';
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
      if (spec.file === 'grep' && spec.args[0] === '--version') return unwrap(answer(answers.grepVersion, ok('grep (GNU grep) 3.11\n')));
      return unwrap(answer(answers.content, failed(1)));
    }),
    exec: vi.fn(async (command: string) => {
      execCommands.push(command);
      return { stdout: '', stderr: '', code: 1 };
    }),
  };
  const files = answers.files ?? ({ platform: 'linux', walk: async () => ({ entries: [], truncated: false }) } as unknown as IFileOps);
  return { factory: { getTransport: () => ({ ...transport, files: () => files }), hostProfileFor: () => (answers.platform ? { platform: answers.platform } : null) } as any, runSpecs, execCommands, transport };
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
      expect(runSpecs.filter((s) => s.file === 'rg' && s.args[0] === '--version')).toHaveLength(1);
      expect(runSpecs.filter((s) => s.file === 'grep' && s.args[0] === '--version')).toHaveLength(1);
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
      const grep = runSpecs.find((s) => s.file === 'grep' && s.args[0] !== '--version')!;
      expect(grep.maxOutputBytes).toBeLessThanOrEqual(1024 * 1024);
    });

    it('answers 504 when the content search times out', async () => {
      const { factory } = createMockTransportFactory({ rgVersion: NO_RG, content: new CommandTimeoutError(10_000, '', '') });
      await expect(new FileSearchService(factory).search(baseServer, baseOpts)).rejects.toMatchObject({ status: 504 });
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

    it('keeps the content hits and the names found, and says truncated, when the name walk ran out of time', async () => {
      const walkedPartly = { platform: 'linux', walk: async () => ({ entries: [{ path: 'src/test.ts', mtimeMs: 1 }], truncated: true }) } as unknown as IFileOps;
      const { factory } = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: ok(rgMatch('/project/a.ts', 3, 'test one') + '\n'), files: walkedPartly });

      const result = await new FileSearchService(factory).search(baseServer, baseOpts);

      expect(result.nameMatches).toEqual(['src/test.ts']);
      expect(result.contentHits.map((h) => h.path)).toEqual(['a.ts']);
      expect(result.truncated).toBe(true);
    });

    it('lets a failure of the host propagate instead of answering with no names', async () => {
      const unreachable = { platform: 'linux', walk: async () => { throw new Error('agent unreachable'); } } as unknown as IFileOps;

      await expect(serviceOver(unreachable).service.search(baseServer, baseOpts)).rejects.toThrow('agent unreachable');
    });
  });
});

describe('FileSearchService: which program searches, and how its hits are read', () => {
  const winServer = { ...baseServer, type: 'agent' as const, name: 'win' };
  const searchedOn = (hostFiles: Partial<IFileOps>) => ({ platform: 'win32', walk: async () => ({ entries: [], truncated: false }), ...hostFiles }) as unknown as IFileOps;

  it('turns the paths rg prints on Windows into paths relative to the root, with `/`', async () => {
    const { factory } = createMockTransportFactory({
      platform: 'win32',
      rgVersion: ok('ripgrep 14\n'),
      content: ok(rgMatch('C:\\proj\\src\\deep\\a.ts', 3, 'test one')),
    });
    const result = await new FileSearchService(factory).search(winServer, { ...baseOpts, root: 'C:\\proj' });
    expect(result.engine).toBe('rg');
    expect(result.contentHits.map((h) => h.path)).toEqual(['src/deep/a.ts']);
  });

  it('takes the carriage return off the line rg reports for a CRLF file', async () => {
    const { factory } = createMockTransportFactory({
      rgVersion: ok('ripgrep 14\n'),
      content: ok(JSON.stringify({ type: 'match', data: { path: { text: '/project/a.txt' }, lines: { text: 'test one\r\n' }, line_number: 1, submatches: [{ start: 0, end: 4 }] } })),
    });
    const result = await new FileSearchService(factory).search(baseServer, baseOpts);
    expect(result.contentHits[0].text).toBe('test one');
  });

  it('reads grep output whose path holds a colon, strips the carriage return, and makes the path relative', async () => {
    const { factory } = createMockTransportFactory({
      rgVersion: NO_RG,
      content: ok('/project/we:ird/a.txt:7:test crlf\r\n/project/b.txt:2:another test\n'),
    });
    const result = await new FileSearchService(factory).search(baseServer, baseOpts);
    expect(result.engine).toBe('grep');
    expect(result.contentHits.map((h) => [h.path, h.line, h.text])).toEqual([['we:ird/a.txt', 7, 'test crlf'], ['b.txt', 2, 'another test']]);
  });

  it('does not run grep on a Windows host without rg: the host searches with the built-in search', async () => {
    const searchContent = vi.fn(async () => ({ hits: [{ path: 'src/a.ts', line: 1, column: 1, text: 'test', matchStart: 0, matchEnd: 4 }], truncated: true, timedOut: false }));
    const { factory, runSpecs } = createMockTransportFactory({ platform: 'win32', rgVersion: NO_RG, files: searchedOn({ searchContent }) });
    const result = await new FileSearchService(factory).search(winServer, { ...baseOpts, root: 'C:\\proj', include: '*.ts', excludeExtra: 'vendor' });
    expect(result).toMatchObject({ engine: 'builtin', truncated: true, contentHits: [{ path: 'src/a.ts' }] });
    expect(runSpecs.some((s) => s.file === 'grep')).toBe(false);
    expect(searchContent).toHaveBeenCalledWith('C:\\proj', expect.objectContaining({
      query: 'test', caseSensitive: false, wholeWord: false, regex: false, include: ['*.ts'], exclude: ['node_modules', '.git', 'dist', '.worktrees', 'vendor'],
    }));
  });

  it('uses the built-in search on a Unix host that has neither rg nor grep', async () => {
    const searchContent = vi.fn(async () => ({ hits: [], truncated: false, timedOut: false }));
    const { factory } = createMockTransportFactory({ platform: 'linux', rgVersion: NO_RG, grepVersion: new CommandSpawnError('ENOENT', 'spawn grep ENOENT'), files: searchedOn({ platform: 'linux', searchContent }) });
    expect((await new FileSearchService(factory).search(baseServer, baseOpts)).engine).toBe('builtin');
    expect(searchContent).toHaveBeenCalledOnce();
  });

  it('refuses, saying what to install, on a host reached with shell commands only and neither program', async () => {
    const shellOps = new ShellFileOps({ exec: vi.fn() });
    const { factory } = createMockTransportFactory({ rgVersion: NO_RG, grepVersion: new CommandSpawnError('ENOENT', 'spawn grep ENOENT'), files: shellOps });
    await expect(new FileSearchService(factory).search(baseServer, baseOpts)).rejects.toMatchObject({ status: 501, message: expect.stringContaining('install') });
  });

  it('answers 501 agent_outdated when the agent has no content search operation', async () => {
    const searchContent = async (): Promise<never> => { throw new AgentFileOpOutdatedError('win', 'searchContent'); };
    const { factory } = createMockTransportFactory({ platform: 'win32', rgVersion: NO_RG, files: searchedOn({ searchContent }) });
    await expect(new FileSearchService(factory).search(winServer, baseOpts)).rejects.toMatchObject({ status: 501, message: expect.stringContaining('agent_outdated') });
  });

  it('has no content hits for a root the host cannot search, and lets any other failure propagate', async () => {
    const missing = createMockTransportFactory({ platform: 'win32', rgVersion: NO_RG, files: searchedOn({ searchContent: async () => { throw new FileOpsError('NOT_FOUND', 'gone'); } }) });
    expect((await new FileSearchService(missing.factory).search(winServer, baseOpts)).contentHits).toEqual([]);
    const broken = createMockTransportFactory({ platform: 'win32', rgVersion: NO_RG, files: searchedOn({ searchContent: async () => { throw new Error('agent unreachable'); } }) });
    await expect(new FileSearchService(broken.factory).search(winServer, baseOpts)).rejects.toThrow('agent unreachable');
  });

  it('answers 504 when the built-in search ran out of time without a hit, and keeps hits found before it', async () => {
    const timedOut = createMockTransportFactory({ platform: 'win32', rgVersion: NO_RG, files: searchedOn({ searchContent: async () => ({ hits: [], truncated: true, timedOut: true }) }) });
    await expect(new FileSearchService(timedOut.factory).search(winServer, baseOpts)).rejects.toMatchObject({ status: 504 });
    const partly = createMockTransportFactory({ platform: 'win32', rgVersion: NO_RG, files: searchedOn({ searchContent: async () => ({ hits: [{ path: 'a', line: 1, column: 1, text: 't', matchStart: 0, matchEnd: 1 }], truncated: true, timedOut: true }) }) });
    expect((await new FileSearchService(partly.factory).search(winServer, baseOpts)).truncated).toBe(true);
  });

  it('answers 400 for a regular expression the built-in search cannot read, without asking the host', async () => {
    const searchContent = vi.fn();
    const { factory } = createMockTransportFactory({ platform: 'win32', rgVersion: NO_RG, files: searchedOn({ searchContent }) });
    await expect(new FileSearchService(factory).search(winServer, { ...baseOpts, query: '(', regex: true })).rejects.toMatchObject({ status: 400 });
    expect(searchContent).not.toHaveBeenCalled();
  });

  it('returns what rg said as the reason when it ended with an error and found nothing', async () => {
    const bad = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: failed(2, 'regex parse error:\n    (\nerror: unclosed group') });
    await expect(new FileSearchService(bad.factory).search(baseServer, { ...baseOpts, query: '(', regex: true })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('regex parse error') });
    const unreadable = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: failed(2, 'rg: /project: Permission denied (os error 13)') });
    await expect(new FileSearchService(unreadable.factory).search(baseServer, baseOpts)).rejects.toMatchObject({ status: 500, message: expect.stringContaining('Permission denied') });
  });

  it('still answers "no match" (exit code 1) with no hits and no error', async () => {
    const { factory } = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: failed(1) });
    expect((await new FileSearchService(factory).search(baseServer, baseOpts)).contentHits).toEqual([]);
  });

  it('lets a failure of rg itself propagate instead of answering with no hits', async () => {
    const { factory } = createMockTransportFactory({ rgVersion: ok('ripgrep 14\n'), content: new Error('agent unreachable') });
    await expect(new FileSearchService(factory).search(baseServer, baseOpts)).rejects.toThrow('agent unreachable');
  });
});
