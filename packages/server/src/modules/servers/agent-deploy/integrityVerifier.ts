import * as fs from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SAFE_PATH_RE = /^[a-zA-Z0-9._\-/~]+$/;

function assertSafeShellArg(value: string, label: string): void {
  if (!SAFE_PATH_RE.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function quotePath(p: string): string {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME/${p.slice(2)}"`;
  return `"${p}"`;
}

export function buildSha256VerifyCommand(filePath: string): string {
  assertSafeShellArg(filePath, 'filePath');
  const quoted = quotePath(filePath);
  return `(sha256sum ${quoted} 2>/dev/null || shasum -a 256 ${quoted}) | awk '{print $1}'`;
}

export function buildSafeExtractCommand(tarballPath: string, destDir: string): string {
  assertSafeShellArg(tarballPath, 'tarballPath');
  assertSafeShellArg(destDir, 'destDir');
  const parentDir = destDir.replace(/\/[^/]+\/?$/, '');
  const qTarball = quotePath(tarballPath);
  const qDest = quotePath(destDir);
  const qParent = quotePath(parentDir);
  return [
    'set -euo pipefail',
    `if tar tf ${qTarball} | grep -qE '(^|/)\\.\\.(/|$)'; then echo "TRAVERSAL_IN_ARCHIVE" >&2; exit 1; fi`,
    `mkdir -p ${qParent}`,
    `_tmpdir=$(mktemp -d ${qParent}/.extract-XXXXXX)`,
    'trap \'rm -rf "$_tmpdir"\' EXIT',
    `tar xzf ${qTarball} -C "$_tmpdir" --no-same-owner --no-same-permissions`,
    `mkdir -p ${qDest}`,
    `mv "$_tmpdir"/* ${qDest}/ && { mv "$_tmpdir"/.[!.]* ${qDest}/ 2>/dev/null || true; }`,
    `rm -f ${qTarball}`,
    'rm -rf "$_tmpdir"',
    'trap - EXIT',
  ].join('\n');
}

export function readSha256FromSumsFile(sumsFilePath: string, filename: string): string {
  const content = fs.readFileSync(sumsFilePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (match && match[2] === filename) {
      return match[1];
    }
  }
  throw new Error(`No SHA256 entry for "${filename}" in ${sumsFilePath}`);
}

/**
 * Local-process counterpart to buildSha256VerifyCommand — used when the hub
 * is verifying a download it fetched for itself (system update), rather than
 * a file staged on a remote agent host over SSH.
 */
export async function computeLocalSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Local-process counterpart to the traversal check embedded in
 * buildSafeExtractCommand — used ahead of extracting a downloaded tarball
 * in-process (no remote shell involved) for the system update flow.
 */
export async function assertNoTraversal(tarballPath: string): Promise<void> {
  const { stdout } = await execFileAsync('tar', ['tf', tarballPath]);
  for (const line of stdout.split('\n')) {
    const entry = line.trim();
    if (!entry) continue;
    if (/(^|\/)\.\.($|\/)/.test(entry)) {
      throw new Error(`Path traversal detected in archive: ${entry}`);
    }
  }
}
