import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DataPaths } from '../../../shared/dataDir';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import { windowsInstallRecordCommand } from '../../../cli/windowsInstallRecordCommand';
import { readWindowsInstallRecord } from '../windowsHubUninstall';
import { createOwnedCanaryRecorder, listOwnedDataNames, ownedSecretMarker, readOwnedSecret, trackWindowsOwnedSecrets } from '../windowsOwnedSecrets';
import { getMasterKey, initSecretBox } from '../../../shared/crypto/SecretBox';
import { resolveWebhookToken } from '../../../shared/uiToken';
import { getVapidKeys, initVapidKeyManager } from '../../notifications/push/VapidKeyManager';
import { getVerifiedHubCanary, writeHubCanary } from '../../servers/hubCanary';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-owned-secrets-'));
  roots.push(root);
  const hub = path.join(root, 'hub');
  const bundle = path.join(hub, 'v1.2.3');
  const dir = path.join(root, 'data');
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(bundle, 'node.exe'), 'bundle');
  const guard = new UnixSecretFileGuard();
  guard.inspect = () => ({ ok: true });
  windowsInstallRecordCommand(bundle, ['--data-created'], guard, 'win32');
  const paths: DataPaths = {
    dir, db: path.join(dir, 'data.db'), masterKey: path.join(dir, 'master.key'), vapidKeys: path.join(dir, 'vapid-keys.json'),
    uiToken: path.join(dir, 'ui-token'), webhookToken: path.join(dir, 'webhook-token'), browserProfile: path.join(dir, 'browser-profile'),
    sidekicks: path.join(dir, 'sidekicks'), updateState: path.join(dir, 'update-state'), updateLog: path.join(dir, 'update.log'), updateChannel: path.join(dir, 'update-channel'),
  };
  return { root, hub, bundle, paths, guard };
}

describe('tracked Windows secrets', () => {
  it('records only an exclusively created secret and refuses a replacement', () => {
    const { root, hub, bundle, paths, guard } = setup();
    const tracked = trackWindowsOwnedSecrets(guard, bundle, paths, 'win32');
    tracked.writeSecretFile(paths.masterKey, 'generated');
    const record = readWindowsInstallRecord(hub, guard);
    expect(readOwnedSecret(root, hub, 'master.key', record, guard)).toBe(paths.masterKey);
    fs.renameSync(paths.masterKey, `${paths.masterKey}.old`);
    guard.writeSecretFile(paths.masterKey, 'replacement');
    expect(() => readOwnedSecret(root, hub, 'master.key', record, guard)).toThrow(/not the recorded/);
  });

  it('does not claim a file that already exists', () => {
    const { hub, bundle, paths, guard } = setup();
    guard.writeSecretFile(paths.webhookToken, 'user');
    trackWindowsOwnedSecrets(guard, bundle, paths, 'win32').writeSecretFile(paths.webhookToken, 'updated');
    expect(fs.existsSync(ownedSecretMarker(hub, 'webhook-token'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not replace a dangling link at a secret path', () => {
    const { hub, bundle, paths, guard } = setup();
    fs.symlinkSync(path.join(paths.dir, 'missing'), paths.masterKey);
    expect(() => trackWindowsOwnedSecrets(guard, bundle, paths, 'win32').writeSecretFile(paths.masterKey, 'generated')).toThrow(/not a regular file/);
    expect(fs.lstatSync(paths.masterKey).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(ownedSecretMarker(hub, 'master.key'))).toBe(false);
  });

  it('does not track an external data directory', () => {
    const { bundle, paths, guard } = setup();
    expect(trackWindowsOwnedSecrets(guard, bundle, { ...paths, dir: path.join(paths.dir, 'external') }, 'win32')).toBe(guard);
  });

  it('does not publish an empty secret or overwrite a file created concurrently', () => {
    const { hub, bundle, paths, guard } = setup();
    const tracked = trackWindowsOwnedSecrets(guard, bundle, paths, 'win32');
    const original = guard.writeSecretFile.bind(guard);
    vi.spyOn(guard, 'writeSecretFile').mockImplementation((file, content) => {
      expect(fs.existsSync(paths.masterKey)).toBe(false);
      original(file, content);
      fs.writeFileSync(paths.masterKey, 'user data');
    });
    expect(() => tracked.writeSecretFile(paths.masterKey, 'generated')).toThrow();
    expect(fs.readFileSync(paths.masterKey, 'utf8')).toBe('user data');
    expect(fs.existsSync(ownedSecretMarker(hub, 'master.key'))).toBe(false);
    expect(fs.readdirSync(paths.dir).some((name) => name.startsWith('.master.key.'))).toBe(false);
  });

  it('keeps secret creation working when the filesystem cannot create a link, without claiming the file', () => {
    const { hub, bundle, paths, guard } = setup();
    const tracked = trackWindowsOwnedSecrets(guard, bundle, paths, 'win32');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const link = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
    try {
      tracked.writeSecretFile(paths.masterKey, 'generated');
      expect(fs.readFileSync(paths.masterKey, 'utf8')).toBe('generated');
      expect(fs.existsSync(ownedSecretMarker(hub, 'master.key'))).toBe(false);
      expect(warning).toHaveBeenCalled();
    } finally { link.mockRestore(); warning.mockRestore(); }
  });

  it('uses the original writer without claiming the file when the tracking temporary file cannot be made', () => {
    const { hub, bundle, paths, guard } = setup();
    const tracked = trackWindowsOwnedSecrets(guard, bundle, paths, 'win32');
    const original = guard.writeSecretFile.bind(guard);
    const write = vi.spyOn(guard, 'writeSecretFile').mockImplementationOnce(() => { throw new Error('temporary path unavailable'); });
    write.mockImplementation((file, content) => original(file, content));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      tracked.writeSecretFile(paths.masterKey, 'generated');
      expect(fs.readFileSync(paths.masterKey, 'utf8')).toBe('generated');
      expect(fs.existsSync(ownedSecretMarker(hub, 'master.key'))).toBe(false);
    } finally { write.mockRestore(); warning.mockRestore(); }
  });

  it('records secrets through the existing runtime generators', () => {
    const { root, hub, bundle, paths, guard } = setup();
    vi.stubEnv('AZITO_MASTER_KEY', '');
    vi.stubEnv('AZITO_WEBHOOK_TOKEN', '');
    const tracked = trackWindowsOwnedSecrets(guard, bundle, paths, 'win32');
    initSecretBox(paths.masterKey, tracked);
    initVapidKeyManager(paths.vapidKeys, tracked);
    expect(getMasterKey()).toHaveLength(32);
    expect(getVapidKeys().publicKey).toBeTruthy();
    expect(resolveWebhookToken(paths.webhookToken, tracked)).toHaveLength(64);
    const record = readWindowsInstallRecord(hub, guard);
    for (const name of ['master.key', 'vapid-keys.json', 'webhook-token'] as const) {
      expect(readOwnedSecret(root, hub, name, record, guard)).toBe(path.join(paths.dir, name));
    }
  });

  it('records an exclusively created canary and its regeneration', () => {
    const { root, hub, bundle, paths, guard } = setup();
    const observer = createOwnedCanaryRecorder(guard, bundle, paths, 'win32');
    const first = writeHubCanary(paths.dir, observer);
    expect(first).not.toBeNull();
    const name = path.basename(first!.path);
    expect(listOwnedDataNames(hub)).toContain(name);
    const record = readWindowsInstallRecord(hub, guard);
    expect(readOwnedSecret(root, hub, name, record, guard)).toBe(first!.path);
    fs.unlinkSync(first!.path);
    const next = getVerifiedHubCanary();
    expect(next).not.toBeNull();
    expect(listOwnedDataNames(hub)).toContain(path.basename(next!.path));
    expect(readOwnedSecret(root, hub, path.basename(next!.path), record, guard)).toBe(next!.path);
  });
});
