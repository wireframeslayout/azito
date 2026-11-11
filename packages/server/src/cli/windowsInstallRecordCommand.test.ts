import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { UnixSecretFileGuard } from '../shared/os/secretFileGuard';
import { readInstallFileIdentity } from '../modules/system/windowsInstallInventory';
import { windowsInstallRecordCommand } from './windowsInstallRecordCommand';
import { writeHubBundle } from '../modules/system/misao/misaoBundleFixture';
import { MISAO_RELEASE_FILE_NAMES, misaoFileNameOn } from '../modules/servers/transport/agentMisaoSocket';
import { recordWindowsMisaoTask } from '../modules/system/misao/windowsMisaoTaskRecord';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-record-'));
  roots.push(root);
  const bundle = path.join(root, 'hub', 'v1.2.3');
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(bundle, 'node.exe'), 'bundle');
  return { root, bundle, guard: new UnixSecretFileGuard() };
}

describe('Windows installation record', () => {
  it('creates and records the database only in a newly created data directory', () => {
    const { root, bundle, guard } = setup();
    windowsInstallRecordCommand(bundle, ['--data-created'], guard, 'win32');
    const record = JSON.parse(fs.readFileSync(path.join(root, 'hub', '.install-record.json'), 'utf8'));
    expect(fs.statSync(path.join(root, 'data', 'data.db')).size).toBe(0);
    expect(record.dbIdentity.file).not.toBe('0');
    expect(record.dataRootIdentity).not.toBeNull();
    const db = new Database(path.join(root, 'data', 'data.db'));
    db.exec('CREATE TABLE example (id INTEGER PRIMARY KEY)');
    db.close();
    expect(readInstallFileIdentity(path.join(root, 'data', 'data.db'))).toEqual(record.dbIdentity);
  });

  it('does not claim an existing database or overwrite an existing record', () => {
    const { root, bundle, guard } = setup();
    const db = path.join(root, 'data', 'data.db');
    fs.writeFileSync(db, 'user data');
    windowsInstallRecordCommand(bundle, ['--data-created'], guard, 'win32');
    const file = path.join(root, 'hub', '.install-record.json');
    const before = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(before).dbIdentity).toBeNull();
    windowsInstallRecordCommand(bundle, ['--path-added'], guard, 'win32');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readFileSync(db, 'utf8')).toBe('user data');
  });

  it('records a newly created misao release and its pointer', () => {
    const { root, bundle, guard } = setup();
    writeHubBundle(bundle, '1.2.3', 'fake binary');
    const misao = path.join(root, 'misao');
    fs.mkdirSync(path.join(misao, '1.2.3'), { recursive: true });
    fs.writeFileSync(path.join(misao, 'current'), '1.2.3\n');
    for (const name of MISAO_RELEASE_FILE_NAMES) {
      const file = misaoFileNameOn('win32', name);
      fs.copyFileSync(path.join(bundle, 'misao', 'x86_64-pc-windows-msvc', file), path.join(misao, '1.2.3', file));
    }
    recordWindowsMisaoTask(misao, '1.2.3', '<Task />', guard);
    windowsInstallRecordCommand(bundle, ['--misao-created'], guard, 'win32');
    const record = JSON.parse(fs.readFileSync(path.join(root, 'hub', '.install-record.json'), 'utf8'));
    expect(record.misao.version).toBe('1.2.3');
    expect(record.misao.inventory.files.map((entry: { path: string }) => entry.path).sort()).toEqual(MISAO_RELEASE_FILE_NAMES.map((name) => misaoFileNameOn('win32', name)).sort());
  });

  it('records the hub but does not claim a misao release with user files', () => {
    const { root, bundle, guard } = setup();
    writeHubBundle(bundle, '1.2.3', 'fake binary');
    const misao = path.join(root, 'misao');
    fs.mkdirSync(path.join(misao, '1.2.3'), { recursive: true });
    fs.writeFileSync(path.join(misao, 'current'), '1.2.3');
    for (const name of MISAO_RELEASE_FILE_NAMES) {
      const file = misaoFileNameOn('win32', name);
      fs.copyFileSync(path.join(bundle, 'misao', 'x86_64-pc-windows-msvc', file), path.join(misao, '1.2.3', file));
    }
    recordWindowsMisaoTask(misao, '1.2.3', '<Task />', guard);
    fs.writeFileSync(path.join(misao, '1.2.3', 'user-file'), 'keep');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      windowsInstallRecordCommand(bundle, ['--misao-created'], guard, 'win32');
      const record = JSON.parse(fs.readFileSync(path.join(root, 'hub', '.install-record.json'), 'utf8'));
      expect(record.misao).toBeNull();
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('does not claim misao without a recorded task creation', () => {
    const { root, bundle, guard } = setup();
    fs.mkdirSync(path.join(root, 'misao'), { recursive: true });
    fs.writeFileSync(path.join(root, 'misao', 'current'), '1.2.3');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      windowsInstallRecordCommand(bundle, ['--misao-created'], guard, 'win32');
      const record = JSON.parse(fs.readFileSync(path.join(root, 'hub', '.install-record.json'), 'utf8'));
      expect(record.misao).toBeNull();
    } finally { log.mockRestore(); }
  });
});
