import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import { readInstallFileIdentity, readInstallInventory } from '../windowsInstallInventory';
vi.mock('../windowsHubFolderOps', async (importOriginal) => ({ ...(await importOriginal<typeof import('../windowsHubFolderOps')>()), removeFolderWithRd: vi.fn(), assertHubDirsOnlyOwnerWritable: vi.fn(async () => undefined) }));

import { removeFolderWithRd } from '../windowsHubFolderOps';
import { assertNoHubLaunchers, assertNoOtherHubProcesses, consumeWindowsInstallRecord, prepareRecordedMisao, readWindowsInstallRecord, removeRecordedTree, verifyRecordedData, verifyRecordedDatabase, verifyRecordedRelease } from '../windowsHubUninstall';

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
  const record = { version: 1, consumed: false, release: 'v1.2.3', inventory: readInstallInventory(release), wrapperSha256: null, pathAdded: false, dataInventory: null, dataRootIdentity: null, dbIdentity: null };
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
    const db = path.join(data, 'data.db');
    fs.writeFileSync(db, 'original');
    const record = readWindowsInstallRecord(hub, guard);
    expect(() => verifyRecordedData(prefix, record)).toThrow(/did not create/);
    const withData = { ...record, dataInventory: readInstallInventory(data), dataRootIdentity: readInstallFileIdentity(data), dbIdentity: readInstallFileIdentity(db) };
    expect(verifyRecordedData(prefix, withData)).toBe(data);
    fs.writeFileSync(db, 'changed contents');
    expect(verifyRecordedDatabase(prefix, withData, guard)).toBe(db);
    fs.writeFileSync(path.join(data, 'user-file'), 'keep');
    expect(() => verifyRecordedData(prefix, withData)).toThrow(/differ/);
    fs.renameSync(db, path.join(data, 'old-db'));
    fs.writeFileSync(db, 'replacement');
    expect(() => verifyRecordedDatabase(prefix, withData, guard)).toThrow(/not the recorded file/);
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

  it('refuses a modified misao release or a replaced pointer', async () => {
    const { hub, guard } = setup();
    const prefix = path.dirname(hub);
    const root = path.join(prefix, 'misao');
    const release = path.join(root, 'v1.2.3');
    fs.mkdirSync(release, { recursive: true });
    const exe = path.join(release, 'misao.exe');
    const pointer = path.join(root, 'current');
    fs.writeFileSync(exe, 'original');
    fs.writeFileSync(pointer, 'v1.2.3');
    const record = { ...readWindowsInstallRecord(hub, guard), misao: { version: 'v1.2.3', rootIdentity: readInstallFileIdentity(root), currentIdentity: readInstallFileIdentity(pointer), releaseIdentity: readInstallFileIdentity(release), taskHash: 'a'.repeat(64), inventory: readInstallInventory(release), fileIdentities: [{ path: 'misao.exe', identity: readInstallFileIdentity(exe) }] } };
    await expect(prepareRecordedMisao(prefix, record, guard, vi.fn(), 'C:\\Windows')).resolves.toEqual({ root, version: 'v1.2.3' });
    fs.writeFileSync(exe, 'modified');
    await expect(prepareRecordedMisao(prefix, record, guard, vi.fn(), 'C:\\Windows')).rejects.toThrow(/differs/);
    fs.writeFileSync(exe, 'original');
    const oldExe = path.join(prefix, 'misao-old.exe');
    fs.renameSync(exe, oldExe);
    fs.writeFileSync(exe, 'original');
    await expect(prepareRecordedMisao(prefix, record, guard, vi.fn(), 'C:\\Windows')).rejects.toThrow(/recorded protected/);
    fs.unlinkSync(exe);
    fs.renameSync(oldExe, exe);
    fs.renameSync(pointer, `${pointer}.old`);
    fs.writeFileSync(pointer, 'v1.2.3');
    await expect(prepareRecordedMisao(prefix, record, guard, vi.fn(), 'C:\\Windows')).rejects.toThrow(/pointer is not the recorded/);
  });

  it('removes only an isolated release and leaves other misao files intact', async () => {
    const { hub } = setup();
    const root = path.join(path.dirname(hub), 'misao');
    fs.mkdirSync(path.join(root, 'v1.2.3'), { recursive: true });
    fs.writeFileSync(path.join(root, 'v1.2.3', 'misao.exe'), 'binary');
    fs.writeFileSync(path.join(root, 'user-file'), 'keep');
    vi.mocked(removeFolderWithRd).mockImplementationOnce(async (_run, _system, parent, name) => { fs.rmSync(path.join(parent, name), { recursive: true }); });
    await removeRecordedTree(root, 'v1.2.3', vi.fn(), 'C:\\Windows');
    expect(fs.existsSync(path.join(root, 'v1.2.3'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'user-file'), 'utf8')).toBe('keep');
  });
});

describe('hub launcher check', () => {
  it('checks PowerShell processes and refuses an encoded command mentioning the hub', async () => {
    const run = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: 'absent', stderr: '' }).mockResolvedValueOnce({ exitCode: 0, stdout: 'present', stderr: '' });
    await expect(assertNoHubLaunchers(['C:\\Users\\me\\.azito\\hub'], run, 'C:\\Windows', 123)).rejects.toThrow(/launcher is still running/);
    expect(run).toHaveBeenCalledTimes(2);
    const spec = run.mock.calls[0]![0];
    const check = Buffer.from(spec.args.at(-1)!, 'base64').toString('utf16le');
    expect(check).toContain('C:\\Users\\me\\.azito\\hub');
    expect(check).toContain('FromBase64String');
    expect(check).toContain('OrdinalIgnoreCase');
    expect(check).toContain("IndexOf('$hubRoot'");
    expect(check).toContain('if ($p.Id -eq 123) { continue }');
    expect(check).toContain('throw "Cannot identify process $($p.Id)"');
    expect(check).not.toContain('if ($owner -ne $me) { continue }');
  });

  it('refuses when a process check fails or gives an unrecognised answer', async () => {
    const run = vi.fn().mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'unreadable' });
    await expect(assertNoHubLaunchers(['C:\\Users\\me\\.azito\\hub'], run, 'C:\\Windows', 123)).rejects.toThrow(/unreadable/);
    run.mockResolvedValueOnce({ exitCode: 0, stdout: 'unknown', stderr: '' });
    await expect(assertNoHubLaunchers(['C:\\Users\\me\\.azito\\hub'], run, 'C:\\Windows', 123)).rejects.toThrow(/Cannot determine/);
  });

  it('checks both literal and PowerShell-escaped path spellings', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'absent', stderr: '' });
    await assertNoHubLaunchers(["C:\\Users\\O'Brien\\.azito\\hub"], run, 'C:\\Windows', 123);
    const spec = run.mock.calls[0]![0];
    const check = Buffer.from(spec.args.at(-1)!, 'base64').toString('utf16le');
    expect(check).toContain("O''Brien");
    expect(check).toContain("O''''Brien");
  });
});

describe('unrecognised hub path check', () => {
  it('refuses a hub or an unreadable node process, excluding only the helper itself', async () => {
    const run = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: 'HUB 42', stderr: '' }).mockResolvedValueOnce({ exitCode: 0, stdout: 'UNKNOWN 43', stderr: '' });
    await expect(assertNoOtherHubProcesses('C:\\Users\\me\\.azito\\hub', run, 'C:\\Windows', 123)).rejects.toThrow(/hub process \(42\)/);
    await expect(assertNoOtherHubProcesses('C:\\Users\\me\\.azito\\hub', run, 'C:\\Windows', 123)).rejects.toThrow(/node process \(43\) could not be identified/);
    const spec = run.mock.calls[0]![0];
    const check = Buffer.from(spec.args.at(-1)!, 'base64').toString('utf16le');
    expect(check).toContain('$candidate.ProcessId -eq 123');
    expect(check).toContain('if (-not $candidate.CommandLine)');
    expect(check).toContain("$candidate.CommandLine -match '~[0-9]+'");
    expect(check).not.toContain("if ($owner -eq 'other') { continue }");
  });

  it('accepts only an explicit clear result', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'CLEAR', stderr: '' });
    await expect(assertNoOtherHubProcesses('C:\\Users\\me\\.azito\\hub', run, 'C:\\Windows', 123)).resolves.toBeUndefined();
  });
});
