import { describe, expect, it, vi } from 'vitest';
import type { CommandSpec } from '../../../shared/exec/commandSpec';
import { findHubVersionsInUse, parseHubDirAcl, parseVersionsInUse, removeFolderWithRd, whyHubDirIsWritableByOthers } from '../windowsHubFolderOps';

const ME = 'S-1-5-21-1-2-3-1001';
const FULL = 2032127;
const READ = 1179785;
const MODIFY = 1245631;

describe('findHubVersionsInUse', () => {
  const ok = (stdout: string) => vi.fn(async (_spec: CommandSpec) => ({ exitCode: 0, stdout, stderr: '', signal: null }));

  it('asks PowerShell for the versions under every spelling of the hub folder and reads only well-formed version names back', async () => {
    const run = ok('version v0.1.0\r\nversion v0.1.0\r\nversion ..\r\nnoise\r\nversion v0.2.0-rc.1\r\n');
    const found = await findHubVersionsInUse(run, 'C:\\Windows', ['C:\\Users\\a b\\.azito\\hub', 'D:\\real\\hub\\']);
    expect([...found].sort()).toEqual(['v0.1.0', 'v0.2.0-rc.1']);
    const spec = run.mock.calls[0][0];
    expect(spec.file.toLowerCase()).toContain('powershell.exe');
    const script = Buffer.from(spec.args[spec.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    // Either slash, and any run of them, between the parts of a root.
    expect(script).toContain('C:[\\\\/]+Users[\\\\/]+a b[\\\\/]+\\.azito[\\\\/]+hub[\\\\/]+');
    expect(script).toContain('D:[\\\\/]+real[\\\\/]+hub[\\\\/]+');
  });

  it('throws when PowerShell fails, so that nothing is removed without knowing', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom', signal: null }));
    await expect(findHubVersionsInUse(run, 'C:\\Windows', ['C:\\h'])).rejects.toThrow(/exit 1.*boom/);
  });

  it('stops everything when a process whose path cannot be read might be using a version (the query succeeded, the path is missing), whoever owns it', async () => {
    const run = ok('version v0.1.0\r\nunknown 4242 Foo.exe\r\nunknown 77 Bar.exe\r\n');
    await expect(findHubVersionsInUse(run, 'C:\\Windows', ['C:\\h'])).rejects.toThrow(/process 4242 \(Foo.exe\), 77 \(Bar.exe\).*no old version is removed/);
  });
});

describe('parseVersionsInUse', () => {
  it('is the versions found when no process is unknown', () => {
    expect([...parseVersionsInUse('version v1.0.0\nversion v1.0.0\n')]).toEqual(['v1.0.0']);
  });
});

describe('who may write the hub folder', () => {
  const acl = (allows: Array<[string, number]>, owner = ME) => parseHubDirAcl([`me ${ME}`, `owner ${owner}`, ...allows.map(([sid, rights]) => `allow ${sid} ${rights}`)].join('\r\n'));

  it('accepts this user, SYSTEM and Administrators with any rights, and others with only read', () => {
    expect(whyHubDirIsWritableByOthers(acl([[ME, FULL], ['S-1-5-18', FULL], ['S-1-5-32-544', FULL], ['S-1-5-32-545', READ], ['S-1-3-0', FULL]]))).toBeUndefined();
  });

  it('refuses another account that can modify it', () => {
    expect(whyHubDirIsWritableByOthers(acl([[ME, FULL], ['S-1-5-32-545', MODIFY]]))).toMatch(/changed by others \(S-1-5-32-545\)/);
  });

  it('refuses a generic-write grant and a delete-only grant to another account', () => {
    expect(whyHubDirIsWritableByOthers(acl([[ME, FULL], ['S-1-1-0', 0x40000000]]))).toMatch(/S-1-1-0/);
    expect(whyHubDirIsWritableByOthers(acl([[ME, FULL], ['S-1-1-0', 0x10000]]))).toMatch(/S-1-1-0/);
  });

  it('refuses a folder owned by somebody else', () => {
    expect(whyHubDirIsWritableByOthers(acl([[ME, FULL]], 'S-1-5-21-9-9-9-500'))).toMatch(/owned by S-1-5-21-9-9-9-500/);
  });

  it('accepts a folder owned by Administrators', () => {
    expect(whyHubDirIsWritableByOthers(acl([[ME, FULL]], 'S-1-5-32-544'))).toBeUndefined();
  });

  it('does not guess when the answer is incomplete', () => {
    expect(() => parseHubDirAcl('allow S-1-1-0 1')).toThrow(/Could not read the access list/);
  });
});

describe('removeFolderWithRd', () => {
  it('runs System32\\cmd.exe by absolute path as `/d /c rd /s /q <name>` in the hub folder', async () => {
    const run = vi.fn(async (_spec: CommandSpec) => ({ exitCode: 0, stdout: '', stderr: '', signal: null }));
    await removeFolderWithRd(run, 'C:\\Windows', 'C:\\Users\\a b (c)\\.azito\\hub', '.prune-v1.0.0-0123abcd', () => false);
    expect(run.mock.calls[0][0]).toMatchObject({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', 'rd', '/s', '/q', '.prune-v1.0.0-0123abcd'],
      cwd: 'C:\\Users\\a b (c)\\.azito\\hub',
    });
  });

  it('is a failure when rd fails, and when the folder is still there', async () => {
    const fail = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'The process cannot access the file', signal: null }));
    await expect(removeFolderWithRd(fail, 'C:\\Windows', 'C:\\h', '.prune-v1-0123abcd', () => true)).rejects.toThrow(/exit 1.*cannot access/);
    const quiet = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', signal: null }));
    await expect(removeFolderWithRd(quiet, 'C:\\Windows', 'C:\\h', '.prune-v1-0123abcd', () => true)).rejects.toThrow(/rd could not remove/);
  });

  it('takes a plain folder name only, never a path', async () => {
    const run = vi.fn();
    await expect(removeFolderWithRd(run, 'C:\\Windows', 'C:\\h', '..\\x', () => false)).rejects.toThrow(/Not a plain folder name/);
    await expect(removeFolderWithRd(run, 'C:\\Windows', 'C:\\h', 'a b&c', () => false)).rejects.toThrow(/Not a plain folder name/);
    expect(run).not.toHaveBeenCalled();
  });
});
