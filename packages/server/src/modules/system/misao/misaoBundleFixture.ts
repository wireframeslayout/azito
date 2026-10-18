import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { MISAO_RELEASE_FILES } from '../../servers/transport/agentMisaoSocket';
import { MISAO_TARGETS } from './MisaoBundle';

/** Test support: a hub bundle on disk (`misao/<target>/...` for every target, its manifest, the real deploy templates). */

const REPO_DEPLOY_DIR = path.resolve(__dirname, '../../../../../../deploy');

export function sha256Text(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** What the fake binary of a target contains: `binary` is the same for every target except for a marker line. */
export function fakeBinaryFor(target: string, binary: string): string {
  return `${binary}\n// target ${target}\n`;
}

/**
 * Writes the bundle. `binary` is the content of every target's `misao`. A string (a script a test can really execute when
 * it starts with a shebang) gets a per-target trailing comment, so a test can tell which one was installed; a Buffer (a
 * real binary) is written as it is.
 */
export function writeHubBundle(root: string, version: string, binary: string | Buffer): void {
  const manifest: { version: string; targets: Record<string, Record<string, string>> } = { version, targets: {} };
  for (const target of MISAO_TARGETS) {
    const dir = path.join(root, 'misao', target);
    fs.mkdirSync(dir, { recursive: true });
    const contents: Record<string, string | Buffer> = {
      misao: typeof binary === 'string' ? fakeBinaryFor(target, binary) : binary,
      LICENSE: 'license\n',
      NOTICE: 'notice\n',
      'THIRD-PARTY-LICENSES.txt': 'third party\n',
    };
    manifest.targets[target] = {};
    for (const [name, mode] of Object.entries(MISAO_RELEASE_FILES)) {
      fs.writeFileSync(path.join(dir, name), contents[name], { mode });
      manifest.targets[target][name] = sha256Text(contents[name]);
    }
  }
  fs.writeFileSync(path.join(root, 'misao', 'manifest.json'), JSON.stringify(manifest));
  fs.cpSync(REPO_DEPLOY_DIR, path.join(root, 'deploy'), { recursive: true });
}
