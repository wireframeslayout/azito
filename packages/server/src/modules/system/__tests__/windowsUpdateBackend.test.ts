import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import type { ServiceManager } from '../serviceManager';
import type { UpdateBackend } from '../updateBackend';
import { createWindowsUpdateBackend } from '../windowsUpdateBackend';
import type { WindowsHub } from '../windowsHubOperations';

vi.mock('../windowsHubOperations', () => ({ runOnWindows: vi.fn(async () => undefined) }));
vi.mock('../updateHealth', () => ({ waitForHealthyVersion: vi.fn(async () => undefined) }));
vi.mock('../../../shared/fs/safeArchive', () => ({ extractZipSafely: vi.fn() }));

import { runOnWindows } from '../windowsHubOperations';
import { waitForHealthyVersion } from '../updateHealth';
import { extractZipSafely } from '../../../shared/fs/safeArchive';

describe('the Windows update backend', () => {
  let hubDir: string;
  let backend: UpdateBackend;
  const manager = {} as ServiceManager;
  const hub = {} as WindowsHub;
  const context = { bundleRoot: null, pid: 4242, secretFileGuard: new UnixSecretFileGuard() };

  beforeEach(() => {
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-win-backend-'));
    fs.writeFileSync(path.join(hubDir, 'current.txt'), 'v1.0.0\r\n');
    backend = createWindowsUpdateBackend({ hubDir, healthUrl: 'http://127.0.0.1:3001/api/health', tar: 'tar.exe', hub, manager, context });
    vi.mocked(runOnWindows).mockClear();
    vi.mocked(waitForHealthyVersion).mockReset().mockResolvedValue(undefined);
    vi.mocked(extractZipSafely).mockReset();
  });

  afterEach(() => fs.rmSync(hubDir, { recursive: true, force: true }));

  const pointer = (): string => fs.readFileSync(path.join(hubDir, 'current.txt'), 'utf-8');

  it('reads what runs now from current.txt, and switches by writing it (no symlink)', async () => {
    expect(backend.currentRef()).toBe('v1.0.0');
    await backend.switchTo(path.join(hubDir, 'v1.1.0'), 'v1.1.0');
    expect(pointer()).toBe('v1.1.0\r\n');
    expect(fs.existsSync(path.join(hubDir, 'current.txt.tmp'))).toBe(false);
  });

  it('restarts with the very sequence of `azito service restart`, as this process (so it is not one of the hub processes that are ended)', async () => {
    await backend.restart();
    expect(runOnWindows).toHaveBeenCalledWith('restart', manager, hub, context);
  });

  it('puts the old version back, restarts and waits for the old version to be healthy', async () => {
    await backend.switchTo(path.join(hubDir, 'v1.1.0'), 'v1.1.0');
    await backend.rollback('v1.0.0', true);
    expect(pointer()).toBe('v1.0.0\r\n');
    expect(runOnWindows).toHaveBeenCalledTimes(1);
    expect(waitForHealthyVersion).toHaveBeenCalledWith('http://127.0.0.1:3001/api/health', 'v1.0.0', expect.any(Number));
  });

  it('leaves the running hub alone when the run never switched', async () => {
    await backend.rollback('v1.0.0', false);
    expect(runOnWindows).not.toHaveBeenCalled();
    expect(pointer()).toBe('v1.0.0\r\n');
  });

  it('a rollback whose old version does not come back healthy is an error, not a success', async () => {
    vi.mocked(waitForHealthyVersion).mockRejectedValueOnce(new Error('Health check timed out'));
    await expect(backend.rollback('v1.0.0', true)).rejects.toThrow('Health check timed out');
  });

  it('knows which folder current.txt names, and keeps one it cannot read about', () => {
    expect(backend.isCurrent(path.join(hubDir, 'v1.0.0'))).toBe(true);
    expect(backend.isCurrent(path.join(hubDir, 'v1.1.0'))).toBe(false);
    fs.writeFileSync(path.join(hubDir, 'current.txt'), 'garbage');
    expect(backend.isCurrent(path.join(hubDir, 'v1.1.0'))).toBe(true);
  });

  describe('extract', () => {
    const fakeZip = (files: Record<string, string>) => async ({ destination }: { destination: string }): Promise<void> => {
      fs.mkdirSync(destination, { recursive: true });
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(destination, name), content);
    };

    it('unpacks into a new folder', async () => {
      vi.mocked(extractZipSafely).mockImplementation(fakeZip({ 'azito-hub.cjs': 'x' }));
      await backend.extract('a.zip', path.join(hubDir, 'v1.1.0'));
      expect(extractZipSafely).toHaveBeenCalledWith({ archive: 'a.zip', destination: path.join(hubDir, 'v1.1.0'), tar: 'tar.exe' });
    });

    it('uses a folder that is already there when it holds everything the zip holds (extras are fine), and never writes into it', async () => {
      const installDir = path.join(hubDir, 'v1.1.0');
      fs.mkdirSync(installDir);
      fs.writeFileSync(path.join(installDir, 'azito-hub.cjs'), 'same');
      fs.writeFileSync(path.join(installDir, 'added-later.log'), 'extra');
      vi.mocked(extractZipSafely).mockImplementation(fakeZip({ 'azito-hub.cjs': 'same' }));
      await backend.extract('a.zip', installDir);
      expect(extractZipSafely).toHaveBeenCalledTimes(1);
      expect(vi.mocked(extractZipSafely).mock.calls[0]![0].destination).not.toBe(installDir);
      expect(fs.readFileSync(path.join(installDir, 'azito-hub.cjs'), 'utf-8')).toBe('same');
      expect(fs.readdirSync(hubDir).filter((n) => n.startsWith('.'))).toEqual([]);
    });

    it('refuses a folder that is already there and differs, naming what differs, and leaves it as it was', async () => {
      const installDir = path.join(hubDir, 'v1.1.0');
      fs.mkdirSync(installDir);
      fs.writeFileSync(path.join(installDir, 'azito-hub.cjs'), 'OLD');
      vi.mocked(extractZipSafely).mockImplementation(fakeZip({ 'azito-hub.cjs': 'NEW' }));
      await expect(backend.extract('a.zip', installDir)).rejects.toThrow(/already exists and is not the downloaded release \(azito-hub\.cjs has (another size|other content)\); it is not replaced/);
      expect(fs.readFileSync(path.join(installDir, 'azito-hub.cjs'), 'utf-8')).toBe('OLD');
      expect(fs.readdirSync(hubDir).filter((n) => n.startsWith('.'))).toEqual([]);
    });
  });
});
