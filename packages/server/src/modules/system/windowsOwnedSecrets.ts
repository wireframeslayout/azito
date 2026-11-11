import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { DataPaths } from '../../shared/dataDir';
import type { SecretFileGuard } from '../../shared/os/secretFileGuard';
import { readWindowsInstallRecord, type WindowsInstallRecord } from './windowsHubUninstall';
import { assertRealDirectoryChain, readInstallFileIdentity, installIdentitySchema, sameInstallFileIdentity, type InstallFileIdentity } from './windowsInstallInventory';

export const OWNED_SECRET_NAMES = ['master.key', 'vapid-keys.json', 'ui-token', 'webhook-token'] as const;
export type OwnedSecretName = typeof OWNED_SECRET_NAMES[number];
const CANARY_NAME = /^\.azito-hub-canary-[a-f0-9]{32}$/;
const isOwnedName = (name: string): boolean => (OWNED_SECRET_NAMES as readonly string[]).includes(name) || CANARY_NAME.test(name);

export function ownedSecretMarker(hubDir: string, name: string): string {
  if (!isOwnedName(name)) throw new Error('Not a recognised owned data file.');
  return path.join(hubDir, `.owned-data-${name}.json`);
}

const markerSchema = z.object({ version: z.literal(1), name: z.string().refine(isOwnedName), identity: installIdentitySchema, root: installIdentitySchema }).strict();

export function listOwnedDataNames(hubDir: string): string[] {
  const canaries = fs.readdirSync(hubDir).map((entry) => /^\.owned-data-(\.azito-hub-canary-[a-f0-9]{32})\.json$/.exec(entry)?.[1]).filter((name): name is string => name !== undefined);
  return [...OWNED_SECRET_NAMES, ...canaries];
}

/** Remove only protected markers that name this installation's recorded data root. */
export function removeOwnedDataMarkers(hubDir: string, record: WindowsInstallRecord, guard: SecretFileGuard): string[] {
  const retained: string[] = [];
  for (const name of listOwnedDataNames(hubDir)) {
    const marker = ownedSecretMarker(hubDir, name);
    try {
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || !guard.inspect(marker, 'file').ok) throw new Error('not a protected regular file');
      const saved = markerSchema.parse(JSON.parse(fs.readFileSync(marker, 'utf8')));
      if (saved.name !== name || !sameInstallFileIdentity(record.dataRootIdentity, saved.root)) throw new Error('not the recorded data root');
      fs.unlinkSync(marker);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') retained.push(path.basename(marker));
    }
  }
  return retained;
}

/** A missing marker means no ownership claim; a malformed or replaced marker is an error. */
export function readOwnedSecret(prefix: string, hubDir: string, name: string, record: WindowsInstallRecord, guard: SecretFileGuard): string | undefined {
  const marker = ownedSecretMarker(hubDir, name);
  if (!fs.existsSync(marker)) return undefined;
  const stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || !guard.inspect(marker, 'file').ok) throw new Error(`The ownership record for ${name} is not protected.`);
  const saved = markerSchema.parse(JSON.parse(fs.readFileSync(marker, 'utf8')));
  const data = path.join(prefix, 'data');
  assertRealDirectoryChain(data);
  const file = path.join(data, name);
  if (saved.name !== name || !sameInstallFileIdentity(record.dataRootIdentity, saved.root) || !sameInstallFileIdentity(saved.root, readInstallFileIdentity(data))) throw new Error(`The data directory for ${name} is not the recorded directory.`);
  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(file);
  } catch (err) {
    if (/^\.azito-hub-canary-[a-f0-9]{32}$/.test(name) && (err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || !sameInstallFileIdentity(saved.identity, readInstallFileIdentity(file)) || !guard.inspect(file, 'file').ok) throw new Error(`${name} is not the recorded protected file.`);
  return file;
}

function writeMarker(hubDir: string, name: string, identity: InstallFileIdentity, root: InstallFileIdentity, guard: SecretFileGuard): void {
  const target = ownedSecretMarker(hubDir, name);
  const temp = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    guard.writeSecretFile(temp, JSON.stringify({ version: 1, name, identity, root }));
    fs.linkSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

interface OwnedRoot { hubDir: string; dataDir: string; root: InstallFileIdentity }

function resolveOwnedRoot(base: SecretFileGuard, bundleRoot: string | null, paths: DataPaths, platform: NodeJS.Platform): OwnedRoot | undefined {
  if (platform !== 'win32' || bundleRoot === null) return undefined;
  const hubDir = path.dirname(bundleRoot);
  const dataDir = path.join(path.dirname(hubDir), 'data');
  if (path.resolve(paths.dir).toLowerCase() !== path.resolve(dataDir).toLowerCase()) return undefined;
  if (!fs.existsSync(path.join(hubDir, '.install-record.json'))) return undefined;
  try {
    const record = readWindowsInstallRecord(hubDir, base);
    const root = readInstallFileIdentity(dataDir);
    if (record.consumed || !sameInstallFileIdentity(record.dataRootIdentity, root) || !base.inspect(dataDir, 'dir').ok) return undefined;
    return { hubDir, dataDir, root };
  } catch (err) {
    console.warn(`[azito] Cannot track newly created data files: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Returns an observer for canaries created exclusively by the hub, or undefined for unrecorded data. */
export function createOwnedCanaryRecorder(base: SecretFileGuard, bundleRoot: string | null, paths: DataPaths, platform: NodeJS.Platform): ((file: string) => void) | undefined {
  const context = resolveOwnedRoot(base, bundleRoot, paths, platform);
  if (!context) return undefined;
  return (file) => {
    const name = path.basename(file);
    if (!CANARY_NAME.test(name) || path.resolve(path.dirname(file)).toLowerCase() !== path.resolve(context.dataDir).toLowerCase()) return;
    try {
      const current = readWindowsInstallRecord(context.hubDir, base);
      if (current.consumed || !sameInstallFileIdentity(current.dataRootIdentity, context.root)) return;
      if (!sameInstallFileIdentity(context.root, readInstallFileIdentity(context.dataDir)) || !base.inspect(file, 'file').ok) throw new Error('The data directory or file is not protected.');
      writeMarker(context.hubDir, name, readInstallFileIdentity(file), context.root, base);
    } catch (err) {
      console.warn(`[azito] Could not record ownership of ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** Track only secrets exclusively created in the recorded data directory; existing user files are never claimed. */
export function trackWindowsOwnedSecrets(base: SecretFileGuard, bundleRoot: string | null, paths: DataPaths, platform: NodeJS.Platform): SecretFileGuard {
  const context = resolveOwnedRoot(base, bundleRoot, paths, platform);
  if (!context) return base;
  const { hubDir, dataDir, root } = context;
  const names = new Set<string>(OWNED_SECRET_NAMES);
  const write = (file: string, content: string): void => {
    const name = path.basename(file);
    if (!names.has(name) || path.resolve(path.dirname(file)).toLowerCase() !== path.resolve(dataDir).toLowerCase()) {
      base.writeSecretFile(file, content);
      return;
    }
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing !== undefined) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`${file} is not a regular file.`);
      base.writeSecretFile(file, content);
      return;
    }
    const temporary = path.join(dataDir, `.${name}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let linked = false;
    try {
      try {
        base.writeSecretFile(temporary, content);
      } catch (err) {
        if (fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined) throw err;
        console.warn(`[azito] Could not record ownership of ${file}; it will be retained on uninstall: ${err instanceof Error ? err.message : String(err)}`);
        base.writeSecretFile(file, content);
        return;
      }
      try {
        fs.linkSync(temporary, file);
        linked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST' || fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined) throw err;
        console.warn(`[azito] Could not record ownership of ${file}; it will be retained on uninstall: ${err instanceof Error ? err.message : String(err)}`);
        base.writeSecretFile(file, content);
      }
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch (err) {
        console.warn(`[azito] Could not remove protected temporary file ${temporary}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!linked) return;
    try {
      const current = readWindowsInstallRecord(hubDir, base);
      if (current.consumed || !sameInstallFileIdentity(current.dataRootIdentity, root)) return;
      writeMarker(hubDir, name as OwnedSecretName, readInstallFileIdentity(file), root, base);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') console.warn(`[azito] Could not record ownership of ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    policyDescription: base.policyDescription,
    ensureProtectedDir: (dir) => base.ensureProtectedDir(dir),
    writeSecretFile: write,
    appendSecretFile: (file, content) => base.appendSecretFile(file, content),
    protectFile: (file) => base.protectFile(file),
    repairFile: (file) => base.repairFile(file),
    prepareFile: (file) => base.prepareFile(file),
    inspect: (target, kind) => base.inspect(target, kind),
  };
}
