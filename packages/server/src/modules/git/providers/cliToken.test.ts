import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { getCliToken, getCliTokenSync, resolveCliTokens, NO_CLI_TOKEN, clearCliTokenCache } from './cliToken';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecFile = vi.mocked(execFile);

/** Drives the callback-style `execFile` the async resolver uses. */
function stubExecFile(result: { stdout?: string; error?: Error }) {
  mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string) => void) => {
    cb(result.error ?? null, result.stdout ?? '');
    return undefined as never;
  }) as unknown as typeof execFile);
}

beforeEach(() => {
  mockedExecFileSync.mockReset();
  mockedExecFile.mockReset();
  clearCliTokenCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getCliTokenSync', () => {
  it('runs `gh auth token` without --hostname for github.com', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    expect(getCliTokenSync({ provider: 'github', host: 'github.com' })).toBe('tok');
    expect(mockedExecFileSync.mock.calls[0][0]).toBe('gh');
    expect(mockedExecFileSync.mock.calls[0][1]).toEqual(['auth', 'token']);
  });

  it('adds --hostname for a GitHub Enterprise host', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    getCliTokenSync({ provider: 'github', host: 'ghe.example.com' });
    expect(mockedExecFileSync.mock.calls[0][1]).toEqual(['auth', 'token', '--hostname', 'ghe.example.com']);
  });

  it('runs `glab config get token -h <host>` for gitlab', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    getCliTokenSync({ provider: 'gitlab', host: 'gitlab.example.com' });
    expect(mockedExecFileSync.mock.calls[0][0]).toBe('glab');
    expect(mockedExecFileSync.mock.calls[0][1]).toEqual(['config', 'get', 'token', '-h', 'gitlab.example.com']);
  });

  it.each(['a$(id)b', ';id', '`id`'])('carries a shell-metacharacter host %s as a single literal argv element', (host) => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    getCliTokenSync({ provider: 'github', host });
    expect(mockedExecFileSync.mock.calls[0][1]).toContain(host);
  });

  it('returns null (never throws) when the CLI is missing, unauthenticated, or times out', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(getCliTokenSync({ provider: 'github', host: 'github.com' })).toBeNull();
  });

  it('treats empty CLI output as no credential', () => {
    mockedExecFileSync.mockReturnValue('  \n' as unknown as string);
    expect(getCliTokenSync({ provider: 'github', host: 'github.com' })).toBeNull();
  });

  it('caches per provider+host, spawning the CLI once', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    getCliTokenSync({ provider: 'github', host: 'github.com' });
    getCliTokenSync({ provider: 'github', host: 'github.com' });
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('caches a negative result too (no CLI process per lookup while unauthenticated)', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('not logged in'); });
    getCliTokenSync({ provider: 'github', host: 'github.com' });
    getCliTokenSync({ provider: 'github', host: 'github.com' });
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not share a cache entry between providers on the same host', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    getCliTokenSync({ provider: 'github', host: 'example.com' });
    getCliTokenSync({ provider: 'gitlab', host: 'example.com' });
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });
});

describe('cli token cache TTL', () => {
  it('re-runs the CLI after the TTL expires, so a `gh auth logout` becomes visible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    expect(getCliTokenSync({ provider: 'github', host: 'github.com' })).toBe('tok');

    vi.setSystemTime(new Date('2026-01-01T00:04:00Z'));
    expect(getCliTokenSync({ provider: 'github', host: 'github.com' })).toBe('tok');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);

    // Past the 5-minute TTL: the operator has since logged out.
    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    mockedExecFileSync.mockImplementation(() => { throw new Error('not logged in'); });
    expect(getCliTokenSync({ provider: 'github', host: 'github.com' })).toBeNull();
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('applies the same TTL to the async resolver', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    stubExecFile({ stdout: 'tok\n' });
    expect(await getCliToken({ provider: 'github', host: 'github.com' })).toBe('tok');

    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    stubExecFile({ stdout: 'tok2\n' });
    expect(await getCliToken({ provider: 'github', host: 'github.com' })).toBe('tok2');
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });
});

describe('getCliToken (async)', () => {
  it('resolves the token and shares its cache with the sync resolver', async () => {
    stubExecFile({ stdout: 'tok\n' });
    expect(await getCliToken({ provider: 'github', host: 'github.com' })).toBe('tok');
    expect(getCliTokenSync({ provider: 'github', host: 'github.com' })).toBe('tok');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('returns null (never rejects) when the CLI fails', async () => {
    stubExecFile({ error: new Error('ENOENT') });
    await expect(getCliToken({ provider: 'github', host: 'github.com' })).resolves.toBeNull();
  });

  it('de-duplicates concurrent lookups for the same target into one CLI process', async () => {
    let resolveCb: ((e: Error | null, stdout: string) => void) | null = null;
    mockedExecFile.mockImplementation(((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, stdout: string) => void) => {
      resolveCb = cb;
      return undefined as never;
    }) as unknown as typeof execFile);

    const both = Promise.all([
      getCliToken({ provider: 'github', host: 'github.com' }),
      getCliToken({ provider: 'github', host: 'github.com' }),
    ]);
    resolveCb!(null, 'tok\n');
    expect(await both).toEqual(['tok', 'tok']);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCliTokens', () => {
  it('answers for every resolved target and null for anything else', async () => {
    mockedExecFile.mockImplementation(((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, stdout: string) => void) => {
      cb(null, cmd === 'glab' ? 'glab-tok\n' : `gh-tok-${args[args.length - 1]}\n`);
      return undefined as never;
    }) as unknown as typeof execFile);

    const lookup = await resolveCliTokens([
      { provider: 'github', host: 'ghe.example.com' },
      { provider: 'gitlab', host: 'gitlab.example.com' },
    ]);

    expect(lookup({ provider: 'github', host: 'ghe.example.com' })).toBe('gh-tok-ghe.example.com');
    expect(lookup({ provider: 'gitlab', host: 'gitlab.example.com' })).toBe('glab-tok');
    expect(lookup({ provider: 'github', host: 'github.com' })).toBeNull();
  });

  it('de-duplicates repeated targets', async () => {
    stubExecFile({ stdout: 'tok\n' });
    await resolveCliTokens([
      { provider: 'github', host: 'github.com' },
      { provider: 'github', host: 'github.com' },
    ]);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it('spawns nothing for an empty target list', async () => {
    const lookup = await resolveCliTokens([]);
    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(lookup({ provider: 'github', host: 'github.com' })).toBeNull();
  });
});

describe('NO_CLI_TOKEN', () => {
  it('answers null for every target', () => {
    expect(NO_CLI_TOKEN({ provider: 'github', host: 'github.com' })).toBeNull();
    expect(NO_CLI_TOKEN({ provider: 'gitlab', host: 'gitlab.com' })).toBeNull();
  });
});
