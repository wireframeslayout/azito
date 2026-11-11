import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SecretFileGuard } from '../shared/os/secretFileGuard';
import { hashInstallFile, readInstallFileIdentity, readInstallInventory } from '../modules/system/windowsInstallInventory';
import { isReleaseTag } from '../modules/system/hubVersion';

/** Records only a fresh installation; an existing record is never replaced by a retry. */
export function windowsInstallRecordCommand(bundleRoot: string | null, argv: string[], guard: SecretFileGuard, platform: NodeJS.Platform): void {
  if (platform !== 'win32' || bundleRoot === null) throw new Error('The installation record requires a Windows release bundle.');
  const allowed = new Set(['--path-added', '--wrapper-created', '--data-created']);
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
  };
  const temporary = `${recordPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    guard.writeSecretFile(temporary, JSON.stringify(record));
    fs.linkSync(temporary, recordPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
