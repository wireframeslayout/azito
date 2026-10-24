import { describe, expect, it, vi } from 'vitest';
import type { IFileOps } from '../fs/fileOps';
import type { HostPlatform } from './hostEnv';
import { changeDirectoryLine, resolveShellDirectory } from './changeDirectoryLine';
import { posixDialect, powershellDialect } from './shellDialect';

function filesOf(platform: HostPlatform, home: string): { files: () => IFileOps; realpath: ReturnType<typeof vi.fn> } {
  const realpath = vi.fn(async (p: string) => {
    if (p !== '~') throw new Error(`unexpected realpath of ${p}`);
    return home;
  });
  const ops = { platform, realpath } as unknown as IFileOps;
  return { files: () => ops, realpath };
}

describe('resolveShellDirectory', () => {
  it('replaces a leading ~ with the host\'s home (POSIX)', async () => {
    const { files } = filesOf('linux', '/home/me');
    await expect(resolveShellDirectory(files, '~')).resolves.toBe('/home/me');
    await expect(resolveShellDirectory(files, '~/work/app')).resolves.toBe('/home/me/work/app');
  });

  it('replaces a leading ~ with the host\'s home (win32, both separators)', async () => {
    const { files } = filesOf('win32', 'C:\\Users\\me');
    await expect(resolveShellDirectory(files, '~')).resolves.toBe('C:\\Users\\me');
    await expect(resolveShellDirectory(files, '~\\work\\app')).resolves.toBe('C:\\Users\\me\\work\\app');
    await expect(resolveShellDirectory(files, '~/work/app')).resolves.toBe('C:\\Users\\me\\work\\app');
  });

  it('drops only the host\'s own separators after ~ (a backslash is a name on POSIX)', async () => {
    const posix = filesOf('linux', '/home/me');
    await expect(resolveShellDirectory(posix.files, '~//app')).resolves.toBe('/home/me/app');
    await expect(resolveShellDirectory(posix.files, '~/\\app')).resolves.toBe('/home/me/\\app');
    const win = filesOf('win32', 'C:\\Users\\me');
    await expect(resolveShellDirectory(win.files, '~/\\app')).resolves.toBe('C:\\Users\\me\\app');
  });

  it('does not ask the host for anything when the path is not home-relative', async () => {
    const filesFn = vi.fn();
    await expect(resolveShellDirectory(filesFn, '/work/app')).resolves.toBe('/work/app');
    await expect(resolveShellDirectory(filesFn, 'C:\\work\\app')).resolves.toBe('C:\\work\\app');
    expect(filesFn).not.toHaveBeenCalled();
  });

  it('leaves ~user and a ~-prefixed name alone (not the home form)', async () => {
    const { files, realpath } = filesOf('linux', '/home/me');
    await expect(resolveShellDirectory(files, '~other/x')).resolves.toBe('~other/x');
    expect(realpath).not.toHaveBeenCalled();
  });

  it('does not treat ~\\x as home-relative on POSIX (a backslash is a name character there)', async () => {
    const { files } = filesOf('linux', '/home/me');
    await expect(resolveShellDirectory(files, '~\\x')).resolves.toBe('~\\x');
  });

  it('passes a failure to find the home up', async () => {
    const files = () => ({ platform: 'linux', realpath: async () => { throw new Error('home missing'); } }) as unknown as IFileOps;
    await expect(resolveShellDirectory(files, '~/x')).rejects.toThrow('home missing');
  });
});

describe('changeDirectoryLine', () => {
  it('gives the POSIX shell an absolute, quoted path', async () => {
    const { files } = filesOf('linux', '/home/me');
    await expect(changeDirectoryLine(files, posixDialect, '~/my app')).resolves.toBe("cd -- '/home/me/my app'");
    await expect(changeDirectoryLine(files, posixDialect, '/work/app')).resolves.toBe("cd -- '/work/app'");
  });

  it('gives PowerShell the same resolved path', async () => {
    const { files } = filesOf('win32', 'C:\\Users\\me');
    const line = await changeDirectoryLine(files, powershellDialect, '~\\app');
    expect(line).toBe(powershellDialect.changeDirectory('C:\\Users\\me\\app'));
    expect(line).not.toContain('~');
  });
});
