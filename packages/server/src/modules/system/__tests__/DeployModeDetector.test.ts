import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

vi.mock('../../../shared/releaseInfo', () => ({
  isReleaseMode: vi.fn(),
}));
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { isReleaseMode } from '../../../shared/releaseInfo';
import { DeployModeDetector } from '../DeployModeDetector';

const mockedIsReleaseMode = vi.mocked(isReleaseMode);
const mockedExecFileSync = vi.mocked(execFileSync);

describe('DeployModeDetector', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-deploymode-test-'));
    process.env.HOME = tmpHome;
    mockedIsReleaseMode.mockReset();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  it('returns "source" when not running in release mode', () => {
    mockedIsReleaseMode.mockReturnValue(false);
    const detector = new DeployModeDetector();
    expect(detector.detect()).toBe('source');
    expect(detector.canUpdate()).toBe(false);
    expect(detector.serviceManager()).toBeNull();
  });

  it('detects "launchd" on darwin when the launchd plist exists', () => {
    mockedIsReleaseMode.mockReturnValue(true);
    setPlatform('darwin');
    fs.mkdirSync(path.join(tmpHome, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'Library', 'LaunchAgents', 'com.azito.hub.plist'), '');
    const detector = new DeployModeDetector();
    expect(detector.detect()).toBe('launchd');
    expect(detector.canUpdate()).toBe(true);
    expect(detector.serviceManager()).toBe('launchd');
  });

  it('detects "systemd" when the release-mode user unit is active', () => {
    mockedIsReleaseMode.mockReturnValue(true);
    setPlatform('linux');
    mockedExecFileSync.mockReturnValue(Buffer.from('active'));
    const detector = new DeployModeDetector();
    expect(detector.detect()).toBe('systemd');
    expect(detector.canUpdate()).toBe(true);
  });

  it('falls back to "source" in release mode when systemctl check fails', () => {
    mockedIsReleaseMode.mockReturnValue(true);
    setPlatform('linux');
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('systemctl not found');
    });
    const detector = new DeployModeDetector();
    expect(detector.detect()).toBe('source');
  });

  it('getDisabledReason explains source, and is null for both service managers', () => {
    mockedIsReleaseMode.mockReturnValue(true);
    setPlatform('darwin');
    fs.mkdirSync(path.join(tmpHome, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'Library', 'LaunchAgents', 'com.azito.hub.plist'), '');
    const launchdDetector = new DeployModeDetector();
    expect(launchdDetector.getDisabledReason()).toBeNull();

    mockedIsReleaseMode.mockReturnValue(false);
    const sourceDetector = new DeployModeDetector();
    expect(sourceDetector.getDisabledReason()).toMatch(/開発モード/);

    mockedIsReleaseMode.mockReturnValue(true);
    setPlatform('linux');
    mockedExecFileSync.mockReturnValue(Buffer.from('active'));
    const systemdDetector = new DeployModeDetector();
    expect(systemdDetector.getDisabledReason()).toBeNull();
  });
});
