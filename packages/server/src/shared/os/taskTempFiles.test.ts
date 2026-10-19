import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { TaskTempFiles } from './taskTempFiles';

const local = { type: 'local' } as const;
const agent = { type: 'agent' } as const;

describe('TaskTempFiles', () => {
  const files = new TaskTempFiles('/var/folders/xy/T', 'darwin');

  it('places the hub\'s own server files in the hub temp folder', () => {
    expect(files.pipeFile(local, '12-1700', 5)).toBe(path.join('/var/folders/xy/T', 'azito-pipe-12-1700-5.log'));
    expect(files.pipeFile(local, '12-sig', 5)).toBe(path.join('/var/folders/xy/T', 'azito-pipe-12-sig-5.log'));
    expect(files.outputFile(local, 12, 'abc')).toBe(path.join('/var/folders/xy/T', 'azito-output-12-abc.md'));
    expect(files.rulesFile(local, 12, 'abc')).toBe(path.join('/var/folders/xy/T', 'azito-rules-12-abc.md'));
  });

  it('keeps /tmp for agent servers regardless of the hub temp folder (until the host OS is known: P5)', () => {
    expect(files.pipeFile(agent, '12-1700', 5)).toBe('/tmp/azito-pipe-12-1700-5.log');
    expect(files.outputFile(agent, 12, 'abc')).toBe('/tmp/azito-output-12-abc.md');
    expect(files.rulesFile(agent, 12, 'abc')).toBe('/tmp/azito-rules-12-abc.md');
    expect(TaskTempFiles.remotePipeFile('12-1700', 5)).toBe('/tmp/azito-pipe-12-1700-5.log');
  });

  it('on Linux, where os.tmpdir() is /tmp, the paths are the same as before', () => {
    const linux = new TaskTempFiles('/tmp', 'linux');
    expect(linux.outputFile(local, 3, 'n')).toBe(path.join('/tmp', 'azito-output-3-n.md'));
    expect(linux.hubScanDirs()).toEqual(['/tmp']);
  });

  it('scans the legacy /tmp on Unix when the temp folder moved (macOS $TMPDIR), but not on Windows', () => {
    expect(files.hubScanDirs()).toEqual(['/var/folders/xy/T', '/tmp']);
    expect(new TaskTempFiles('C:\\Users\\u\\AppData\\Local\\Temp', 'win32').hubScanDirs()).toEqual(['C:\\Users\\u\\AppData\\Local\\Temp']);
  });

  it('rejects a Unix temp folder that cannot be embedded in shell commands, but not a Windows one', () => {
    expect(() => new TaskTempFiles('/tmp/my dir', 'linux').assertHubDirShellSafe()).toThrow(/not safe in shell commands/);
    expect(() => new TaskTempFiles("/tmp/it's", 'darwin').assertHubDirShellSafe()).toThrow(/TMPDIR/);
    expect(() => new TaskTempFiles('/var/folders/zz/abc_D-1/T', 'darwin').assertHubDirShellSafe()).not.toThrow();
    expect(() => new TaskTempFiles('C:\\Users\\a b\\AppData\\Local\\Temp', 'win32').assertHubDirShellSafe()).not.toThrow();
  });

  it('rejects an empty temp folder', () => {
    expect(() => new TaskTempFiles('', 'linux')).toThrow(/hubTmpDir/);
  });

  it('exposes the file-name prefixes cleanup and recovery match on', () => {
    expect(TaskTempFiles.prefixesForTask(7)).toEqual(['azito-pipe-7-', 'azito-output-7-', 'azito-rules-7-']);
    expect(TaskTempFiles.signalPrefixForTask(7)).toBe('azito-pipe-7-sig-');
  });
});
