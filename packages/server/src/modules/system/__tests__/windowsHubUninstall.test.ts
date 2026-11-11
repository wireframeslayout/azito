import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import { readInstallInventory } from '../windowsInstallInventory';
vi.mock('../windowsHubFolderOps', async (importOriginal) => ({ ...(await importOriginal<typeof import('../windowsHubFolderOps')>()), removeFolderWithRd: vi.fn() }));

import { removeFolderWithRd } from '../windowsHubFolderOps';
import { consumeWindowsInstallRecord, readWindowsInstallRecord, removeRecordedTree, verifyRecordedData, verifyRecordedRelease } from '../windowsHubUninstall';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-uninstall-'));
  roots.push(root);
  const hub = path.join(root, 'hub');
  const release = path.join(hub, 'v1.2.3');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'node.exe'), 'bundle');
  const guard = new UnixSecretFileGuard();
  guard.inspect = () => ({ ok: true });
  const record = { version: 1, consumed: false, release: 'v1.2.3', inventory: readInstallInventory(release), wrapperSha256: null, pathAdded: false, dataInventory: null };
  guard.writeSecretFile(path.join(hub, '.install-record.json'), JSON.stringify(record));
  return { hub, release, guard };
}

describe('recorded release verification', () => {
  it('accepts the exact recorded release', () => {
    const { hub, release, guard } = setup();
    expect(verifyRecordedRelease(hub, readWindowsInstallRecord(hub, guard))).toBe(release);
  });

  it('refuses an added file or a changed file', () => {
    const { hub, release, guard } = setup();
    const record = readWindowsInstallRecord(hub, guard);
    fs.writeFileSync(path.join(release, 'user-file'), 'keep');
    expect(() => verifyRecordedRelease(hub, record)).toThrow(/differ/);
    fs.unlinkSync(path.join(release, 'user-file'));
    fs.writeFileSync(path.join(release, 'node.exe'), 'changed');
    expect(() => verifyRecordedRelease(hub, record)).toThrow(/differ/);
  });

  it('does not delete data when the directory was not recorded or its contents changed', () => {
    const { hub, guard } = setup();
    const prefix = path.dirname(hub);
    const data = path.join(prefix, 'data');
    fs.mkdirSync(data);
    const record = readWindowsInstallRecord(hub, guard);
    expect(() => verifyRecordedData(prefix, record)).toThrow(/did not create/);
    const withData = { ...record, dataInventory: readInstallInventory(data) };
    expect(verifyRecordedData(prefix, withData)).toBe(data);
    fs.writeFileSync(path.join(data, 'user-file'), 'keep');
    expect(() => verifyRecordedData(prefix, withData)).toThrow(/differ/);
  });

  it('reports the isolated folder when removal fails', async () => {
    const { hub } = setup();
    vi.mocked(removeFolderWithRd).mockRejectedValueOnce(new Error('held open'));
    await expect(removeRecordedTree(hub, 'v1.2.3', vi.fn(), 'C:\\Windows')).rejects.toThrow(/inspect .*\.uninstall-.*held open/);
    expect(fs.readdirSync(hub).some((name) => name.startsWith('.uninstall-'))).toBe(true);
  });

  it('persists that an attempt started before any item is removed', () => {
    const { hub, guard } = setup();
    consumeWindowsInstallRecord(hub, readWindowsInstallRecord(hub, guard), guard);
    expect(readWindowsInstallRecord(hub, guard).consumed).toBe(true);
  });
});
