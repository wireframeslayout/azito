import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatHubPointer, HubPointerError, parseHubPointer, readHubPointer, writeHubPointer } from './hubPointer';
import { isHubPointerVersion, isReleaseTag } from './hubVersion';

describe('parseHubPointer', () => {
  it('reads what install.ps1 writes: the tag and CRLF', () => {
    expect(parseHubPointer(Buffer.from('v0.12.0\r\n', 'utf8'))).toBe('v0.12.0');
    expect(parseHubPointer(Buffer.from('v0.12.0-rc.1\r\n', 'utf8'))).toBe('v0.12.0-rc.1');
    expect(parseHubPointer(Buffer.from('0.12.0+build.5\r\n', 'utf8'))).toBe('0.12.0+build.5');
  });

  const refused: Array<[string, Buffer, RegExp]> = [
    ['an empty file', Buffer.alloc(0), /empty/],
    ['a UTF-8 BOM', Buffer.from('﻿v0.12.0\r\n', 'utf8'), /BOM/],
    ['UTF-16 (LE BOM)', Buffer.from('﻿v0.12.0\r\n', 'utf16le'), /UTF-16/],
    ['UTF-16 without a BOM', Buffer.from('v0.12.0\r\n', 'utf16le'), /UTF-16/],
    ['no line ending', Buffer.from('v0.12.0', 'utf8'), /CRLF/],
    ['a bare LF', Buffer.from('v0.12.0\n', 'utf8'), /CRLF/],
    ['two lines', Buffer.from('v0.12.0\r\nv0.12.1\r\n', 'utf8'), /exactly one line/],
    ['spaces around the version', Buffer.from(' v0.12.0 \r\n', 'utf8'), /spaces/],
    ['a name that is not a version', Buffer.from('latest\r\n', 'utf8'), /does not hold a version/],
    ['a path', Buffer.from('..\\evil\r\n', 'utf8'), /does not hold a version/],
    ['only a line ending', Buffer.from('\r\n', 'utf8'), /does not hold a version/],
  ];
  it.each(refused)('refuses %s', (_label, content, reason) => {
    expect(() => parseHubPointer(content)).toThrow(HubPointerError);
    expect(() => parseHubPointer(content)).toThrow(reason);
  });
});

describe('formatHubPointer', () => {
  it('is the tag, CRLF', () => {
    expect(formatHubPointer('v0.12.0')).toBe('v0.12.0\r\n');
  });
  it('refuses what is not a version, so no folder name can be smuggled into the pointer', () => {
    for (const bad of ['', 'latest', '..', 'v1.2.3/../x', 'v1.2.3\r\nv9.9.9', ' v1.2.3', 'v1.2']) {
      expect(() => formatHubPointer(bad), bad).toThrow(HubPointerError);
    }
  });
});

describe('version patterns', () => {
  it('accepts every release tag as a pointer version', () => {
    for (const tag of ['v0.12.0', '0.12.0', 'v1.0.0-rc.1', 'v1.0.0-rc1', 'v10.20.30-beta.2.x', 'v0.0.0-ci-a']) {
      // 'v0.0.0-ci-a' has a second '-': a pointer may hold it, a release tag may not
      if (isReleaseTag(tag)) expect(isHubPointerVersion(tag), tag).toBe(true);
    }
    expect(isReleaseTag('v1.0.0-rc.1')).toBe(true);
    expect(isReleaseTag('v0.0.0-ci-a')).toBe(false);
    expect(isHubPointerVersion('v0.0.0-ci-a')).toBe(true);
  });
  it('refuses a path and anything with a separator in both', () => {
    for (const bad of ['../v1.0.0', 'v1.0.0/x', 'v1.0.0\\x', 'v1.0.0 ', '']) {
      expect(isReleaseTag(bad), bad).toBe(false);
      expect(isHubPointerVersion(bad), bad).toBe(false);
    }
  });
});

describe('writeHubPointer / readHubPointer', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-pointer-'));
    file = path.join(dir, 'current.txt');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes UTF-8 without a BOM as <tag>CRLF, and reads it back', () => {
    writeHubPointer(file, 'v0.12.0');
    expect(fs.readFileSync(file)).toEqual(Buffer.from('v0.12.0\r\n', 'ascii'));
    expect(readHubPointer(file)).toBe('v0.12.0');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('replaces an existing pointer', () => {
    writeHubPointer(file, 'v0.12.0');
    writeHubPointer(file, 'v0.12.1');
    expect(readHubPointer(file)).toBe('v0.12.1');
    expect(fs.readdirSync(dir)).toEqual(['current.txt']);
  });

  it('replaces a pointer that install.ps1 wrote', () => {
    fs.writeFileSync(file, 'v0.12.0\r\n');
    expect(readHubPointer(file)).toBe('v0.12.0');
    writeHubPointer(file, 'v0.13.0-rc.1');
    expect(readHubPointer(file)).toBe('v0.13.0-rc.1');
  });

  it('writes nothing for a bad version and keeps the old pointer', () => {
    writeHubPointer(file, 'v0.12.0');
    expect(() => writeHubPointer(file, 'nope')).toThrow(HubPointerError);
    expect(readHubPointer(file)).toBe('v0.12.0');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('removes its temporary file when the swap fails, and keeps the old pointer', () => {
    // A folder in the pointer's place: the rename cannot replace it.
    fs.mkdirSync(file);
    expect(() => writeHubPointer(file, 'v0.12.0')).toThrow();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it('removes its temporary file when the flush fails, and keeps the old pointer', () => {
    writeHubPointer(file, 'v0.12.0');
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('EIO: simulated'); });
    try {
      expect(() => writeHubPointer(file, 'v0.12.1')).toThrow(/simulated/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual(['current.txt']);
    expect(readHubPointer(file)).toBe('v0.12.0');
  });

  it('reports a missing pointer as ENOENT, and a malformed one with the reason', () => {
    expect(() => readHubPointer(file)).toThrow(/ENOENT/);
    fs.writeFileSync(file, 'v0.12.0\n');
    expect(() => readHubPointer(file)).toThrow(HubPointerError);
  });
});
