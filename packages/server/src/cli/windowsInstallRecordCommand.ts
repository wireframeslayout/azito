import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SecretFileGuard } from '../shared/os/secretFileGuard';
import { hashInstallFile, readInstallFileIdentity, readInstallInventory } from '../modules/system/windowsInstallInventory';
import { isReleaseTag } from '../modules/system/hubVersion';
import { bundleFilesFor, readMisaoBundle } from '../modules/system/misao/MisaoBundle';
import { MISAO_RELEASE_FILE_NAMES, misaoFileNameOn } from '../modules/servers/transport/agentMisaoSocket';
import { readWindowsMisaoTaskRecord } from '../modules/system/misao/windowsMisaoTaskRecord';

/** Records only a fresh installation; an existing record is never replaced by a retry. */
export function windowsInstallRecordCommand(bundleRoot: string | null, argv: string[], guard: SecretFileGuard, platform: NodeJS.Platform): void {
  if (platform !== 'win32' || bundleRoot === null) throw new Error('The installation record requires a Windows release bundle.');
  const allowed = new Set(['--path-added', '--wrapper-created', '--data-created', '--misao-created']);
  if (argv.some((arg) => !allowed.has(arg)) || new Set(argv).size !== argv.length) throw new Error('Invalid installation record options.');
  const version = path.basename(bundleRoot);
  const hubDir = path.dirname(bundleRoot);
  if (!isReleaseTag(version) || path.basename(hubDir).toLowerCase() !== 'hub') throw new Error('The bundle is not in a release install.');
  const prefix = path.dirname(hubDir);
  const recordPath = path.join(hubDir, '.install-record.json');
  if (fs.existsSync(recordPath)) return;
  const wrapper = path.join(prefix, 'bin', 'azito.cmd');
  const data = path.join(prefix, 'data');
  const db = path.join(data, 'data.db');
  let dbCreated = false;
  if (argv.includes('--data-created') && !fs.existsSync(db)) {
    fs.closeSync(fs.openSync(db, 'wx'));
    guard.protectFile(db);
    dbCreated = true;
  }
  const misaoRoot = path.join(prefix, 'misao');
  let misao: { version: string; rootIdentity: ReturnType<typeof readInstallFileIdentity>; currentIdentity: ReturnType<typeof readInstallFileIdentity>; releaseIdentity: ReturnType<typeof readInstallFileIdentity>; taskHash: string; inventory: ReturnType<typeof readInstallInventory>; fileIdentities: Array<{ path: string; identity: ReturnType<typeof readInstallFileIdentity> }> } | null = null;
  if (argv.includes('--misao-created')) {
    try {
      const current = path.join(misaoRoot, 'current');
      const misaoVersion = fs.readFileSync(current, 'utf8').trim();
      if (!isReleaseTag(misaoVersion)) throw new Error('The new misao current file does not contain a release tag.');
      const task = readWindowsMisaoTaskRecord(misaoRoot, guard);
      const rootIdentity = readInstallFileIdentity(misaoRoot);
      if (task.release !== misaoVersion || rootIdentity.file === '0' || JSON.stringify(task.root) !== JSON.stringify(rootIdentity)) throw new Error('The misao task ownership record does not match this release and folder.');
      const inventory = readInstallInventory(path.join(misaoRoot, misaoVersion));
      const bundle = readMisaoBundle(bundleRoot);
      if (!bundle || bundle.version !== misaoVersion || inventory.directories.length !== 0 || inventory.files.length !== MISAO_RELEASE_FILE_NAMES.length) throw new Error('The new misao release is not exactly the bundled release.');
      const expected = bundleFilesFor(bundle, 'win32', 'x64').sha256;
      if (MISAO_RELEASE_FILE_NAMES.some((name) => !inventory.files.some((file) => file.path === misaoFileNameOn('win32', name) && file.sha256 === expected[name]))) throw new Error('The new misao files do not match the bundle.');
      const releaseDir = path.join(misaoRoot, misaoVersion);
      misao = { version: misaoVersion, rootIdentity, currentIdentity: readInstallFileIdentity(current), releaseIdentity: readInstallFileIdentity(releaseDir), taskHash: task.taskHash, inventory, fileIdentities: inventory.files.map((file) => ({ path: file.path, identity: readInstallFileIdentity(path.join(releaseDir, file.path)) })) };
    } catch (err) {
      console.log(`misao ownership was not recorded; it will be retained on uninstall: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const record = {
    version: 1,
    consumed: false,
    release: version,
    inventory: readInstallInventory(bundleRoot),
    wrapperSha256: argv.includes('--wrapper-created') ? hashInstallFile(wrapper) : null,
    pathAdded: argv.includes('--path-added'),
    dataInventory: argv.includes('--data-created') ? readInstallInventory(data) : null,
    dataRootIdentity: argv.includes('--data-created') ? readInstallFileIdentity(data) : null,
    dbIdentity: dbCreated ? readInstallFileIdentity(db) : null,
    misao,
  };
  const temporary = `${recordPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    guard.writeSecretFile(temporary, JSON.stringify(record));
    fs.linkSync(temporary, recordPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
