import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSupportedHubHost, hubAssetNames, resolveHubInstallPaths } from './hubInstall';

describe('hubAssetNames', () => {
  it('keeps the Linux and macOS names', () => {
    expect(hubAssetNames('v1.2.3', { platform: 'linux', arch: 'x64' })).toEqual({ archive: 'azito-hub-v1.2.3-linux-x64.tar.gz', sums: 'SHA256SUMS' });
    expect(hubAssetNames('v1.2.3', { platform: 'linux', arch: 'arm64' }).archive).toBe('azito-hub-v1.2.3-linux-arm64.tar.gz');
    expect(hubAssetNames('v1.2.3', { platform: 'darwin', arch: 'arm64' }).archive).toBe('azito-hub-v1.2.3-darwin-arm64.tar.gz');
    expect(hubAssetNames('v1.2.3', { platform: 'darwin', arch: 'x64' }).archive).toBe('azito-hub-v1.2.3-darwin-x64.tar.gz');
  });

  it('takes the win32-x64 zip on Windows', () => {
    expect(hubAssetNames('v0.12.0-rc.1', { platform: 'win32', arch: 'x64' })).toEqual({ archive: 'azito-hub-v0.12.0-rc.1-win32-x64.zip', sums: 'SHA256SUMS' });
  });

  it('refuses a Windows architecture that has no release, with the reason', () => {
    expect(() => hubAssetNames('v1.2.3', { platform: 'win32', arch: 'arm64' })).toThrow('There is no AZITO hub release for Windows on arm64: only win32-x64 is published');
    expect(() => assertSupportedHubHost({ platform: 'win32', arch: 'ia32' })).toThrow(/ia32/);
    expect(() => assertSupportedHubHost({ platform: 'linux', arch: 'x64' })).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('resolveHubInstallPaths (Unix)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-hub-install-')));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds the hub folder from the running bundle, whatever the prefix is called', () => {
    const prefix = path.join(root, 'my prefix');
    const paths = resolveHubInstallPaths({ platform: 'linux', bundleRoot: path.join(prefix, 'hub', 'current') });
    expect(paths).toEqual({ prefix, hubDir: path.join(prefix, 'hub'), bundlePath: path.join(prefix, 'hub', 'current', 'azito-hub.cjs') });
  });

  it('is the place `current` points at, whether the hub runs through the link or from the version folder', () => {
    const hub = path.join(root, '.azito', 'hub');
    fs.mkdirSync(path.join(hub, 'v1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'v1.0.0', 'azito-hub.cjs'), '');
    fs.symlinkSync(path.join(hub, 'v1.0.0'), path.join(hub, 'current'));
    for (const bundleRoot of [path.join(hub, 'current'), path.join(hub, 'v1.0.0')]) {
      const paths = resolveHubInstallPaths({ platform: 'darwin', bundleRoot });
      expect(paths.hubDir).toBe(hub);
      expect(fs.realpathSync(paths.bundlePath)).toBe(path.join(hub, 'v1.0.0', 'azito-hub.cjs'));
    }
  });

  it('is what the data directory\'s parent gave for a default install (~/.azito/data next to ~/.azito/hub)', () => {
    const prefix = path.join(root, '.azito');
    const dataDir = path.join(prefix, 'data');
    const paths = resolveHubInstallPaths({ platform: 'linux', bundleRoot: path.join(prefix, 'hub', 'current') });
    expect(paths.hubDir).toBe(path.join(path.dirname(dataDir), 'hub'));
  });

  it('refuses a source checkout and a bundle outside a hub folder', () => {
    expect(() => resolveHubInstallPaths({ platform: 'linux', bundleRoot: null })).toThrow(/not a release install/);
    expect(() => resolveHubInstallPaths({ platform: 'linux', bundleRoot: path.join(root, 'somewhere', 'v1.0.0') })).toThrow(/prefix cannot be told/);
  });
});

describe.skipIf(process.platform !== 'win32')('resolveHubInstallPaths (Windows)', () => {
  it('runs the update from the running version folder (there is no current link), under the prefix of the bundle', () => {
    const prefix = 'C:\\Users\\Some One\\azito prefix';
    const paths = resolveHubInstallPaths({ platform: 'win32', bundleRoot: `${prefix}\\hub\\v0.12.0` });
    expect(paths).toEqual({ prefix, hubDir: `${prefix}\\hub`, bundlePath: `${prefix}\\hub\\v0.12.0\\azito-hub.cjs` });
  });

  it('refuses a bundle outside a hub folder', () => {
    expect(() => resolveHubInstallPaths({ platform: 'win32', bundleRoot: 'C:\\x\\v0.12.0' })).toThrow(/prefix cannot be told/);
  });
});
