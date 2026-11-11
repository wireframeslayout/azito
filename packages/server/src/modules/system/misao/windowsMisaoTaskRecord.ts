import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { SecretFileGuard } from '../../../shared/os/secretFileGuard';
import { readInstallFileIdentity } from '../windowsInstallInventory';

const identity = z.object({ device: z.string().regex(/^\d+$/), file: z.string().regex(/^\d+$/), created: z.string().regex(/^\d+$/) }).strict();
const schema = z.object({ version: z.literal(1), root: identity, release: z.string().regex(/^\d+\.\d+\.\d+$/), taskHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const recordPath = (root: string): string => path.join(root, '.install-task-owner.json');
export const misaoTaskHash = (xml: string): string => crypto.createHash('sha256').update(xml, 'utf8').digest('hex');

/** Call only while holding the misao lock after an absent task has been registered by this install. */
export function recordWindowsMisaoTask(root: string, release: string, xml: string, guard: SecretFileGuard): void {
  const target = recordPath(root);
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    guard.writeSecretFile(temporary, JSON.stringify({ version: 1, root: readInstallFileIdentity(root), release, taskHash: misaoTaskHash(xml) }));
    fs.linkSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readWindowsMisaoTaskRecord(root: string, guard: SecretFileGuard): z.infer<typeof schema> {
  const file = recordPath(root);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !guard.inspect(file, 'file').ok) throw new Error('The misao task ownership record is not protected.');
  return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}
