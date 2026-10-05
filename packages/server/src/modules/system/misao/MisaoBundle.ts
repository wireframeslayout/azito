import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  files: z.object({ 'misao.mjs': z.string(), 'LICENSES.txt': z.string() }),
});

/** The misao a hub release carries: `<bundle>/misao/{misao.mjs,LICENSES.txt,manifest.json}` plus the hub's own node-pty and deploy templates. */
export interface MisaoBundle {
  version: string;
  /** `<bundle>/misao` */
  dir: string;
  /** The hub's node-pty, shared with the daemon (copied next to each installed misao.mjs, which resolves it from there). */
  nodePtyDir: string;
  templatesDir: string;
  files: Record<'misao.mjs' | 'LICENSES.txt', string>;
  /** The sha256 of each file, from the manifest (checked against the files when the bundle is read). */
  sha256: Record<'misao.mjs' | 'LICENSES.txt', string>;
}

export function sha256Buffer(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file: string): string {
  return sha256Buffer(fs.readFileSync(file));
}

/**
 * Reads the misao bundled with the running hub release. Null when this hub carries none (a source checkout, or a
 * release older than the bundling): then nothing can be installed from here. A bundle that is present but corrupt
 * (manifest does not parse, a file is missing or does not match its sha256) throws — shipping a damaged daemon
 * to a service must fail loudly.
 */
export function readMisaoBundle(bundleRoot: string | null): MisaoBundle | null {
  if (!bundleRoot) return null;
  const dir = path.join(bundleRoot, 'misao');
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
  const files = { 'misao.mjs': path.join(dir, 'misao.mjs'), 'LICENSES.txt': path.join(dir, 'LICENSES.txt') };
  for (const name of ['misao.mjs', 'LICENSES.txt'] as const) {
    if (!fs.existsSync(files[name])) throw new Error(`The bundled misao is incomplete: ${files[name]} is missing`);
    if (sha256File(files[name]) !== manifest.files[name]) {
      throw new Error(`The bundled misao is damaged: ${files[name]} does not match its manifest sha256`);
    }
  }
  const nodePtyDir = path.join(bundleRoot, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDir)) throw new Error(`The hub bundle has no node-pty to share with misao: ${nodePtyDir}`);
  return { version: manifest.version, dir, nodePtyDir, templatesDir: path.join(bundleRoot, 'deploy'), files, sha256: manifest.files };
}
