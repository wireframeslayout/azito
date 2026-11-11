import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import type { SecretFileGuard } from '../../shared/os/secretFileGuard';
import { assertRealDirectoryChain, hashInstallFile, readInstallFileIdentity, readInstallInventory, type InstallFileIdentity } from './windowsInstallInventory';
import { isReleaseTag } from './hubVersion';
import { assertHubDirsOnlyOwnerWritable, removeFolderWithRd } from './windowsHubFolderOps';
import { windowsPowershell, type SpecRunner } from './windowsHubService';
import { whyAFileIsHeld } from './windowsHubPrune';
import { buildCommandSpec } from '../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../shared/os/shellDialect';
import { buildProcessPresentScript, parseProcessPresent } from '../../shared/os/windowsProcessSweep';
import { misaoHubScript, parseMisaoGuardOutput } from '../servers/agent-deploy/windowsAgentOwnership';

const fileSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const identitySchema = z.object({ device: z.string().regex(/^\d+$/), file: z.string().regex(/^\d+$/), created: z.string().regex(/^\d+$/) }).strict();
const recordSchema = z.object({
  version: z.literal(1),
  consumed: z.boolean(),
  release: z.string().refine(isReleaseTag),
  inventory: z.object({ directories: z.array(z.string()), files: z.array(fileSchema) }).strict(),
  wrapperSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  pathAdded: z.boolean(),
  dataInventory: z.object({ directories: z.array(z.string()), files: z.array(fileSchema) }).strict().nullable(),
  dataRootIdentity: identitySchema.nullable(),
  dbIdentity: identitySchema.nullable(),
  misao: z.object({ version: z.string().refine(isReleaseTag), rootIdentity: identitySchema, currentIdentity: identitySchema, releaseIdentity: identitySchema, taskHash: z.string().regex(/^[a-f0-9]{64}$/), inventory: z.object({ directories: z.array(z.string()), files: z.array(fileSchema) }).strict(), fileIdentities: z.array(z.object({ path: z.string(), identity: identitySchema }).strict()) }).strict().nullable().optional(),
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
  if (!sameFile(record.dataRootIdentity, readInstallFileIdentity(data))) throw new Error('The data directory is not the recorded directory.');
  if (record.dataInventory.directories.length !== 0 || record.dataInventory.files.length !== 1 || record.dataInventory.files[0]?.path !== 'data.db'
    || !sameFile(record.dbIdentity, readInstallFileIdentity(path.join(data, 'data.db')))) throw new Error('The data directory contains items whose identity was not recorded.');
  if (JSON.stringify(readInstallInventory(data)) !== JSON.stringify(record.dataInventory)) {
    throw new Error('The data contents differ from the installation record; the directory is retained.');
  }
  return data;
}

function sameFile(expected: InstallFileIdentity | null, actual: InstallFileIdentity): boolean {
  return expected !== null && expected.file !== '0' && expected.created !== '0'
    && expected.device === actual.device && expected.file === actual.file && expected.created === actual.created;
}

/** The database may change contents; a replacement, link, or changed data root is not the recorded file. */
export function verifyRecordedDatabase(prefix: string, record: WindowsInstallRecord, guard: SecretFileGuard): string {
  const data = path.join(prefix, 'data');
  assertRealDirectoryChain(data);
  if (!sameFile(record.dataRootIdentity, readInstallFileIdentity(data))) throw new Error('The data directory is not the recorded directory.');
  const db = path.join(data, 'data.db');
  const stat = fs.lstatSync(db);
  if (!stat.isFile() || stat.isSymbolicLink() || !sameFile(record.dbIdentity, readInstallFileIdentity(db))) throw new Error('The database is not the recorded file.');
  if (!guard.inspect(db, 'file').ok) throw new Error('The database is not owner-protected.');
  return db;
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

export async function prepareRecordedData(prefix: string, record: WindowsInstallRecord, guard: SecretFileGuard, run: SpecRunner, systemRoot: string): Promise<string> {
  verifyRecordedDatabase(prefix, record, guard);
  const data = verifyRecordedData(prefix, record);
  const dirs = [data, ...record.dataInventory!.directories.map((dir) => path.join(data, dir))];
  await assertHubDirsOnlyOwnerWritable(run, systemRoot, dirs);
  return verifyRecordedData(prefix, record);
}

/** Verify the exact misao release and pointer made by the installer, not later updates. */
export async function prepareRecordedMisao(prefix: string, record: WindowsInstallRecord, guard: SecretFileGuard, run: SpecRunner, systemRoot: string): Promise<{ root: string; version: string }> {
  if (!record.misao) throw new Error('This installer did not record creating misao.');
  const root = path.join(prefix, 'misao');
  assertRealDirectoryChain(root);
  await assertHubDirsOnlyOwnerWritable(run, systemRoot, [root]);
  const saved = record.misao;
  if (!sameFile(saved.rootIdentity, readInstallFileIdentity(root))) throw new Error('The misao directory is not the recorded directory.');
  verifyRecordedMisaoPointer(prefix, record, guard);
  const release = path.join(root, saved.version);
  if (!sameFile(saved.releaseIdentity, readInstallFileIdentity(release))) throw new Error('The misao release directory is not the recorded directory.');
  const actual = readInstallInventory(release);
  if (JSON.stringify(actual) !== JSON.stringify(saved.inventory)) throw new Error('The misao release differs from its installation record.');
  if (actual.directories.length !== 0 || saved.fileIdentities.length !== actual.files.length) throw new Error('The misao file identities are incomplete.');
  await assertHubDirsOnlyOwnerWritable(run, systemRoot, [release, ...actual.directories.map((dir) => path.join(release, dir))]);
  for (const file of actual.files) {
    const full = path.join(release, file.path);
    const identity = saved.fileIdentities.find((entry) => entry.path === file.path)?.identity;
    if (!identity || !sameFile(identity, readInstallFileIdentity(full)) || !guard.inspect(full, 'file').ok) throw new Error(`The misao file ${file.path} is not the recorded protected file.`);
  }
  if (JSON.stringify(readInstallInventory(release)) !== JSON.stringify(saved.inventory)) throw new Error('The misao release changed during verification.');
  return { root, version: saved.version };
}

export function verifyRecordedMisaoPointer(prefix: string, record: WindowsInstallRecord, guard: SecretFileGuard): string {
  if (!record.misao) throw new Error('This installer did not record creating misao.');
  const root = path.join(prefix, 'misao');
  const saved = record.misao;
  assertRealDirectoryChain(root);
  if (!sameFile(saved.rootIdentity, readInstallFileIdentity(root))) throw new Error('The misao directory is not the recorded directory.');
  const current = path.join(root, 'current');
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.isSymbolicLink() || !sameFile(saved.currentIdentity, readInstallFileIdentity(current)) || !guard.inspect(current, 'file').ok
    || fs.readFileSync(current, 'utf8').trim() !== saved.version) throw new Error('The misao pointer is not the recorded file.');
  return current;
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

/** A launcher can outlive a manually deleted task and later start another hub. Never stop it here. */
export async function assertNoHubLaunchers(hubRoots: readonly string[], run: SpecRunner, systemRoot: string, callerPid: number): Promise<void> {
  const mentions = hubRoots.flatMap((root) => [root, powershellDialect.quote(root).slice(1, -1)]);
  for (const image of ['powershell.exe', 'pwsh.exe']) {
    const check = buildProcessPresentScript(image, '', mentions, callerPid);
    const result = await run(buildCommandSpec(windowsPowershell(systemRoot), powershellEncodedArgs(check), { timeoutMs: 60_000 }));
    if (result.exitCode !== 0) throw new Error(`Could not inspect hub launchers: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
    if (parseProcessPresent(result.stdout)) throw new Error('A hub launcher is still running. Stop it and inspect the retained files.');
  }
}

/** An unrecognised spelling may name this install, so leave data intact while any other hub may be running. */
export async function assertNoOtherHubProcesses(hubRoot: string, run: SpecRunner, systemRoot: string, excludePid: number): Promise<void> {
  const check = misaoHubScript({ root: hubRoot, hubRoot: undefined, looksForHub: true, excludePid, strictUnknown: true });
  const result = await run(buildCommandSpec(windowsPowershell(systemRoot), powershellEncodedArgs(check), { timeoutMs: 60_000 }));
  if (result.exitCode !== 0) throw new Error(`Could not inspect hub processes: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  const answer = parseMisaoGuardOutput(result.stdout);
  if (answer.kind === 'hub') throw new Error(`A hub process (${answer.pid}) may use this installation; stop it before uninstalling.`);
  if (answer.kind === 'unknown') throw new Error(`A node process (${answer.pid}) could not be identified; nothing is removed.`);
  if (answer.kind !== 'clear') throw new Error('A process could not be identified; nothing is removed.');
}
