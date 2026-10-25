import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SecretFileGuard } from '../../../shared/os/secretFileGuard';

/** The secret that makes the name of a misao folder's lock pipe unguessable: owner-only, inside the folder. */
export const LOCK_KEY_FILE = '.lock-key';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The lock key of a misao folder: 32 random bytes in `<root>\.lock-key`, written through the secret-file guard (owner-only ACL before any
 * content). A named pipe can be created by any user on the machine, so a lock named by the folder alone could be taken first by another
 * user, which would keep the watchdog from ever reviving the daemon; with the key in the name, only a user who can read the file can
 * name the pipe. The key is made once, atomically (written beside under a random name, then hard-linked into place: of several creators
 * exactly one link succeeds and all of them read that one), and checked on every use: a file that is not owner-only, or does not hold a key,
 * fails with the reason. It is never replaced by "no key".
 */
export function readOrCreateLockKey(root: string, guard: SecretFileGuard): string {
  const file = path.join(root, LOCK_KEY_FILE);
  if (!fs.existsSync(file)) createExclusively(file, guard);
  const verdict = guard.inspect(file, 'file');
  if (!verdict.ok) throw new Error(`The lock key ${file} is not private to this user (${verdict.summary}). ${verdict.fix}`);
  const key = fs.readFileSync(file, 'utf-8').trim();
  if (!KEY_PATTERN.test(key)) throw new Error(`${file} does not hold a lock key. Delete it and a new one is made.`);
  return key;
}

function createExclusively(file: string, guard: SecretFileGuard): void {
  const beside = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  guard.writeSecretFile(beside, randomBytes(32).toString('hex'));
  try {
    fs.linkSync(beside, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // another creator was first: its key is the one
  } finally {
    fs.rmSync(beside, { force: true });
  }
}
