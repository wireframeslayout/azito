import type { HostPlatform } from '../../shared/os/hostEnv';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { FileBrowseError } from './FileBrowseService';
import { parseRipgrepJson } from './parseRipgrepJson';
import { NOTHING_TO_SEARCH, searchFileNames, type NameSearchResult } from './nameSearch';
import { FileOpsError } from '../../shared/fs/fileOps';
import { pathApiFor, type HostPathApi } from '../../shared/os/hostPath';
import { isShellFileOps } from '../servers/transport/ShellFileOps';
import { AgentFileOpOutdatedError } from '../servers/transport/agentFileOpsProtocol';
import { buildCommandSpec, CommandOutputLimitError, CommandSpawnError, CommandTimeoutError, type CommandResult } from '../../shared/exec/commandSpec';

const MAX_RESULTS = 200;
const SEARCH_TIMEOUT_MS = 10_000;
const COMMAND_CHECK_TTL_MS = 5 * 60 * 1000;
const COMMAND_CHECK_TIMEOUT_MS = 3000;
/**
 * rg / grep are stopped here: room for the 200 hits that are used, with long lines. A search that matches more is cut
 * (the old `| head -200` ended it early the same way), and the hits read so far are used and reported as `truncated`.
 */
const SEARCH_MAX_OUTPUT_BYTES = 1024 * 1024;
const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', '.worktrees'];

function isTimeoutError(err: unknown): boolean {
  if (err instanceof CommandTimeoutError) return true;
  if (!(err instanceof Error)) return false;
  return (err as Error & { killed?: boolean }).killed === true || err.message.includes('timed out');
}

const GREP_LINE = /^(.+?):(\d+):(.*)$/s;

/** A path rg / grep printed for a hit, relative to the searched root and with `/` on every OS; a path outside the root stays as it is. */
function relativeHitPath(api: HostPathApi, root: string, hit: string): string {
  const relative = api.relative(root, hit);
  if (relative === '' || relative === '..' || relative.startsWith('..' + api.sep) || api.isAbsolute(relative)) return hit;
  return api.sep === '/' ? relative : relative.split(api.sep).join('/');
}

export interface SearchOptions {
  query: string;
  root: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include?: string;
  excludeExtra?: string;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
  matchStart: number;
  matchEnd: number;
}

/**
 * What searched the file contents: `rg`, else `grep` on a Unix host, else AZITO's own search on the host (`IFileOps.searchContent`),
 * which is the only one a Windows host without ripgrep has. Hit paths are relative to the root with `/` whichever it was.
 */
export type SearchEngine = 'rg' | 'grep' | 'builtin';

export interface SearchResult {
  nameMatches: string[];
  contentHits: SearchHit[];
  engine: SearchEngine;
  truncated: boolean;
  elapsedMs: number;
}

export class FileSearchService {
  private commandCache = new Map<string, { available: boolean; checkedAt: number }>();

  constructor(private readonly transportFactory: TransportFactory) {}

  async search(server: ServerConfig, opts: SearchOptions): Promise<SearchResult> {
    const start = Date.now();
    const engine = await this.pickEngine(server);

    const [names, content] = await Promise.all([
      this.searchByName(server, opts),
      this.searchContent(server, opts, engine),
    ]);
    const nameMatches = names.paths;
    const contentHits = content.hits;

    const totalCount = nameMatches.length + contentHits.length;
    const truncated = totalCount >= MAX_RESULTS || content.truncated || names.truncated;

    return {
      nameMatches: nameMatches.slice(0, MAX_RESULTS),
      contentHits: contentHits.slice(0, MAX_RESULTS),
      engine,
      truncated,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * rg when the host has it. Without it, grep on a Unix host (Windows has none), and where there is no grep either, or on Windows,
   * AZITO's own search on the host. A host reached with shell commands only (an agent registered before its OS was recorded) has no
   * such search, so there the answer is a refusal that says what to install, not an empty result.
   */
  private async pickEngine(server: ServerConfig): Promise<SearchEngine> {
    if (await this.isCommandInstalled(server, 'rg')) return 'rg';
    if (this.platformOf(server) !== 'win32' && await this.isCommandInstalled(server, 'grep')) return 'grep';
    if (isShellFileOps(this.transportFactory.getTransport(server).files())) {
      throw new FileBrowseError('Neither ripgrep (rg) nor grep is installed on this host; install one of them to search file contents', 501);
    }
    return 'builtin';
  }

  private platformOf(server: ServerConfig): HostPlatform {
    return this.transportFactory.hostProfileFor(server)?.platform ?? 'linux';
  }

  /**
   * Whether the program is installed on the server's host (remembered for a while). Only a program that is not there is "not
   * installed"; one that is there but does not run (rg exits non-zero for `--version`), a timeout or an unreachable host is an error
   * of this search: failing is better than quietly searching differently.
   */
  private async isCommandInstalled(server: ServerConfig, program: 'rg' | 'grep'): Promise<boolean> {
    const key = `${server.name}:${program}`;
    const cached = this.commandCache.get(key);
    if (cached && Date.now() - cached.checkedAt < COMMAND_CHECK_TTL_MS) {
      return cached.available;
    }
    const transport = this.transportFactory.getTransport(server);
    try {
      const result = await transport.run(buildCommandSpec(program, ['--version'], { timeoutMs: COMMAND_CHECK_TIMEOUT_MS }));
      // grep's `--version` is not the same on every grep (BusyBox's fails), so only rg is held to its exit code.
      if (program === 'rg' && result.exitCode !== 0) throw new Error(`rg --version exited with ${result.exitCode}: ${result.stderr.trim()}`);
      this.commandCache.set(key, { available: true, checkedAt: Date.now() });
      return true;
    } catch (err) {
      if (err instanceof CommandSpawnError && err.code === 'ENOENT') {
        this.commandCache.set(key, { available: false, checkedAt: Date.now() });
        return false;
      }
      if (isTimeoutError(err)) throw new FileBrowseError('Search timed out', 504);
      throw err;
    }
  }

  /**
   * File names are found by one walk on the host (`IFileOps.walk`) and matched here (see `searchFileNames`). A tree that could not
   * be seen whole in the time allowed is reported as `truncated`, and what was found is still returned.
   */
  private async searchByName(server: ServerConfig, opts: SearchOptions): Promise<NameSearchResult> {
    return searchFileNames(this.transportFactory.getTransport(server).files(), {
      root: opts.root,
      query: opts.query,
      caseSensitive: opts.caseSensitive,
      regex: opts.regex,
      include: this.splitGlobPatterns(opts.include),
      excludeNames: [...EXCLUDED_DIRS, ...this.splitGlobPatterns(opts.excludeExtra)],
    }, { maxResults: MAX_RESULTS, budgetMs: SEARCH_TIMEOUT_MS });
  }

  private async searchContent(server: ServerConfig, opts: SearchOptions, engine: SearchEngine): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    if (engine === 'builtin') return this.searchContentOnHost(server, opts);
    const spec = engine === 'rg'
      ? buildCommandSpec('rg', this.buildRgArgs(opts), { timeoutMs: SEARCH_TIMEOUT_MS, maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES })
      : buildCommandSpec('grep', this.buildGrepArgs(opts), { timeoutMs: SEARCH_TIMEOUT_MS, maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES });

    const transport = this.transportFactory.getTransport(server);
    try {
      // rg and grep exit 1 for "no match" and 2 for an error that may still have produced hits: the output decides.
      const { stdout, cut, timedOut } = await this.readSearchOutput(transport.run(spec));
      const hits = stdout.trim() ? this.parseHits(stdout, opts, engine, pathApiFor(this.platformOf(server))) : [];
      // A deadline is a partial success only when the whole lines read hold a usable hit (rg's `begin` records alone are not one).
      if (timedOut && hits.length === 0) throw new FileBrowseError('Search timed out', 504);
      return { hits, truncated: cut };
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        throw new FileBrowseError('Search timed out', 504);
      }
      // The output cap hit before even one whole line: nothing usable, but the search was cut. Anything else is an error of the search.
      if (err instanceof CommandOutputLimitError) return { hits: [], truncated: true };
      throw err;
    }
  }

  /** The host searches its own files (`IFileOps.searchContent`); a root it has nothing to search in has no hits. */
  private async searchContentOnHost(server: ServerConfig, opts: SearchOptions): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    try {
      const result = await this.transportFactory.getTransport(server).files().searchContent(opts.root, {
        query: opts.query,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        regex: opts.regex,
        include: this.splitGlobPatterns(opts.include),
        excludeNames: [...EXCLUDED_DIRS, ...this.splitGlobPatterns(opts.excludeExtra)],
        maxHits: MAX_RESULTS,
        timeBudgetMs: SEARCH_TIMEOUT_MS,
      });
      return { hits: result.hits, truncated: result.truncated };
    } catch (err: unknown) {
      if (err instanceof FileOpsError && NOTHING_TO_SEARCH.has(err.code)) return { hits: [], truncated: false };
      if (err instanceof AgentFileOpOutdatedError) throw new FileBrowseError(err.message, 501);
      throw err;
    }
  }

  private parseHits(stdout: string, opts: SearchOptions, engine: 'rg' | 'grep', api: HostPathApi): SearchHit[] {
    if (engine === 'rg') {
      return parseRipgrepJson(stdout).slice(0, MAX_RESULTS).map(m => ({
        path: relativeHitPath(api, opts.root, m.path),
        line: m.line,
        column: m.column,
        text: m.text,
        matchStart: m.matchStart,
        matchEnd: m.matchEnd,
      }));
    }
    return this.parseGrepOutput(stdout, opts, api).slice(0, MAX_RESULTS);
  }

  /**
   * The stdout of a search. One the output cap cut, or the deadline ended, is returned as the whole lines read so far with
   * `cut` set (the caller reports `truncated`) and `timedOut` for a deadline; with not even one whole line the error stands.
   */
  private async readSearchOutput(running: Promise<CommandResult>): Promise<{ stdout: string; cut: boolean; timedOut: boolean }> {
    try {
      return { stdout: (await running).stdout, cut: false, timedOut: false };
    } catch (err) {
      const partial = err instanceof CommandOutputLimitError || err instanceof CommandTimeoutError ? err : null;
      if (partial && partial.stdout.includes('\n')) {
        return { stdout: partial.stdout.slice(0, partial.stdout.lastIndexOf('\n') + 1), cut: true, timedOut: err instanceof CommandTimeoutError };
      }
      throw err;
    }
  }

  buildRgArgs(opts: SearchOptions): string[] {
    const flags: string[] = ['--json', '--line-number', '--color', 'never', '--max-count', '5'];

    if (!opts.regex) flags.push('-F');
    if (!opts.caseSensitive) flags.push('-i');
    if (opts.wholeWord) flags.push('-w');

    for (const dir of EXCLUDED_DIRS) {
      flags.push('-g', '!' + dir);
    }

    for (const pattern of this.splitGlobPatterns(opts.include)) {
      flags.push('-g', pattern);
    }

    for (const pattern of this.splitGlobPatterns(opts.excludeExtra)) {
      flags.push('-g', '!' + pattern);
    }

    return [...flags, '--', opts.query, opts.root];
  }

  buildGrepArgs(opts: SearchOptions): string[] {
    const flags: string[] = ['-rn', '-H', '--binary-files=without-match'];

    if (!opts.regex) flags.push('-F');
    if (!opts.caseSensitive) flags.push('-i');
    if (opts.wholeWord) flags.push('-w');

    for (const dir of EXCLUDED_DIRS) {
      flags.push(`--exclude-dir=${dir}`);
    }

    for (const pattern of this.splitGlobPatterns(opts.include)) {
      flags.push(`--include=${pattern}`);
    }

    for (const pattern of this.splitGlobPatterns(opts.excludeExtra)) {
      flags.push(`--exclude=${pattern}`, `--exclude-dir=${pattern}`);
    }

    return [...flags, '--', opts.query, opts.root];
  }

  private splitGlobPatterns(patterns: string | undefined): string[] {
    return patterns?.split(',').map(pattern => pattern.trim()).filter(Boolean) ?? [];
  }

  private parseGrepOutput(output: string, opts: SearchOptions, api: HostPathApi): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const rawLine of output.split('\n')) {
      // grep -H prints `path:line:text`. The path ends at the first `:<digits>:`, so a `:` inside it (`C:\work`) does not cut it.
      const parsed = GREP_LINE.exec(rawLine);
      if (!parsed) continue;
      const lineNum = parseInt(parsed[2], 10);
      const text = parsed[3].replace(/\r$/, '');
      const relativePath = relativeHitPath(api, opts.root, parsed[1]);

      let matchStart = 0;
      let matchEnd = 0;
      const wordBoundary = opts.wholeWord ? '\\b' : '';
      if (opts.regex) {
        try {
          const re = new RegExp(wordBoundary + opts.query + wordBoundary, opts.caseSensitive ? '' : 'i');
          const m = re.exec(text);
          if (m) { matchStart = m.index; matchEnd = m.index + m[0].length; }
        } catch { /* invalid regex */ }
      } else {
        try {
          const escaped = opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(wordBoundary + escaped + wordBoundary, opts.caseSensitive ? '' : 'i');
          const m = re.exec(text);
          if (m) { matchStart = m.index; matchEnd = m.index + m[0].length; }
        } catch {
          const searchText = opts.caseSensitive ? text : text.toLowerCase();
          const searchQuery = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
          const idx = searchText.indexOf(searchQuery);
          if (idx !== -1) { matchStart = idx; matchEnd = idx + opts.query.length; }
        }
      }

      hits.push({
        path: relativePath,
        line: lineNum,
        column: matchStart + 1,
        text,
        matchStart,
        matchEnd,
      });
    }
    return hits;
  }
}
