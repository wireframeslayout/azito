import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { shellQuote } from '../../shared/shellQuote';
import { FileBrowseError } from './FileBrowseService';
import { parseRipgrepJson } from './parseRipgrepJson';
import { buildCommandSpec, CommandOutputLimitError, CommandSpawnError, CommandTimeoutError, type CommandResult } from '../../shared/exec/commandSpec';

const MAX_RESULTS = 200;
const SEARCH_TIMEOUT_MS = 10_000;
const RG_CHECK_TTL_MS = 5 * 60 * 1000;
const RG_CHECK_TIMEOUT_MS = 3000;
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

export interface SearchResult {
  nameMatches: string[];
  contentHits: SearchHit[];
  engine: 'rg' | 'grep';
  truncated: boolean;
  elapsedMs: number;
}

export class FileSearchService {
  private rgCache = new Map<string, { available: boolean; checkedAt: number }>();

  constructor(private readonly transportFactory: TransportFactory) {}

  async search(server: ServerConfig, opts: SearchOptions): Promise<SearchResult> {
    const start = Date.now();
    const hasRg = await this.checkRgAvailable(server);
    const engine: 'rg' | 'grep' = hasRg ? 'rg' : 'grep';

    const [nameMatches, content] = await Promise.all([
      this.searchByName(server, opts),
      this.searchContent(server, opts, engine),
    ]);
    const contentHits = content.hits;

    const totalCount = nameMatches.length + contentHits.length;
    const truncated = totalCount >= MAX_RESULTS || content.truncated;

    return {
      nameMatches: nameMatches.slice(0, MAX_RESULTS),
      contentHits: contentHits.slice(0, MAX_RESULTS),
      engine,
      truncated,
      elapsedMs: Date.now() - start,
    };
  }

  private async checkRgAvailable(server: ServerConfig): Promise<boolean> {
    const cached = this.rgCache.get(server.name);
    if (cached && Date.now() - cached.checkedAt < RG_CHECK_TTL_MS) {
      return cached.available;
    }
    const transport = this.transportFactory.getTransport(server);
    try {
      const result = await transport.run(buildCommandSpec('rg', ['--version'], { timeoutMs: RG_CHECK_TIMEOUT_MS }));
      // rg is there but does not run: that is a problem to report, not a reason to search with something else.
      if (result.exitCode !== 0) throw new Error(`rg --version exited with ${result.exitCode}: ${result.stderr.trim()}`);
      this.rgCache.set(server.name, { available: true, checkedAt: Date.now() });
      return true;
    } catch (err) {
      // grep stands in only when rg is not installed (remembered). A timeout, an unreachable host or an rg that cannot run
      // is an error of this search: failing is better than quietly searching differently.
      if (err instanceof CommandSpawnError && err.code === 'ENOENT') {
        this.rgCache.set(server.name, { available: false, checkedAt: Date.now() });
        return false;
      }
      if (isTimeoutError(err)) throw new FileBrowseError('Search timed out', 504);
      throw err;
    }
  }

  private async searchByName(server: ServerConfig, opts: SearchOptions): Promise<string[]> {
    const cmd = this.buildFindCommand(opts);
    const transport = this.transportFactory.getTransport(server);
    try {
      const result = await transport.exec(cmd, SEARCH_TIMEOUT_MS);
      if (!result.stdout.trim()) return [];
      const root = opts.root.endsWith('/') ? opts.root : opts.root + '/';
      return result.stdout.trim().split('\n')
        .filter(Boolean)
        .map(p => p.startsWith(root) ? p.slice(root.length) : p)
        .slice(0, MAX_RESULTS);
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        throw new FileBrowseError('Search timed out', 504);
      }
      return [];
    }
  }

  private async searchContent(server: ServerConfig, opts: SearchOptions, engine: 'rg' | 'grep'): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const spec = engine === 'rg'
      ? buildCommandSpec('rg', this.buildRgArgs(opts), { timeoutMs: SEARCH_TIMEOUT_MS, maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES })
      : buildCommandSpec('grep', this.buildGrepArgs(opts), { timeoutMs: SEARCH_TIMEOUT_MS, maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES });

    const transport = this.transportFactory.getTransport(server);
    try {
      // rg and grep exit 1 for "no match" and 2 for an error that may still have produced hits: the output decides.
      const { stdout, cut, timedOut } = await this.readSearchOutput(transport.run(spec));
      const hits = stdout.trim() ? this.parseHits(stdout, opts, engine) : [];
      // A deadline is a partial success only when the whole lines read hold a usable hit (rg's `begin` records alone are not one).
      if (timedOut && hits.length === 0) throw new FileBrowseError('Search timed out', 504);
      return { hits, truncated: cut };
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        throw new FileBrowseError('Search timed out', 504);
      }
      // The output cap hit before even one whole line: nothing usable, but the search was cut.
      return { hits: [], truncated: err instanceof CommandOutputLimitError };
    }
  }

  buildFindCommand(opts: SearchOptions): string {
    const sq = shellQuote;
    const root = sq(opts.root);

    const excludedDirs = [...EXCLUDED_DIRS, ...this.splitGlobPatterns(opts.excludeExtra)];
    const pruneExprs = excludedDirs
      .map(d => `-name ${sq(d)}`)
      .join(' -o ');

    const includePatterns = this.splitGlobPatterns(opts.include);
    const includeExpr = includePatterns.length
      ? ` \\( ${includePatterns.map(p => p.includes('/') ? `-path ${sq('*/' + p)}` : `-name ${sq(p)}`).join(' -o ')} \\)`
      : '';

    const nameFlag = opts.regex
      ? (opts.caseSensitive ? '-regex' : '-iregex')
      : (opts.caseSensitive ? '-name' : '-iname');

    const pattern = opts.regex ? opts.query : `*${opts.query}*`;

    return `LC_ALL=C command find ${root} \\( ${pruneExprs} \\) -prune -o -type f${includeExpr} ${nameFlag} ${sq(pattern)} -print | head -${MAX_RESULTS}`;
  }

  private parseHits(stdout: string, opts: SearchOptions, engine: 'rg' | 'grep'): SearchHit[] {
    const root = opts.root.endsWith('/') ? opts.root : opts.root + '/';
    if (engine === 'rg') {
      return parseRipgrepJson(stdout).slice(0, MAX_RESULTS).map(m => ({
        path: m.path.startsWith(root) ? m.path.slice(root.length) : m.path,
        line: m.line,
        column: m.column,
        text: m.text,
        matchStart: m.matchStart,
        matchEnd: m.matchEnd,
      }));
    }
    return this.parseGrepOutput(stdout, root, opts).slice(0, MAX_RESULTS);
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

  private parseGrepOutput(output: string, root: string, opts: SearchOptions): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      // grep -H output: path:line:text
      // Find the first colon after the root path
      const firstColon = line.indexOf(':');
      if (firstColon === -1) continue;
      const secondColon = line.indexOf(':', firstColon + 1);
      if (secondColon === -1) continue;

      const filePath = line.slice(0, firstColon);
      const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
      if (isNaN(lineNum)) continue;
      const text = line.slice(secondColon + 1);

      const relativePath = filePath.startsWith(root) ? filePath.slice(root.length) : filePath;

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
