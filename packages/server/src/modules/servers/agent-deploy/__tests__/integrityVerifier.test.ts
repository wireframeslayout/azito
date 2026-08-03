import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildSha256VerifyCommand, buildSafeExtractCommand, readSha256FromSumsFile } from '../integrityVerifier';

describe('buildSha256VerifyCommand', () => {
  it('generates a command with sha256sum and shasum fallback', () => {
    const cmd = buildSha256VerifyCommand('/tmp/test.tar.gz');
    expect(cmd).toContain('sha256sum');
    expect(cmd).toContain('shasum -a 256');
    expect(cmd).toContain('/tmp/test.tar.gz');
  });

  it('throws on unsafe path characters', () => {
    expect(() => buildSha256VerifyCommand('/tmp/test; rm -rf /')).toThrow('Unsafe filePath');
    expect(() => buildSha256VerifyCommand('/tmp/$(whoami).tar.gz')).toThrow('Unsafe filePath');
  });

  it('throws on path traversal sequences', () => {
    expect(() => buildSha256VerifyCommand('/tmp/../etc/passwd')).toThrow('Unsafe filePath');
  });
});

describe('buildSafeExtractCommand', () => {
  it('includes --no-same-owner and --no-same-permissions', () => {
    const cmd = buildSafeExtractCommand('/tmp/test.tar.gz', '/home/user/.azito/agent/abc123');
    expect(cmd).toContain('--no-same-owner');
    expect(cmd).toContain('--no-same-permissions');
  });

  it('includes path traversal detection', () => {
    const cmd = buildSafeExtractCommand('/tmp/test.tar.gz', '/home/user/.azito/agent/abc123');
    expect(cmd).toContain('TRAVERSAL_IN_ARCHIVE');
  });

  it('extracts to a temp directory before moving', () => {
    const cmd = buildSafeExtractCommand('/tmp/test.tar.gz', '/home/user/.azito/agent/abc123');
    expect(cmd).toContain('mktemp -d');
    expect(cmd).toContain('mv "$_tmpdir"');
  });

  it('throws on unsafe path characters', () => {
    expect(() => buildSafeExtractCommand('/tmp/test$(id).tar.gz', '/home/user/dest')).toThrow('Unsafe tarballPath');
    expect(() => buildSafeExtractCommand('/tmp/test.tar.gz', '/home/user/dest;bad')).toThrow('Unsafe destDir');
  });

  it('converts tilde to $HOME so double-quoted paths expand correctly', () => {
    const cmd = buildSafeExtractCommand('~/tmp/a.tar.gz', '~/.azito/agent/v1');
    expect(cmd).not.toContain('"~/');
    expect(cmd).toContain('$HOME/.azito/agent/v1');
    expect(cmd).toContain('$HOME/tmp/a.tar.gz');
  });

  it('extracts a real tarball via bash with tilde paths and HOME override', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'));
    try {
      const tarballDir = path.join(tmpRoot, '.azito', 'tmp');
      fs.mkdirSync(tarballDir, { recursive: true });

      const stageDir = path.join(tmpRoot, 'stage');
      fs.mkdirSync(stageDir);
      fs.writeFileSync(path.join(stageDir, 'hello.txt'), 'world');
      const tarballReal = path.join(tarballDir, 'test.tar.gz');
      execSync(`tar czf "${tarballReal}" -C "${stageDir}" .`);

      const cmd = buildSafeExtractCommand('~/.azito/tmp/test.tar.gz', '~/.azito/agent/v1');
      execSync(`bash -c '${cmd.replace(/'/g, "'\\''")}'`, { env: { ...process.env, HOME: tmpRoot } });

      const expandedDest = path.join(tmpRoot, '.azito', 'agent', 'v1');
      expect(fs.existsSync(path.join(expandedDest, 'hello.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(expandedDest, 'hello.txt'), 'utf-8')).toBe('world');
      expect(fs.existsSync(path.join(process.cwd(), '~'))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('succeeds on a fresh HOME with no pre-existing .azito directory', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-home-'));
    try {
      const stageDir = path.join(tmpRoot, 'stage');
      fs.mkdirSync(stageDir);
      fs.writeFileSync(path.join(stageDir, 'version.txt'), 'abc123');
      const tarball = path.join(tmpRoot, 'agent.tar.gz');
      execSync(`tar czf "${tarball}" -C "${stageDir}" .`);

      const cmd = buildSafeExtractCommand(tarball, '~/.azito/agent/abc123');
      execSync(`bash -c '${cmd.replace(/'/g, "'\\''")}'`, { env: { ...process.env, HOME: tmpRoot } });

      const dest = path.join(tmpRoot, '.azito', 'agent', 'abc123');
      expect(fs.existsSync(path.join(dest, 'version.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(dest, 'version.txt'), 'utf-8')).toBe('abc123');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('readSha256FromSumsFile', () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
  });

  it('reads the correct hash for a given filename', () => {
    tmpFile = path.join(os.tmpdir(), `sha256sums-test-${Date.now()}`);
    const expectedHash = 'a'.repeat(64);
    fs.writeFileSync(tmpFile, `${expectedHash}  azito-agent.tar.gz\n`);
    const hash = readSha256FromSumsFile(tmpFile, 'azito-agent.tar.gz');
    expect(hash).toBe(expectedHash);
  });

  it('throws when filename is not found', () => {
    tmpFile = path.join(os.tmpdir(), `sha256sums-test-${Date.now()}`);
    fs.writeFileSync(tmpFile, `${'a'.repeat(64)}  other-file.tar.gz\n`);
    expect(() => readSha256FromSumsFile(tmpFile, 'azito-agent.tar.gz')).toThrow('No SHA256 entry');
  });

  it('handles multiple entries', () => {
    tmpFile = path.join(os.tmpdir(), `sha256sums-test-${Date.now()}`);
    fs.writeFileSync(tmpFile, [
      '0000000000000000000000000000000000000000000000000000000000000001  first.tar.gz',
      '0000000000000000000000000000000000000000000000000000000000000002  azito-agent.tar.gz',
      '',
    ].join('\n'));
    const hash = readSha256FromSumsFile(tmpFile, 'azito-agent.tar.gz');
    expect(hash).toBe('0000000000000000000000000000000000000000000000000000000000000002');
  });
});
