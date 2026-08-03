import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../../../shared/releaseInfo', () => ({
  getReleaseInfo: vi.fn(),
}));

vi.mock('child_process', () => ({
  // promisify(execFile) needs a callback-style function to wrap.
  execFile: vi.fn((_file: string, _args: string[], cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' });
  }),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execFileSync: vi.fn(),
}));

import { execFile, spawn } from 'child_process';
import { getReleaseInfo } from '../../../shared/releaseInfo';
import { SystemUpdateService } from '../SystemUpdateService';
import { UpdateChannelResolver } from '../UpdateChannelResolver';
import { UpdateStateManager } from '../UpdateStateManager';
import type { DeployModeDetector } from '../DeployModeDetector';
import type { DataPaths } from '../../../shared/dataDir';
import type { SqliteTaskRepository } from '../../tasks/SqliteTaskRepository';

const mockedGetReleaseInfo = vi.mocked(getReleaseInfo);
const mockedSpawn = vi.mocked(spawn);
const mockedExecFile = vi.mocked(execFile);

function detectorFor(mode: 'systemd' | 'launchd'): DeployModeDetector {
  return {
    detect: () => mode,
    canUpdate: () => true,
    serviceManager: () => mode,
    getDisabledReason: () => null,
  } as unknown as DeployModeDetector;
}

const taskRepoStub = { findByStatus: () => [] } as unknown as SqliteTaskRepository;

describe('SystemUpdateService.launchUpdateScript', () => {
  let tmpDir: string;
  let dataPaths: DataPaths;
  let channelResolver: UpdateChannelResolver;
  let stateManager: UpdateStateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-launch-test-'));
    dataPaths = {
      dir: tmpDir,
      updateState: path.join(tmpDir, 'update-state.json'),
      updateLog: path.join(tmpDir, 'update.log'),
      updateChannel: path.join(tmpDir, 'update-channel.json'),
    } as unknown as DataPaths;
    channelResolver = new UpdateChannelResolver(dataPaths.updateChannel);
    channelResolver.updateChannel('acme/azito-hub');
    stateManager = new UpdateStateManager(dataPaths.updateState, dataPaths.updateLog);

    mockedGetReleaseInfo.mockReturnValue({
      version: 'v1.0.0', commit: 'abc1234', bundleHash: 'deadbeef', channel: { repo: 'acme/azito-hub' },
    });

    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        tag_name: 'v1.1.0',
        body: null,
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: `azito-hub-v1.1.0-${platform}-${arch}.tar.gz`, browser_download_url: 'https://example.invalid/hub.tar.gz' },
          { name: 'SHA256SUMS', browser_download_url: 'https://example.invalid/SHA256SUMS' },
        ],
      }),
    } as Response)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('launches the update through systemd-run under systemd', async () => {
    const service = new SystemUpdateService(channelResolver, stateManager, detectorFor('systemd'), dataPaths, taskRepoStub);

    await expect(service.startUpdate()).resolves.toEqual({ started: true });

    expect(mockedSpawn).not.toHaveBeenCalled();
    const [file, args] = mockedExecFile.mock.calls[0];
    expect(file).toBe('systemd-run');
    expect(args).toContain('--service-manager');
    expect(args).toContain('systemd');
  });

  it('detaches the update process directly under launchd, where systemd-run does not exist', async () => {
    const service = new SystemUpdateService(channelResolver, stateManager, detectorFor('launchd'), dataPaths, taskRepoStub);

    await expect(service.startUpdate()).resolves.toEqual({ started: true });

    expect(mockedExecFile).not.toHaveBeenCalled();
    const [, args, options] = mockedSpawn.mock.calls[0] as [string, string[], { detached: boolean; stdio: string }];
    expect(args).toContain('update-run');
    expect(args.slice(args.indexOf('--service-manager'))).toEqual(['--service-manager', 'launchd']);
    // Its own session is what lets it outlive the SIGTERM from `kickstart -k`.
    expect(options.detached).toBe(true);
  });
});
