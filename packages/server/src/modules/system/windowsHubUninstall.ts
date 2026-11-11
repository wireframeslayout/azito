import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import type { SecretFileGuard } from '../../shared/os/secretFileGuard';
import { assertRealDirectoryChain, hashInstallFile, readInstallInventory } from './windowsInstallInventory';
import { isReleaseTag } from './hubVersion';
import { assertHubDirsOnlyOwnerWritable, removeFolderWithRd } from './windowsHubFolderOps';
import type { SpecRunner } from './windowsHubService';
import { whyAFileIsHeld } from './windowsHubPrune';

const fileSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const recordSchema = z.object({
  version: z.literal(1),
  consumed: z.boolean(),
  release: z.string().refine(isReleaseTag),
  inventory: z.object({ directories: z.array(z.string()), files: z.array(fileSchema) }).strict(),
  wrapperSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  pathAdded: z.boolean(),
  dataInventory: z.object({ directories: z.array(z.string()), files: z.array(fileSchema) }).strict().nullable(),
}).strict();

export type WindowsInstallRecord = z.infer<typeof recordSchema>;

/** Reads an owner-protected record only after rejecting links in its containing path. */
export function readWindowsInstallRecord(hubDir: string, guard: SecretFileGuard): WindowsInstallRecord {
  assertRealDirectoryChain(hubDir);
  const file = path.join(hubDir, '.install-record.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The installation record is not a regular file.');
  const inspection = guard.inspect(file, 'file');
  if (!inspection.ok) throw new Error(`The installation record is not owner-protected: ${inspection.summary}`);
  return recordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Refuses changed, missing, or additional entries; the release is kept whole. */
export function verifyRecordedRelease(hubDir: string, record: WindowsInstallRecord): string {
  const release = path.join(hubDir, record.release);
  const actual = readInstallInventory(release);
  if (JSON.stringify(actual) !== JSON.stringify(record.inventory)) throw new Error('The release contents differ from the installation record. Nothing in it is removed.');
  return release;
}

export function verifyRecordedWrapper(prefix: string, record: WindowsInstallRecord): boolean {
  if (record.wrapperSha256 === null) return false;
  const bin = path.join(prefix, 'bin');
  assertRealDirectoryChain(bin);
  const wrapper = path.join(bin, 'azito.cmd');
  const stat = fs.lstatSync(wrapper);
  return stat.isFile() && !stat.isSymbolicLink() && hashInstallFile(wrapper) === record.wrapperSha256;
}

export function verifyRecordedData(prefix: string, record: WindowsInstallRecord): string {
  if (record.dataInventory === null) throw new Error('This installer did not create the data directory; it is retained.');
  const data = path.join(prefix, 'data');
  if (JSON.stringify(readInstallInventory(data)) !== JSON.stringify(record.dataInventory)) {
    throw new Error('The data contents differ from the installation record; the directory is retained.');
  }
  return data;
}

/** Check the directory access lists before trusting the record and again before returning a removal candidate. */
export async function prepareRecordedRelease(prefix: string, guard: SecretFileGuard, run: SpecRunner, systemRoot: string): Promise<{ record: WindowsInstallRecord; release: string }> {
  const hubDir = path.join(prefix, 'hub');
  assertRealDirectoryChain(hubDir);
  await assertHubDirsOnlyOwnerWritable(run, systemRoot, [path.dirname(prefix)], true);
  await assertHubDirsOnlyOwnerWritable(run, systemRoot, [prefix, hubDir]);
  const record = readWindowsInstallRecord(hubDir, guard);
  if (record.consumed) throw new Error('A previous uninstall started removing items. Inspect the retained files and PATH manually.');
  const release = verifyRecordedRelease(hubDir, record);
  const dirs = [release, ...record.inventory.directories.map((dir) => path.join(release, dir))];
  await assertHubDirsOnlyOwnerWritable(run, systemRoot, dirs);
  verifyRecordedRelease(hubDir, record);
  return { record, release };
}

/** Mark the record before any removal; a partial run can never claim an item that was recreated later. */
export function consumeWindowsInstallRecord(hubDir: string, record: WindowsInstallRecord, guard: SecretFileGuard): void {
  const target = path.join(hubDir, '.install-record.json');
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    guard.writeSecretFile(temporary, JSON.stringify({ ...record, consumed: true }));
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function prepareRecordedData(prefix: string, record: WindowsInstallRecord, run: SpecRunner, systemRoot: string): Promise<string> {
  const data = verifyRecordedData(prefix, record);
  const dirs = [data, ...record.dataInventory!.directories.map((dir) => path.join(data, dir))];
  await assertHubDirsOnlyOwnerWritable(run, systemRoot, dirs);
  return verifyRecordedData(prefix, record);
}

/** Isolate a verified tree before removing it with the same Windows rd operation used by pruning. */
export async function removeRecordedTree(parent: string, name: string, run: SpecRunner, systemRoot: string): Promise<void> {
  const target = path.join(parent, name);
  const held = whyAFileIsHeld(target);
  if (held !== undefined) throw new Error(`${target}: ${held}; nothing was removed`);
  const isolated = `.uninstall-${crypto.randomBytes(8).toString('hex')}`;
  const isolatedPath = path.join(parent, isolated);
  fs.renameSync(target, isolatedPath);
  try {
    await removeFolderWithRd(run, systemRoot, parent, isolated, fs.existsSync);
  } catch (err) {
    throw new Error(`Removal failed; inspect ${isolatedPath} manually: ${err instanceof Error ? err.message : String(err)}`);
  }
}
