import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../../../shared/releaseInfo', () => ({
  getReleaseInfo: vi.fn(),
}));

import { getReleaseInfo } from '../../../shared/releaseInfo';
import { SystemUpdateService } from '../SystemUpdateService';
import { UpdateChannelResolver } from '../UpdateChannelResolver';
import { UpdateStateManager } from '../UpdateStateManager';
import { DeployModeDetector } from '../DeployModeDetector';
import type { DataPaths } from '../../../shared/dataDir';
import type { SqliteTaskRepository } from '../../tasks/SqliteTaskRepository';
import type { Task } from '../../tasks/Task';

const mockedGetReleaseInfo = vi.mocked(getReleaseInfo);

function makeTaskRepoStub(nonTerminalCount: number): SqliteTaskRepository {
  return {
    findByStatus: vi.fn((status: string) => {
      // Only report tasks under one non-terminal status so the test can
      // control the count precisely without depending on which of the
      // several non-terminal statuses the service happens to check.
      if (status === 'running') return Array(nonTerminalCount).fill({} as Task);
      return [];
    }),
  } as unknown as SqliteTaskRepository;
}

function releaseAsset(name: string): { name: string; browser_download_url: string } {
  return { name, browser_download_url: `https://example.invalid/${name}` };
}

describe('SystemUpdateService', () => {
  let tmpDir: string;
  let dataPaths: DataPaths;
  let deployModeDetector: DeployModeDetector;
  let channelResolver: UpdateChannelResolver;
  let stateManager: UpdateStateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-system-update-test-'));
    dataPaths = {
      dir: tmpDir,
      db: path.join(tmpDir, 'data.db'),
      masterKey: path.join(tmpDir, 'master.key'),
      vapidKeys: path.join(tmpDir, 'vapid-keys.json'),
      uiToken: path.join(tmpDir, 'ui-token'),
      browserProfile: path.join(tmpDir, 'browser-profile'),
      sidekicks: path.join(tmpDir, 'sidekicks'),
      updateState: path.join(tmpDir, 'update-state.json'),
      updateLog: path.join(tmpDir, 'update.log'),
      updateChannel: path.join(tmpDir, 'update-channel.json'),
    };
    channelResolver = new UpdateChannelResolver(dataPaths.updateChannel);
    channelResolver.updateChannel('acme/azito-hub');
    stateManager = new UpdateStateManager(dataPaths.updateState, dataPaths.updateLog);
    deployModeDetector = { detect: () => 'systemd', canUpdate: () => true, getDisabledReason: () => null } as unknown as DeployModeDetector;
    mockedGetReleaseInfo.mockReset();
    mockedGetReleaseInfo.mockReturnValue({ version: 'v1.0.0', commit: 'abc1234', bundleHash: 'deadbeef', channel: { repo: 'acme/azito-hub' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports update-available and parses "- sha message" changelog lines', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        tag_name: 'v1.1.0',
        body: '- ab12cd3 feat: add thing\n- fix: unrelated bug (#42)\nnot a changelog line',
        published_at: '2026-01-01T00:00:00Z',
        assets: [releaseAsset(`azito-hub-v1.1.0-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`), releaseAsset('SHA256SUMS')],
      }),
    } as Response)));

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const status = await service.checkForUpdate();

    expect(status.status).toBe('update-available');
    expect(status.latestVersion).toBe('v1.1.0');
    expect(status.commits).toEqual([
      { sha: 'ab12cd3', message: 'feat: add thing' },
    ]);
    expect(status.commitsBehind).toBe(1);
  });

  it('treats a release with a malformed tag_name as check-failed rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        tag_name: '../../etc/passwd',
        body: null,
        published_at: '2026-01-01T00:00:00Z',
        assets: [releaseAsset('SHA256SUMS')],
      }),
    } as Response)));

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const status = await service.checkForUpdate();

    expect(status.status).toBe('check-failed');
    expect(status.latestVersion).toBeNull();
  });

  it('treats a 200 response with a missing assets array as check-failed, not a thrown error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ tag_name: 'v1.1.0', body: null, published_at: '2026-01-01T00:00:00Z' }),
    } as Response)));

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    await expect(service.checkForUpdate()).resolves.toMatchObject({ status: 'check-failed' });
  });

  it('startUpdate refuses when non-terminal tasks are running', async () => {
    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(2));
    const result = await service.startUpdate();
    expect(result.started).toBe(false);
    expect(result.error).toMatch(/2/);
  });

  it('startUpdate refuses a second concurrent call while the first is still resolving', async () => {
    let releaseFetch!: () => void;
    const pending = new Promise<Response>((resolve) => {
      releaseFetch = () => resolve({ ok: false, status: 500 } as Response);
    });
    vi.stubGlobal('fetch', vi.fn(() => pending));

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const first = service.startUpdate();
    const second = await service.startUpdate();

    expect(second).toEqual({ started: false, error: '更新は既に実行中です' });

    releaseFetch();
    await first;
  });

  it('returns update-available with empty commits for prose-only release body', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        tag_name: 'v1.1.0',
        body: '## v1.1.0\n\n### メインフィーチャー\n\n- **対応プラットフォーム**: linux-x64 / linux-arm64\n- **install.sh**: チェックサム検証、依存の検出\n',
        published_at: '2026-01-01T00:00:00Z',
        assets: [releaseAsset(`azito-hub-v1.1.0-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`), releaseAsset('SHA256SUMS')],
      }),
    } as Response)));

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const status = await service.checkForUpdate();

    expect(status.status).toBe('update-available');
    expect(status.commits).toEqual([]);
    expect(status.commitsBehind).toBe(0);
  });

  it('parses "* sha message" changelog lines with asterisk bullets', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        tag_name: 'v1.1.0',
        body: '* ab12cd3 fix: bug\n* cd45ef6 feat: feature',
        published_at: '2026-01-01T00:00:00Z',
        assets: [releaseAsset(`azito-hub-v1.1.0-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`), releaseAsset('SHA256SUMS')],
      }),
    } as Response)));

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const status = await service.checkForUpdate();

    expect(status.commits).toEqual([
      { sha: 'ab12cd3', message: 'fix: bug' },
      { sha: 'cd45ef6', message: 'feat: feature' },
    ]);
    expect(status.commitsBehind).toBe(2);
  });

  it('ignores a line with sha only and no message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        tag_name: 'v1.1.0',
        body: '- ab12cd3\n- cd45ef6 feat: valid',
        published_at: '2026-01-01T00:00:00Z',
        assets: [releaseAsset(`azito-hub-v1.1.0-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`), releaseAsset('SHA256SUMS')],
      }),
    } as Response)));

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const status = await service.checkForUpdate();

    expect(status.commits).toEqual([
      { sha: 'cd45ef6', message: 'feat: valid' },
    ]);
    expect(status.commitsBehind).toBe(1);
  });

  it('getProgress returns terminal state within TTL', () => {
    const state = {
      status: 'success' as const,
      step: 'health-check' as const,
      fromVersion: 'v1.0.0',
      toVersion: 'v1.1.0',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      steps: [],
    };
    stateManager.write(state);
    stateManager.appendLog('Update succeeded');

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const result = service.getProgress();

    expect(result.state).not.toBeNull();
    expect(result.state!.status).toBe('success');
    expect(result.log.length).toBeGreaterThan(0);
  });

  it('getProgress clears terminal state after TTL expires', () => {
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const state = {
      status: 'success' as const,
      step: 'health-check' as const,
      fromVersion: 'v1.0.0',
      toVersion: 'v1.1.0',
      startedAt: elevenMinutesAgo,
      completedAt: elevenMinutesAgo,
      steps: [],
    };
    stateManager.write(state);

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const result = service.getProgress();

    expect(result.state).toBeNull();
    expect(result.log).toEqual([]);
    expect(stateManager.read()).toBeNull();
  });

  it('getProgress clears terminal state with missing completedAt', () => {
    const state = {
      status: 'failed' as const,
      step: 'download' as const,
      fromVersion: 'v1.0.0',
      toVersion: 'v1.1.0',
      startedAt: new Date().toISOString(),
      error: 'network error',
      steps: [],
    };
    stateManager.write(state);

    const service = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, makeTaskRepoStub(0));
    const result = service.getProgress();

    expect(result.state).toBeNull();
    expect(result.log).toEqual([]);
    expect(stateManager.read()).toBeNull();
  });

  it('startUpdate refuses when deploy mode does not support updates', async () => {
    const disabledDetector = {
      detect: () => 'source',
      canUpdate: () => false,
      getDisabledReason: () => '開発モードで起動中のため、画面からは更新できません。ターミナルで git pull を実行してください',
    } as unknown as DeployModeDetector;
    const service = new SystemUpdateService(channelResolver, stateManager, disabledDetector, dataPaths, makeTaskRepoStub(0));
    const result = await service.startUpdate();
    expect(result).toEqual({ started: false, error: disabledDetector.getDisabledReason() });
  });
});
