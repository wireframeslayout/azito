import { describe, it, expect } from 'vitest';
import { TaskTempFiles, assertTmpDirShellSafe } from './taskTempFiles';

const local = { type: 'local' } as const;
const linuxAgent = { type: 'agent', platform: 'linux', tmpDir: '/tmp' } as const;
const macAgent = { type: 'agent', platform: 'darwin', tmpDir: '/var/folders/ab/c_d/T' } as const;
const winAgent = { type: 'agent', platform: 'win32', tmpDir: 'C:\\Users\\u\\AppData\\Local\\Temp' } as const;

describe('TaskTempFiles', () => {
  const files = new TaskTempFiles('/var/folders/xy/T', 'darwin');

  it('places the hub\'s own server files in the hub temp folder', () => {
    expect(files.pipeFile(local, '12-1700', 5)).toBe('/var/folders/xy/T/azito-pipe-12-1700-5.log');
    expect(files.pipeFile(local, '12-sig', 5)).toBe('/var/folders/xy/T/azito-pipe-12-sig-5.log');
    expect(files.outputFile(local, 12, 'abc')).toBe('/var/folders/xy/T/azito-output-12-abc.md');
    expect(files.rulesFile(local, 12, 'abc')).toBe('/var/folders/xy/T/azito-rules-12-abc.md');
  });

  it('names an agent server\'s files in the OS notation and temp folder the agent reported', () => {
    expect(files.pipeFile(linuxAgent, '12-1700', 5)).toBe('/tmp/azito-pipe-12-1700-5.log');
    expect(files.outputFile(macAgent, 12, 'abc')).toBe('/var/folders/ab/c_d/T/azito-output-12-abc.md');
    expect(files.rulesFile(macAgent, 12, 'abc')).toBe('/var/folders/ab/c_d/T/azito-rules-12-abc.md');
    expect(files.pipeFile(winAgent, '12-sig', 5)).toBe('C:\\Users\\u\\AppData\\Local\\Temp\\azito-pipe-12-sig-5.log');
    expect(files.outputFile(winAgent, 12, 'abc')).toBe('C:\\Users\\u\\AppData\\Local\\Temp\\azito-output-12-abc.md');
    expect(files.rulesFile(winAgent, 12, 'abc')).toBe('C:\\Users\\u\\AppData\\Local\\Temp\\azito-rules-12-abc.md');
    expect(TaskTempFiles.remotePipeFile(winAgent, '12-1700', 5)).toBe('C:\\Users\\u\\AppData\\Local\\Temp\\azito-pipe-12-1700-5.log');
  });

  it('names a Windows hub\'s own files with backslashes, whatever OS runs this', () => {
    const win = new TaskTempFiles('C:\\Users\\u\\AppData\\Local\\Temp', 'win32');
    expect(win.outputFile(local, 3, 'n')).toBe('C:\\Users\\u\\AppData\\Local\\Temp\\azito-output-3-n.md');
  });

  it('rejects an agent temp folder that cannot be embedded in shell commands, but not a Windows one', () => {
    expect(() => assertTmpDirShellSafe('linux', '/tmp/my dir', 'agent server "a"')).toThrow(/agent server "a"/);
    expect(() => assertTmpDirShellSafe('darwin', '/var/folders/ab/c_d/T', 'agent server "a"')).not.toThrow();
    expect(() => assertTmpDirShellSafe('win32', 'C:\\Users\\a b\\Temp', 'agent server "a"')).not.toThrow();
  });

  it('on Linux, where os.tmpdir() is /tmp, the paths are the same as before', () => {
    const linux = new TaskTempFiles('/tmp', 'linux');
    expect(linux.outputFile(local, 3, 'n')).toBe('/tmp/azito-output-3-n.md');
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
