import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../shared/releaseInfo', () => ({ getReleaseInfo: vi.fn() }));
vi.mock('../windowsHubUpdateTask', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../windowsHubUpdateTask')>()),
  launchHubUpdateTask: vi.fn(async () => undefined),
}));

import { getReleaseInfo } from '../../../shared/releaseInfo';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import type { SchtasksClient } from '../../../shared/os/taskScheduler/schtasks';
import { GITHUB_API_BASE, SystemUpdateService, resolveGithubApiBase, type WindowsUpdateHost } from '../SystemUpdateService';
import { UpdateChannelResolver } from '../UpdateChannelResolver';
import { UpdateStateManager } from '../UpdateStateManager';
import { launchHubUpdateTask } from '../windowsHubUpdateTask';
import type { DeployModeDetector } from '../DeployModeDetector';
import type { DataPaths } from '../../../shared/dataDir';
import type { SqliteTaskRepository } from '../../tasks/SqliteTaskRepository';

const guard = new UnixSecretFileGuard();

describe('resolveGithubApiBase', () => {
  it('is GitHub unless a loopback address is named', () => {
    expect(resolveGithubApiBase({})).toBe(GITHUB_API_BASE);
    expect(resolveGithubApiBase({ AZITO_UPDATE_API_BASE: '' })).toBe(GITHUB_API_BASE);
    expect(resolveGithubApiBase({ AZITO_UPDATE_API_BASE: 'http://127.0.0.1:4010' })).toBe('http://127.0.0.1:4010');
    expect(resolveGithubApiBase({ AZITO_UPDATE_API_BASE: 'http://localhost:4010' })).toBe('http://localhost:4010');
    expect(resolveGithubApiBase({ AZITO_UPDATE_API_BASE: 'http://[::1]:4010' })).toBe('http://[::1]:4010');
  });

  it.each(['https://evil.example', 'http://evil.example:80', 'http://127.0.0.1.evil.example', 'https://127.0.0.1', 'http://127.0.0.1:4010/path', 'http://user@127.0.0.1'])('refuses %s: a release lookup carries the GitHub token', (value) => {
    expect(() => resolveGithubApiBase({ AZITO_UPDATE_API_BASE: value })).toThrow(/loopback.*for tests only/);
  });
});

describe('SystemUpdateService on Windows', () => {
  let tmpDir: string;
  let dataPaths: DataPaths;
  let stateManager: UpdateStateManager;
  let channelResolver: UpdateChannelResolver;
  const taskRepo = { findByStatus: () => [] } as unknown as SqliteTaskRepository;
  const windowsUpdate: WindowsUpdateHost = { launcher: { client: {} as SchtasksClient, guard }, systemRoot: 'C:\\Windows', env: { USERDOMAIN: 'PC', USERNAME: 'me' } };
  const detector = { detect: () => 'taskscheduler', canUpdate: () => true, serviceManager: () => null, getDisabledReason: () => null } as unknown as DeployModeDetector;
  let host: { platform: 'win32'; arch: 'x64'; bundleRoot: string };
  const fetchMock = vi.fn();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-win-'));
    dataPaths = { dir: tmpDir, updateState: path.join(tmpDir, 'update-state.json'), updateLog: path.join(tmpDir, 'update.log'), updateChannel: path.join(tmpDir, 'update-channel.json') } as unknown as DataPaths;
    host = { platform: 'win32', arch: 'x64', bundleRoot: path.join(tmpDir, 'prefix', 'hub', 'v1.0.0') };
    channelResolver = new UpdateChannelResolver(dataPaths.updateChannel, guard);
    channelResolver.updateChannel('acme/azito-hub');
    stateManager = new UpdateStateManager(dataPaths.updateState, dataPaths.updateLog, guard);
    vi.mocked(getReleaseInfo).mockReturnValue({ version: 'v1.0.0', commit: 'abc1234', bundleHash: 'dead', channel: { repo: 'acme/azito-hub' } });
    vi.mocked(launchHubUpdateTask).mockClear();
    fetchMock.mockReset().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v1.1.0', body: null, published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'azito-hub-v1.1.0-win32-x64.zip', browser_download_url: 'http://127.0.0.1:9/dl/azito-hub-v1.1.0-win32-x64.zip' },
          { name: 'SHA256SUMS', browser_download_url: 'http://127.0.0.1:9/dl/SHA256SUMS' },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('AZITO_GITHUB_TOKEN', '');
    vi.stubEnv('AZITO_BIND', '');
    vi.stubEnv('PORT', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const service = (windows: WindowsUpdateHost | null = windowsUpdate): SystemUpdateService => new SystemUpdateService(
    channelResolver, stateManager, detector, dataPaths, taskRepo, null, host, { githubApiBase: 'http://127.0.0.1:4010', windowsUpdate: windows },
  );

  it('launches the one-shot update task with the current version\'s node and bundle, and the hub\'s own address as the health URL', async () => {
    vi.stubEnv('AZITO_BIND', '127.0.0.1');
    vi.stubEnv('PORT', '3010');
    await expect(service().startUpdate()).resolves.toEqual({ started: true });
    const launch = vi.mocked(launchHubUpdateTask).mock.calls[0]![1];
    const hubDir = path.join(tmpDir, 'prefix', 'hub');
    expect(launch.task).toMatchObject({
      userId: 'PC\\me', systemRoot: 'C:\\Windows', hubDir, nodePath: process.execPath,
      bundlePath: path.join(host.bundleRoot, 'azito-hub.cjs'), outputLog: path.join(tmpDir, 'update-run.out.log'),
    });
    const a = launch.task.updateArgs;
    const value = (flag: string): string | undefined => a[a.indexOf(flag) + 1];
    expect(value('--service-manager')).toBe('taskscheduler');
    expect(value('--hub-dir')).toBe(hubDir);
    expect(value('--data-dir')).toBe(tmpDir);
    expect(value('--version')).toBe('v1.1.0');
    expect(value('--old-version')).toBe('v1.0.0');
    expect(value('--tarball-url')).toBe('http://127.0.0.1:9/dl/azito-hub-v1.1.0-win32-x64.zip');
    expect(value('--health-url')).toBe('http://127.0.0.1:3010/api/health');
    expect(a).not.toContain('--token-file');
    expect(launch.token).toBeUndefined();
  });

  it('hands the token over as a file, never as an argument', async () => {
    vi.stubEnv('AZITO_GITHUB_TOKEN', 'ghp_secret');
    await service().startUpdate();
    const launch = vi.mocked(launchHubUpdateTask).mock.calls[0]![1];
    expect(launch.token).toBe('ghp_secret');
    expect(launch.tokenFile).toBe(path.join(tmpDir, 'update-token'));
    expect(launch.task.updateArgs).toContain('--token-file');
    expect(launch.task.updateArgs[launch.task.updateArgs.indexOf('--token-file') + 1]).toBe(launch.tokenFile);
    expect(JSON.stringify(launch.task)).not.toContain('ghp_secret');
  });

  it('brackets an IPv6 bind address in the health URL', async () => {
    vi.stubEnv('AZITO_BIND', '::1');
    await service().startUpdate();
    const args = vi.mocked(launchHubUpdateTask).mock.calls[0]![1].task.updateArgs;
    expect(args[args.indexOf('--health-url') + 1]).toBe('http://[::1]:3001/api/health');
  });

  it('looks the release up at the configured API base, not at GitHub', async () => {
    await service().startUpdate('v1.1.0');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:4010/repos/acme/azito-hub/releases/tags/v1.1.0');
  });

  it('records a failed launch (the task could not be registered) as a failed update with the reason', async () => {
    vi.mocked(launchHubUpdateTask).mockRejectedValueOnce(new Error('schtasks /Create failed'));
    const result = await service().startUpdate();
    expect(result).toEqual({ started: false, error: '更新プロセスの起動に失敗しました: schtasks /Create failed' });
    expect(stateManager.read()).toMatchObject({ status: 'failed', error: 'schtasks /Create failed' });
  });

  it('a hub that was started without the means to launch it fails with the reason, never silently', async () => {
    const result = await service(null).startUpdate();
    expect(result.started).toBe(false);
    expect(result.error).toMatch(/without the means to launch a Windows update/);
  });
});
