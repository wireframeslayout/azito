import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectTreeEntries, modeByShebang, packTarGz, unpackTarGz, type TarEntry } from './tarGz';

const MTIME = 1_700_000_000;

describe('packTarGz / unpackTarGz', () => {
  it('keeps the modes and the contents it was given', () => {
    const entries: TarEntry[] = [
      { path: 'bin', type: 'directory', mode: 0o755 },
      { path: 'bin/run.sh', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\necho hi\n') },
      { path: 'bin/data.txt', type: 'file', mode: 0o644, data: Buffer.alloc(1300, 'x') },
      { path: 'empty', type: 'file', mode: 0o600, data: Buffer.alloc(0) },
    ];
    expect(unpackTarGz(packTarGz(entries, MTIME))).toEqual(entries);
  });

  it('carries a path over 100 bytes and a non-ASCII path in a PAX header', () => {
    const longPath = `node_modules/${'very-long-directory-name/'.repeat(6)}file.js`;
    const entries: TarEntry[] = [
      { path: longPath, type: 'file', mode: 0o644, data: Buffer.from('a') },
      { path: '日本語/ファイル.txt', type: 'file', mode: 0o644, data: Buffer.from('b') },
    ];
    expect(longPath.length).toBeGreaterThan(100);
    expect(unpackTarGz(packTarGz(entries, MTIME)).map((e) => e.path)).toEqual(entries.map((e) => e.path));
  });

  it('refuses a path that leaves the archive', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '']) {
      expect(() => packTarGz([{ path: bad, type: 'file', mode: 0o644, data: Buffer.alloc(0) }], MTIME)).toThrow(/refusing/);
    }
  });

  it.skipIf(process.platform === 'win32')('is read by the host tar with the same names and modes', () => {
    const longPath = `deep/${'segment-segment/'.repeat(8)}f.txt`;
    const archive = packTarGz(
      [
        { path: 'run.sh', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
        { path: 'plain.txt', type: 'file', mode: 0o644, data: Buffer.from('p') },
        { path: longPath, type: 'file', mode: 0o644, data: Buffer.from('l') },
      ],
      MTIME,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'targz-test-'));
    try {
      const file = path.join(dir, 'a.tar.gz');
      fs.writeFileSync(file, archive);
      const listing = execFileSync('tar', ['-tvzf', file]).toString();
      expect(listing).toMatch(/-rwxr-xr-x .* run\.sh/);
      expect(listing).toMatch(/-rw-r--r-- .* plain\.txt/);
      expect(listing).toContain(longPath);
      const out = path.join(dir, 'out');
      fs.mkdirSync(out);
      execFileSync('tar', ['-xzf', file, '-C', out]);
      expect(fs.readFileSync(path.join(out, longPath), 'utf8')).toBe('l');
      expect(fs.statSync(path.join(out, 'run.sh')).mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectTreeEntries', () => {
  it('walks a tree in a stable order, applies the mode rules and honours exclude / prefix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'targz-tree-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.writeFileSync(path.join(dir, 'setup.sh'), '#!/bin/bash\n');
      fs.writeFileSync(path.join(dir, 'README'), 'doc');
      fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'a');
      fs.writeFileSync(path.join(dir, 'node_modules', 'skipped.js'), 's');
      const entries = collectTreeEntries(dir, {
        prefix: 'harness',
        exclude: (name) => name === 'node_modules',
        fileMode: (_rel, data) => modeByShebang(data),
        directoryMode: 0o755,
      });
      expect(entries.map((e) => [e.path, e.type, e.mode.toString(8)])).toEqual([
        ['harness', 'directory', '755'],
        ['harness/README', 'file', '644'],
        ['harness/setup.sh', 'file', '755'],
        ['harness/sub', 'directory', '755'],
        ['harness/sub/a.txt', 'file', '644'],
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
