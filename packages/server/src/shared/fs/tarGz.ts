import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * A `.tar.gz` written and read in Node, with the mode of every entry stated by the caller.
 *
 * The hub sends archives to hosts of another OS (the agent bundle, the harness, the sidekick packages). Building them with the
 * host's `tar` copies whatever mode the hub's file system reports, and a Windows or an exFAT volume reports none (0666 for
 * everything), so a script comes out of it without its execute bit. Here the mode is an input, so the archive is the same
 * on every hub.
 */

export interface TarEntry {
  /** Forward-slash path inside the archive, no leading `/` or `./`. */
  path: string;
  type: 'file' | 'directory';
  /** Permission bits only (e.g. 0o755). */
  mode: number;
  /** Contents of a file; absent for a directory. */
  data?: Buffer;
}

export interface TreeOptions {
  /** True for an entry name (a file or a folder) that is left out together with everything under it. */
  exclude?: (name: string) => boolean;
  /** Permission bits of a file (`relPath` is forward-slash and relative to the tree's root, its contents are given for a `#!` test). */
  fileMode: (relPath: string, data: Buffer) => number;
  directoryMode: number;
  /** Put the entries under this folder name (the tree's own name, say); empty for the tree's root. */
  prefix?: string;
}

const BLOCK = 512;

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`tar: "${value}" does not fit a ${length}-byte header field`);
  bytes.copy(header, offset);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new Error(`tar: ${value} does not fit a ${length}-byte header field`);
  header.write(text, offset, 'ascii');
}

function buildHeader(name: string, typeflag: string, mode: number, size: number, mtimeSec: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSec);
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

function padTo(data: Buffer): Buffer {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

/** One PAX record: `<length> path=<value>\n`, where the length counts its own digits. */
function paxPathRecord(value: string): Buffer {
  const body = ` path=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(length)) + Buffer.byteLength(body) !== length) length = Buffer.byteLength(String(length)) + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

function entryName(entry: TarEntry): string {
  return entry.type === 'directory' ? `${entry.path}/` : entry.path;
}

/** The archive's bytes, gzipped. A path over 100 bytes (or non-ASCII) is carried by a PAX header, which GNU tar, bsdtar and BusyBox read. */
export function packTarGz(entries: readonly TarEntry[], mtimeSec: number): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.path === '' || entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      throw new Error(`tar: refusing the entry path "${entry.path}"`);
    }
    const name = entryName(entry);
    const data = entry.type === 'file' ? entry.data ?? Buffer.alloc(0) : Buffer.alloc(0);
    const plain = Buffer.byteLength(name) <= 100 && Buffer.byteLength(name) === name.length;
    if (!plain) {
      const record = paxPathRecord(name);
      blocks.push(buildHeader('PaxHeader', 'x', 0o644, record.length, mtimeSec), padTo(record));
    }
    const headerName = plain ? name : name.slice(0, 50).replace(/[^\x20-\x7e]/g, '_');
    blocks.push(buildHeader(headerName, entry.type === 'directory' ? '5' : '0', entry.mode, data.length, mtimeSec));
    if (data.length > 0) blocks.push(padTo(data));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Entries of a tree on disk, directories first within each folder, names sorted (the same tree gives the same archive). */
export function collectTreeEntries(root: string, options: TreeOptions): TarEntry[] {
  const entries: TarEntry[] = [];
  const prefix = options.prefix ?? '';
  if (prefix !== '') entries.push({ path: prefix, type: 'directory', mode: options.directoryMode });
  const walk = (rel: string): void => {
    const names = fs.readdirSync(path.join(root, rel)).sort();
    for (const name of names) {
      if (options.exclude?.(name)) continue;
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const archivePath = prefix === '' ? relPath : `${prefix}/${relPath}`;
      const full = path.join(root, rel, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        entries.push({ path: archivePath, type: 'directory', mode: options.directoryMode });
        walk(relPath);
      } else if (stat.isFile()) {
        const data = fs.readFileSync(full);
        entries.push({ path: archivePath, type: 'file', mode: options.fileMode(relPath, data), data });
      } else {
        throw new Error(`tar: ${full} is neither a file nor a directory`);
      }
    }
  };
  walk('');
  return entries;
}

/** A file that starts with `#!` is a script and runs; nothing else gets an execute bit. */
export function modeByShebang(data: Buffer): number {
  return data.length >= 2 && data[0] === 0x23 && data[1] === 0x21 ? 0o755 : 0o644;
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const text = header.toString('ascii', offset, offset + length).replace(/\0.*$/, '').trim();
  return text === '' ? 0 : parseInt(text, 8);
}

function readName(header: Buffer): string {
  const end = header.indexOf(0, 0);
  return header.toString('utf8', 0, end === -1 || end > 100 ? 100 : end);
}

function parsePaxPath(record: Buffer): string | undefined {
  let offset = 0;
  while (offset < record.length) {
    const space = record.indexOf(0x20, offset);
    const length = parseInt(record.toString('ascii', offset, space), 10);
    const body = record.toString('utf8', space + 1, offset + length).replace(/\n$/, '');
    if (body.startsWith('path=')) return body.slice('path='.length);
    offset += length;
  }
  return undefined;
}

/** Reads a `.tar.gz` written by `packTarGz` (or any ustar / PAX archive of plain files and directories). */
export function unpackTarGz(archive: Buffer): TarEntry[] {
  const tar = zlib.gunzipSync(archive);
  const entries: TarEntry[] = [];
  let offset = 0;
  let paxPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === 'x') {
      paxPath = parsePaxPath(body);
      continue;
    }
    const name = (paxPath ?? readName(header)).replace(/^\.\//, '').replace(/\/$/, '');
    paxPath = undefined;
    if (name === '' || name === '.') continue;
    const mode = readOctal(header, 100, 8) & 0o7777;
    if (typeflag === '5') entries.push({ path: name, type: 'directory', mode });
    else if (typeflag === '0' || typeflag === '\0') entries.push({ path: name, type: 'file', mode, data: Buffer.from(body) });
    else throw new Error(`tar: entry "${name}" has the unsupported type "${typeflag}"`);
  }
  return entries;
}
