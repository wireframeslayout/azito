import { describe, it, expect } from 'vitest';
import { InvalidStreamFileError, ManagedStreamFiles } from './ManagedStreamFiles';

/** The path rules are the host's own: a Windows agent judges a path by Windows' rules, whatever OS runs this test. Only refusals are tried (nothing is created). */
describe('ManagedStreamFiles path rules of the host', () => {
  const win = new ManagedStreamFiles('win32', ['C:\\Users\\u\\AppData\\Local\\Temp']);

  it('refuses a Windows path outside the temp folder, however it is spelled', () => {
    expect(() => win.register('C:\\Windows\\azito-pipe-1-2.log')).toThrow(/temp directory/);
    expect(() => win.register('C:\\Users\\u\\AppData\\Local\\Temp\\sub\\azito-pipe-1-2.log')).toThrow(/temp directory/);
  });

  it('refuses a Windows path that is not normalized or not absolute', () => {
    expect(() => win.register('C:\\Users\\u\\AppData\\Local\\Temp\\..\\azito-pipe-1-2.log')).toThrow(/normalized absolute/);
    expect(() => win.register('azito-pipe-1-2.log')).toThrow(InvalidStreamFileError);
  });

  it('refuses a file that is not an azito pipe file, in the allowed folder', () => {
    expect(() => win.register('C:\\Users\\u\\AppData\\Local\\Temp\\other.log')).toThrow(/azito pipe file/);
  });

  it('does not take the POSIX /tmp for a temp folder of a Windows host', () => {
    expect(() => win.register('/tmp/azito-pipe-1-2.log')).toThrow(InvalidStreamFileError);
  });
});
