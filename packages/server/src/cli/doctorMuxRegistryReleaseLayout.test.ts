import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _resetCache } from '../shared/releaseInfo';

const resolveRuntime = vi.hoisted(() => vi.fn());
vi.mock('../modules/tmux/misao/misaoDriver', async (importOriginal) => {
  const original = await importOriginal<typeof import('../modules/tmux/misao/misaoDriver')>();
  return {
    ...original,
    resolveMisaoRuntimeForHub: resolveRuntime,
    registerMisaoDriver: () => ({ connection: { start: async () => undefined, close: () => undefined } }),
  };
});

import { openDoctorMux } from './doctorMuxRegistry';
import { TaskTempFiles } from '../shared/os/taskTempFiles';

// The doctor reads MISAO_SOCKET from the same .env run.sh loads for the hub.
describe('openDoctorMux in a release layout', () => {
  let tmpDir: string;
  let hubDir: string;
  let bundleDir: string;
  let origArgv1: string;
  let origSocket: string | undefined;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-mux-release-')));
    hubDir = path.join(tmpDir, '.azito', 'hub');
    bundleDir = path.join(hubDir, '0.11.0');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, 'release.json'),
      JSON.stringify({ version: '0.11.0', commit: 'abc', bundleHash: 'h', channel: { repo: 'o/r' } }),
    );
    fs.symlinkSync(bundleDir, path.join(hubDir, 'current'));
    origSocket = process.env.MISAO_SOCKET;
    delete process.env.MISAO_SOCKET;
    origArgv1 = process.argv[1];
    process.argv[1] = path.join(hubDir, 'current', 'azito-hub.cjs');
    _resetCache();
    resolveRuntime.mockReset();
    resolveRuntime.mockResolvedValue({});
  });

  afterEach(() => {
    process.argv[1] = origArgv1;
    if (origSocket === undefined) delete process.env.MISAO_SOCKET;
    else process.env.MISAO_SOCKET = origSocket;
    _resetCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function socketSeenByResolver(): string | undefined {
    return resolveRuntime.mock.calls[0][0].env.MISAO_SOCKET;
  }

  it('uses MISAO_SOCKET from the bundle .env when there is no parent .env', async () => {
    fs.writeFileSync(path.join(bundleDir, '.env'), 'MISAO_SOCKET=/run/bundle.sock\n');
    await openDoctorMux({ platform: 'linux', arch: 'x64', homeDir: os.homedir(), tmpDir: '/tmp', execPath: process.execPath, uid: 1000 }, new TaskTempFiles('/tmp', 'linux'));
    expect(socketSeenByResolver()).toBe('/run/bundle.sock');
  });

  it('prefers the parent .env over the bundle .env', async () => {
    fs.writeFileSync(path.join(hubDir, '.env'), 'MISAO_SOCKET=/run/parent.sock\n');
    fs.writeFileSync(path.join(bundleDir, '.env'), 'MISAO_SOCKET=/run/bundle.sock\n');
    await openDoctorMux({ platform: 'linux', arch: 'x64', homeDir: os.homedir(), tmpDir: '/tmp', execPath: process.execPath, uid: 1000 }, new TaskTempFiles('/tmp', 'linux'));
    expect(socketSeenByResolver()).toBe('/run/parent.sock');
  });
});
