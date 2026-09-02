import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePushCredential } from './pushCredential';
import { getCliToken } from '../providers/cliToken';

vi.mock('../providers/cliToken', () => ({
  getCliToken: vi.fn(async () => null as string | null),
}));

const getCliTokenMock = vi.mocked(getCliToken);

const makeRepo = (overrides: Record<string, unknown> = {}) => ({
  token: null as string | null,
  url: 'https://github.com/acme/repo.git',
  provider: 'github' as const,
  owner: 'acme',
  repoName: 'repo',
  ...overrides,
});

describe('resolvePushCredential (Issue #87 two-stage push credential)', () => {
  beforeEach(() => {
    getCliTokenMock.mockReset();
    getCliTokenMock.mockResolvedValue(null);
  });

  it('uses the repository PAT and never consults the CLI when one is stored', async () => {
    const result = await resolvePushCredential(makeRepo({ token: 'ghp_stored' }));

    expect(result).toEqual({ token: 'ghp_stored', source: 'repository' });
    expect(getCliTokenMock).not.toHaveBeenCalled();
  });

  it('falls through to the hub CLI token for the repository canonical host when no PAT is stored', async () => {
    getCliTokenMock.mockResolvedValue('gh-cli-token');

    const result = await resolvePushCredential(makeRepo());

    expect(result).toEqual({ token: 'gh-cli-token', source: 'cli' });
    expect(getCliTokenMock).toHaveBeenCalledWith({ provider: 'github', host: 'github.com' });
  });

  it('asks the gitlab CLI about a self-managed host', async () => {
    getCliTokenMock.mockResolvedValue('glab-token');

    const result = await resolvePushCredential(makeRepo({
      provider: 'gitlab',
      url: 'https://gitlab.example.com/acme/repo.git',
    }));

    expect(result).toEqual({ token: 'glab-token', source: 'cli' });
    expect(getCliTokenMock).toHaveBeenCalledWith({ provider: 'gitlab', host: 'gitlab.example.com' });
  });

  it('returns null when neither a PAT nor a CLI token exists', async () => {
    const result = await resolvePushCredential(makeRepo());

    expect(result).toBeNull();
  });

  // No canonical host means there is nothing to ask the CLI about — the
  // unresolvable identity itself is still surfaced by PushNotaryService on
  // the PAT path, which is the only path that can still reach it.
  it('returns null without spawning a CLI when the repository URL does not normalize', async () => {
    const result = await resolvePushCredential(makeRepo({ url: 'not a url' }));

    expect(result).toBeNull();
    expect(getCliTokenMock).not.toHaveBeenCalled();
  });
});
