import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { shellQuote } from '../../shared/shellQuote';
import { FileBrowseError } from './FileBrowseService';
import { parseRipgrepJson } from './parseRipgrepJson';

const MAX_RESULTS = 200;
const SEARCH_TIMEOUT_MS = 10_000;
const RG_CHECK_TTL_MS = 5 * 60 * 1000;
const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', '.worktrees'];

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as Error & { killed?: boolean }).killed === true || err.message.includes('timed out');
}

export interface SearchOptions {
  query: string;
  root: string;
  matchName: boolean;
  matchContent: boolean;
  caseSensitive: boolean;
  regex: boolean;
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

    const tasks: [Promise<string[]>, Promise<SearchHit[]>] = [
      opts.matchName ? this.searchByName(server, opts) : Promise.resolve([]),
      opts.matchContent ? this.searchContent(server, opts, engine) : Promise.resolve([]),
    ];

    const [nameMatches, contentHits] = await Promise.all(tasks);

    const totalCount = nameMatches.length + contentHits.length;
    const truncated = totalCount >= MAX_RESULTS;

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
      const result = await transport.exec('command -v rg', 3000);
      const available = result.code === 0 && result.stdout.trim().length > 0;
      this.rgCache.set(server.name, { available, checkedAt: Date.now() });
      return available;
    } catch {
      this.rgCache.set(server.name, { available: false, checkedAt: Date.now() });
      return false;
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

  private async searchContent(server: ServerConfig, opts: SearchOptions, engine: 'rg' | 'grep'): Promise<SearchHit[]> {
    const cmd = engine === 'rg'
      ? this.buildRgCommand(opts)
      : this.buildGrepCommand(opts);

    const transport = this.transportFactory.getTransport(server);
    try {
      const result = await transport.exec(cmd, SEARCH_TIMEOUT_MS);
      if (!result.stdout.trim()) return [];

      const root = opts.root.endsWith('/') ? opts.root : opts.root + '/';

      if (engine === 'rg') {
        const matches = parseRipgrepJson(result.stdout);
        return matches.slice(0, MAX_RESULTS).map(m => ({
          path: m.path.startsWith(root) ? m.path.slice(root.length) : m.path,
          line: m.line,
          column: m.column,
          text: m.text,
          matchStart: m.matchStart,
          matchEnd: m.matchEnd,
        }));
      }

      return this.parseGrepOutput(result.stdout, root, opts).slice(0, MAX_RESULTS);
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        throw new FileBrowseError('Search timed out', 504);
      }
      return [];
    }
  }

  buildFindCommand(opts: SearchOptions): string {
    const sq = shellQuote;
    const root = sq(opts.root);

    const pruneExprs = EXCLUDED_DIRS
      .map(d => `-name ${sq(d)}`)
      .join(' -o ');

    const nameFlag = opts.regex
      ? (opts.caseSensitive ? '-regex' : '-iregex')
      : (opts.caseSensitive ? '-name' : '-iname');

    const pattern = opts.regex ? opts.query : `*${opts.query}*`;

    return `LC_ALL=C command find ${root} \\( ${pruneExprs} \\) -prune -o -type f ${nameFlag} ${sq(pattern)} -print | head -${MAX_RESULTS}`;
  }

  buildRgCommand(opts: SearchOptions): string {
    const sq = shellQuote;
    const flags: string[] = ['--json', '--line-number', '--color', 'never', '--max-count', '5'];

    if (!opts.regex) flags.push('-F');
    if (!opts.caseSensitive) flags.push('-i');

    for (const dir of EXCLUDED_DIRS) {
      flags.push('-g', sq('!' + dir));
    }

    return `rg ${flags.join(' ')} -- ${sq(opts.query)} ${sq(opts.root)}`;
  }

  buildGrepCommand(opts: SearchOptions): string {
    const sq = shellQuote;
    const flags: string[] = ['-rn', '-H', '--binary-files=without-match'];

    if (!opts.regex) flags.push('-F');
    if (!opts.caseSensitive) flags.push('-i');

    for (const dir of EXCLUDED_DIRS) {
      flags.push(`--exclude-dir=${sq(dir)}`);
    }

    return `grep ${flags.join(' ')} -- ${sq(opts.query)} ${sq(opts.root)} | head -${MAX_RESULTS}`;
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
      if (opts.regex) {
        try {
          const re = new RegExp(opts.query, opts.caseSensitive ? '' : 'i');
          const m = re.exec(text);
          if (m) { matchStart = m.index; matchEnd = m.index + m[0].length; }
        } catch { /* invalid regex */ }
      } else {
        const searchText = opts.caseSensitive ? text : text.toLowerCase();
        const searchQuery = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
        const idx = searchText.indexOf(searchQuery);
        if (idx !== -1) {
          matchStart = idx;
          matchEnd = idx + opts.query.length;
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
