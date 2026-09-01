import { execFile, execFileSync } from 'child_process';

/**
 * The hub's own `gh` / `glab` CLI credentials — the second stage of the
 * two-stage token resolution documented in `docs/ja/github-integration.md`
 * (1. the repository's stored PAT, 2. the hub operator's CLI token).
 *
 * Single source of truth for BOTH the provider API clients (`GitHubClient` /
 * `GitLabClient`, which resolve a token synchronously and must keep their
 * synchronous public contract) and hub代行 code distribution
 * (`DistributionHelper`, which resolves it asynchronously — see
 * {@link getCliToken} for why the distinction matters).
 *
 * IMPORTANT — this credential is a property of the HUB OPERATOR'S
 * ENVIRONMENT, not of any stored configuration: `gh auth logout` on the hub
 * machine silently removes it, and nothing in AZITO's database changes. That
 * is exactly why callers surface WHICH source a resolved credential came
 * from (`credentialSource: 'cli'` on GET /api/projects/:id/servers) instead
 * of treating the two interchangeably: an operator must be able to see that
 * a project server is only distributable because of an ambient CLI login.
 */

/** A provider + host pair to ask the corresponding CLI about. */
export interface CliTokenTarget {
  provider: 'github' | 'gitlab';
  /** Web host (e.g. `github.com`, a GHE/self-managed GitLab host) — never an API host. */
  host: string;
}

/**
 * A synchronous, already-resolved view of {@link getCliToken}'s results,
 * produced by {@link resolveCliTokens}. Exists so a hot, purely synchronous
 * code path can consult CLI credentials without ever spawning a process
 * itself (see `checkDistributionPrerequisites`).
 */
export type CliTokenLookup = (target: CliTokenTarget) => string | null;

/** A lookup that knows about no CLI credentials at all. */
export const NO_CLI_TOKEN: CliTokenLookup = () => null;

interface CliTokenCacheEntry {
  token: string | null;
  expiresAt: number;
}

/**
 * Mirrors `GitHubClient`/`GitLabClient`'s own `CACHE_TTL` (5 minutes). The
 * per-instance caches these clients used before this module existed had NO
 * expiry at all, so a `gh auth logout` (or a fresh `gh auth login` after a
 * failed lookup) stayed invisible for the lifetime of the process. A TTL is
 * required precisely because this credential lives outside AZITO's control.
 */
const CLI_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Shared by the sync and async resolvers — one process-wide cache, one TTL. */
const cache = new Map<string, CliTokenCacheEntry>();
/** De-duplicates concurrent async lookups for the same target (one CLI process, not N). */
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(target: CliTokenTarget): string {
  return `${target.provider}\u0000${target.host}`;
}

/**
 * argv for the CLI that prints the token for `host`. The host comes from a
 * repository URL and must NEVER reach a shell: it is passed as a single argv
 * element to `execFile`/`execFileSync`, never interpolated into a command
 * string.
 */
function tokenCommand(target: CliTokenTarget): { command: string; args: string[] } {
  if (target.provider === 'gitlab') {
    return { command: 'glab', args: ['config', 'get', 'token', '-h', target.host] };
  }
  // GitHub Enterprise Server stores its token under its own host; github.com
  // is the CLI's default and takes no --hostname.
  return target.host === 'github.com'
    ? { command: 'gh', args: ['auth', 'token'] }
    : { command: 'gh', args: ['auth', 'token', '--hostname', target.host] };
}

const TIMEOUT_MS = 5000;

function readCache(key: string): CliTokenCacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key: string, token: string | null): string | null {
  cache.set(key, { token, expiresAt: Date.now() + CLI_TOKEN_TTL_MS });
  return token;
}

/**
 * Synchronous resolution — for `GitHubClient`/`GitLabClient`, whose public
 * contract is synchronous.
 *
 * MUST NOT be called from a request path that serves many rows or runs on a
 * frequently-polled endpoint: it blocks the event loop for up to
 * {@link TIMEOUT_MS} per uncached target. Use {@link getCliToken} /
 * {@link resolveCliTokens} there.
 *
 * A missing CLI, an unauthenticated CLI, and a timeout are all "no
 * credential" — reported as `null`, never thrown.
 */
export function getCliTokenSync(target: CliTokenTarget): string | null {
  const key = cacheKey(target);
  const cached = readCache(key);
  if (cached) return cached.token;

  const { command, args } = tokenCommand(target);
  try {
    const token = execFileSync(command, args, { encoding: 'utf-8', timeout: TIMEOUT_MS }).trim();
    return writeCache(key, token || null);
  } catch {
    return writeCache(key, null);
  }
}

/**
 * Asynchronous resolution — shares {@link getCliTokenSync}'s cache and TTL,
 * so whichever resolver runs first serves the other.
 *
 * Every caller that runs inside a Fastify request handler must use this one:
 * spawning `gh` synchronously from e.g. GET /api/projects/:id/servers would
 * stall the whole hub for the CLI's timeout on every poll.
 */
export async function getCliToken(target: CliTokenTarget): Promise<string | null> {
  const key = cacheKey(target);
  const cached = readCache(key);
  if (cached) return cached.token;

  const pending = inflight.get(key);
  if (pending) return pending;

  const { command, args } = tokenCommand(target);
  const promise = new Promise<string | null>((resolve) => {
    execFile(command, args, { encoding: 'utf-8', timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(writeCache(key, null));
        return;
      }
      resolve(writeCache(key, String(stdout).trim() || null));
    });
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * Resolves every target asynchronously (in parallel, de-duplicated) and
 * returns a synchronous {@link CliTokenLookup} over the results — the bridge
 * that lets a pure, synchronous decision function consult CLI credentials
 * without spawning anything itself.
 *
 * Targets the caller did not pass resolve to `null`: this lookup answers
 * only what it was asked to resolve, and never falls back to spawning a CLI
 * on demand.
 */
export async function resolveCliTokens(targets: Iterable<CliTokenTarget>): Promise<CliTokenLookup> {
  const unique = new Map<string, CliTokenTarget>();
  for (const target of targets) unique.set(cacheKey(target), target);

  const resolved = new Map<string, string | null>();
  await Promise.all(
    [...unique].map(async ([key, target]) => {
      resolved.set(key, await getCliToken(target));
    }),
  );
  return (target) => resolved.get(cacheKey(target)) ?? null;
}

/** Test-only: drops the shared cache so one test's CLI stub cannot leak into the next. */
export function clearCliTokenCache(): void {
  cache.clear();
  inflight.clear();
}
