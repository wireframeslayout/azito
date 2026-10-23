import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hostTar } from './archive';

async function fetchBuffer(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`could not download ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The sha256 `SHASUMS256.txt` (`<hash>  <file name>` per line) lists for `fileName`; a missing entry is an error. */
export function expectedNodeSha256(shasums: string, fileName: string): string {
  for (const line of shasums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === fileName && hash) return hash;
  }
  throw new Error(`could not find the SHA256 of ${fileName} in SHASUMS256.txt`);
}

/**
 * Stages the official Node.js for Windows x64 as `<stageDir>/node.exe`. The zip is checked against nodejs.org's
 * `SHASUMS256.txt` of the same release, like download-node.sh does for the Unix tarballs. This is TypeScript rather than a
 * second shell script because a Windows build host has no guaranteed curl / sha256sum / unzip, while Node's `fetch`,
 * `crypto` and the OS's tar.exe are always there.
 */
export async function stageNodeWin32(nodeVersion: string, stageDir: string): Promise<void> {
  const fileName = `node-${nodeVersion}-win-x64.zip`;
  const base = `https://nodejs.org/dist/${nodeVersion}`;
  const [zip, shasums] = await Promise.all([fetchBuffer(`${base}/${fileName}`), fetchBuffer(`${base}/SHASUMS256.txt`)]);

  const expected = expectedNodeSha256(shasums.toString('utf-8'), fileName);
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-node-'));
  try {
    const archive = path.join(tmp, fileName);
    fs.writeFileSync(archive, zip);
    const member = `node-${nodeVersion}-win-x64/node.exe`;
    execFileSync(hostTar(), ['-xf', archive, '-C', tmp, member]);
    fs.mkdirSync(stageDir, { recursive: true });
    fs.copyFileSync(path.join(tmp, member), path.join(stageDir, 'node.exe'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
