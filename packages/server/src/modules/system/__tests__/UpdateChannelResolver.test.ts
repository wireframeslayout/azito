import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../../../shared/releaseInfo', () => ({
  getReleaseInfo: vi.fn(),
}));

import { getReleaseInfo } from '../../../shared/releaseInfo';
import { UpdateChannelResolver } from '../UpdateChannelResolver';

const mockedGetReleaseInfo = vi.mocked(getReleaseInfo);

describe('UpdateChannelResolver', () => {
  let tmpDir: string;
  let channelPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-channel-test-'));
    channelPath = path.join(tmpDir, 'update-channel.json');
    delete process.env.AZITO_RELEASE_REPO;
    mockedGetReleaseInfo.mockReset();
    mockedGetReleaseInfo.mockReturnValue(null);
  });

  afterEach(() => {
    delete process.env.AZITO_RELEASE_REPO;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves from AZITO_RELEASE_REPO env var (stage 1)', () => {
    process.env.AZITO_RELEASE_REPO = 'env-owner/env-repo';
    const resolver = new UpdateChannelResolver(channelPath);
    expect(resolver.resolve()).toBe('env-owner/env-repo');
  });

  it('resolves from update-channel.json when env is unset (stage 2)', () => {
    fs.writeFileSync(channelPath, JSON.stringify({ repo: 'file-owner/file-repo' }));
    const resolver = new UpdateChannelResolver(channelPath);
    expect(resolver.resolve()).toBe('file-owner/file-repo');
  });

  it('resolves from release.json channel.repo when env and file are unset (stage 3)', () => {
    mockedGetReleaseInfo.mockReturnValue({
      version: 'v1.0.0',
      commit: 'abc1234',
      bundleHash: 'deadbeefcafe',
      channel: { repo: 'release-owner/release-repo' },
    });
    const resolver = new UpdateChannelResolver(channelPath);
    expect(resolver.resolve()).toBe('release-owner/release-repo');
  });

  it('returns null when all three stages are empty', () => {
    const resolver = new UpdateChannelResolver(channelPath);
    expect(resolver.resolve()).toBeNull();
  });

  it('env var takes priority over the channel file and release.json', () => {
    process.env.AZITO_RELEASE_REPO = 'env-owner/env-repo';
    fs.writeFileSync(channelPath, JSON.stringify({ repo: 'file-owner/file-repo' }));
    mockedGetReleaseInfo.mockReturnValue({
      version: 'v1.0.0',
      commit: 'abc1234',
      bundleHash: 'deadbeefcafe',
      channel: { repo: 'release-owner/release-repo' },
    });
    const resolver = new UpdateChannelResolver(channelPath);
    expect(resolver.resolve()).toBe('env-owner/env-repo');
  });

  it('the channel file takes priority over release.json', () => {
    fs.writeFileSync(channelPath, JSON.stringify({ repo: 'file-owner/file-repo' }));
    mockedGetReleaseInfo.mockReturnValue({
      version: 'v1.0.0',
      commit: 'abc1234',
      bundleHash: 'deadbeefcafe',
      channel: { repo: 'release-owner/release-repo' },
    });
    const resolver = new UpdateChannelResolver(channelPath);
    expect(resolver.resolve()).toBe('file-owner/file-repo');
  });

  it('updateChannel() writes a repo that resolve() then reads back', () => {
    const resolver = new UpdateChannelResolver(channelPath);
    resolver.updateChannel('written-owner/written-repo');
    expect(resolver.resolve()).toBe('written-owner/written-repo');
    const written = JSON.parse(fs.readFileSync(channelPath, 'utf-8'));
    expect(written.repo).toBe('written-owner/written-repo');
  });

  it('contains no hardcoded repository name in its source', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'UpdateChannelResolver.ts'), 'utf-8');
    // No literal "owner/name"-shaped GitHub repo slugs baked into the source.
    expect(source).not.toMatch(/['"][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+['"]/);
  });
});
