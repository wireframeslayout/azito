import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import type { HostPlatform } from '../../../shared/os/hostEnv';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import { ensureClaudeBypassAccepted, ensureClaudeLegacyBypassAccepted } from './ensureClaudeBypassAccepted';
import { claudeProjectKeys, ensureClaudeTrust } from './ensureClaudeTrust';
import { prepareClaudeLaunch } from './prepareClaudeLaunch';

let fakeHome: string;

/** A transport whose host is this machine with `homeDir` as its home directory: the file operations are the real ones. */
function transportWithHome(homeDir: string): IServerTransport {
  const ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir }));
  return { files: () => ops } as unknown as IServerTransport;
}

const claudeDir = (): string => join(fakeHome, '.claude');
const settingsPath = (): string => join(claudeDir(), 'settings.json');
const readSettings = (): Record<string, unknown> => JSON.parse(readFileSync(settingsPath(), 'utf8'));

describe('ensureClaudeBypassAccepted', () => {
  beforeEach(() => {
    fakeHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-bypass-')));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('creates ~/.claude/settings.json with only the key when neither exists', async () => {
    expect(await ensureClaudeBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'accepted' });
    expect(readSettings()).toEqual({ skipDangerousModePermissionPrompt: true });
  });

  it('creates the file when ~/.claude exists without it', async () => {
    mkdirSync(claudeDir());
    expect(await ensureClaudeBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'accepted' });
    expect(readSettings()).toEqual({ skipDangerousModePermissionPrompt: true });
  });

  it('keeps the other keys', async () => {
    mkdirSync(claudeDir());
    writeFileSync(settingsPath(), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, skipDangerousModePermissionPrompt: false }));
    expect(await ensureClaudeBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'accepted' });
    expect(readSettings()).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, skipDangerousModePermissionPrompt: true });
  });

  it('does not rewrite a file that already has the key set to true', async () => {
    mkdirSync(claudeDir());
    const original = '{"skipDangerousModePermissionPrompt":true,  "x": 1}';
    writeFileSync(settingsPath(), original);
    expect(await ensureClaudeBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'already_accepted' });
    expect(readFileSync(settingsPath(), 'utf8')).toBe(original);
  });

  it('skips, without touching the file, when it is not valid JSON', async () => {
    mkdirSync(claudeDir());
    writeFileSync(settingsPath(), '{not json');
    const result = await ensureClaudeBypassAccepted(transportWithHome(fakeHome));
    expect(result).toMatchObject({ action: 'skipped', reason: expect.stringContaining('not valid JSON') });
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{not json');
  });

  it('skips, without touching the file, when it is not a JSON object', async () => {
    mkdirSync(claudeDir());
    writeFileSync(settingsPath(), '[1]');
    expect(await ensureClaudeBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'skipped', reason: '~/.claude/settings.json is not a JSON object' });
    expect(readFileSync(settingsPath(), 'utf8')).toBe('[1]');
  });

  // Windows には POSIX の mode が無い
  it.skipIf(process.platform === 'win32')('preserves file permissions after write', async () => {
    mkdirSync(claudeDir());
    writeFileSync(settingsPath(), '{}', { mode: 0o600 });
    chmodSync(settingsPath(), 0o600);
    await ensureClaudeBypassAccepted(transportWithHome(fakeHome));
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
  });

  it('keeps every change when two tasks start at the same time', async () => {
    const transport = transportWithHome(fakeHome);
    const results = await Promise.all([1, 2, 3].map(() => ensureClaudeBypassAccepted(transport)));
    expect(results.map((r) => r.action).sort()).toEqual(['accepted', 'already_accepted', 'already_accepted']);
    expect(readSettings()).toEqual({ skipDangerousModePermissionPrompt: true });
  });

  it('does not overwrite a file that changed after it was read', async () => {
    mkdirSync(claudeDir());
    writeFileSync(settingsPath(), '{"a":1}');
    const real = transportWithHome(fakeHome).files();
    const racing = {
      files: () => ({
        ...real,
        platform: real.platform,
        realpath: real.realpath.bind(real),
        read: async (...args: Parameters<typeof real.read>) => {
          const content = await real.read(...args);
          writeFileSync(settingsPath(), '{"theirs":1}');
          return content;
        },
        write: real.write.bind(real),
      }),
    } as unknown as IServerTransport;
    await expect(ensureClaudeBypassAccepted(racing)).rejects.toBeInstanceOf(FileOpsError);
    expect(readSettings()).toEqual({ theirs: 1 });
    expect(existsSync(settingsPath())).toBe(true);
  });

  // Windows では symlink に権限が要る
  it.skipIf(process.platform === 'win32')('writes through a symbolic link to its target and keeps the link', async () => {
    mkdirSync(claudeDir());
    const dotfiles = join(fakeHome, 'dotfiles');
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, 'settings.json'), '{"model":"opus"}');
    symlinkSync(join(dotfiles, 'settings.json'), settingsPath());
    expect(await ensureClaudeBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'accepted' });
    expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dotfiles, 'settings.json'), 'utf8'))).toEqual({ model: 'opus', skipDangerousModePermissionPrompt: true });
  });

  /** The real file operations with `create` / `write` of the settings file preceded by `before` (somebody else writing at that moment). */
  function transportRacing(before: { create?: () => void; write?: () => void }): IServerTransport {
    const real = transportWithHome(fakeHome).files();
    return {
      files: () => ({
        ...real,
        platform: real.platform,
        realpath: real.realpath.bind(real),
        read: real.read.bind(real),
        create: async (...args: Parameters<typeof real.create>) => {
          if (args[1] === 'file') before.create?.();
          return real.create(...args);
        },
        write: async (...args: Parameters<typeof real.write>) => {
          before.write?.();
          return real.write(...args);
        },
      }),
    } as unknown as IServerTransport;
  }

  it('reads a file again, and keeps its content, when it appeared after the read found nothing', async () => {
    mkdirSync(claudeDir());
    const transport = transportRacing({ create: () => writeFileSync(settingsPath(), '{"permissions":{"allow":["Bash(ls)"]}}') });
    expect(await ensureClaudeBypassAccepted(transport)).toEqual({ action: 'accepted' });
    expect(readSettings()).toEqual({ permissions: { allow: ['Bash(ls)'] }, skipDangerousModePermissionPrompt: true });
  });

  it('removes nothing when the write fails for another reason after somebody else saved the file', async () => {
    const real = transportWithHome(fakeHome).files();
    const failing = {
      files: () => ({
        ...real,
        platform: real.platform,
        realpath: real.realpath.bind(real),
        read: real.read.bind(real),
        create: real.create.bind(real),
        write: async () => {
          writeFileSync(settingsPath(), '{"theirs":1}');
          throw new FileOpsError('PERMISSION_DENIED', 'cannot write');
        },
      }),
    } as unknown as IServerTransport;
    await expect(ensureClaudeBypassAccepted(failing)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(readSettings()).toEqual({ theirs: 1 });
  });

  it('never overwrites a file that was filled by somebody else between the creation and the write', async () => {
    const transport = transportRacing({ write: () => writeFileSync(settingsPath(), '{"theirs":1}') });
    await expect(ensureClaudeBypassAccepted(transport)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readSettings()).toEqual({ theirs: 1 });
  });
});

describe('ensureClaudeLegacyBypassAccepted (Claude Code 2.0.x keeps the acceptance in ~/.claude.json)', () => {
  beforeEach(() => {
    fakeHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-bypass-legacy-')));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });
  const configPath = (): string => join(fakeHome, '.claude.json');

  it('leaves a host without ~/.claude.json alone (Claude Code makes it itself)', async () => {
    expect(await ensureClaudeLegacyBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'absent' });
    expect(existsSync(configPath())).toBe(false);
  });

  it('adds the key and keeps everything else', async () => {
    writeFileSync(configPath(), JSON.stringify({ numStartups: 3, projects: { '/a': { hasTrustDialogAccepted: true } } }));
    expect(await ensureClaudeLegacyBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'accepted' });
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ numStartups: 3, projects: { '/a': { hasTrustDialogAccepted: true } }, bypassPermissionsModeAccepted: true });
    expect(await ensureClaudeLegacyBypassAccepted(transportWithHome(fakeHome))).toEqual({ action: 'already_accepted' });
  });

  it('skips a file that is not valid JSON without touching it', async () => {
    writeFileSync(configPath(), '{not json');
    expect(await ensureClaudeLegacyBypassAccepted(transportWithHome(fakeHome))).toMatchObject({ action: 'skipped' });
    expect(readFileSync(configPath(), 'utf8')).toBe('{not json');
  });

  it('loses neither this change nor a folder trust registered at the same time (one lock on one file)', async () => {
    writeFileSync(configPath(), JSON.stringify({ projects: {} }));
    const transport = transportWithHome(fakeHome);
    await Promise.all([ensureClaudeLegacyBypassAccepted(transport), ensureClaudeTrust(transport, '/wt-a'), ensureClaudeTrust(transport, '/wt-b')]);
    const config = JSON.parse(readFileSync(configPath(), 'utf8'));
    expect(config.bypassPermissionsModeAccepted).toBe(true);
    expect(Object.keys(config.projects).length).toBeGreaterThanOrEqual(2);
  });
});

describe('~/.claude.json as a symbolic link (folder trust and the 2.0.x acceptance)', () => {
  beforeEach(() => {
    fakeHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-json-link-')));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });
  const linkPath = (): string => join(fakeHome, '.claude.json');
  const targetPath = (): string => join(fakeHome, 'dotfiles', 'claude.json');
  const readTarget = (): { bypassPermissionsModeAccepted?: boolean; projects: Record<string, unknown> } => JSON.parse(readFileSync(targetPath(), 'utf8'));

  // Windows では symlink に権限が要る
  describe.skipIf(process.platform === 'win32')('with a real link', () => {
    beforeEach(() => {
      mkdirSync(join(fakeHome, 'dotfiles'));
    });

    it('writes both updates through the link and keeps the link, even when they run at once', async () => {
      writeFileSync(targetPath(), JSON.stringify({ numStartups: 1, projects: {} }));
      symlinkSync(targetPath(), linkPath());
      const transport = transportWithHome(fakeHome);
      const results = await Promise.all([
        ensureClaudeLegacyBypassAccepted(transport),
        ensureClaudeTrust(transport, '/wt-a'),
        ensureClaudeTrust(transport, '/wt-b'),
      ]);
      expect(results.map((r) => r.action).sort()).toEqual(['accepted', 'registered', 'registered']);
      expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
      const config = readTarget();
      expect(config.bypassPermissionsModeAccepted).toBe(true);
      expect(Object.keys(config.projects).length).toBeGreaterThanOrEqual(2);
    });

    it('loses nothing when one home reaches the file by its link and another by its real path, at the same time', async () => {
      const otherHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-json-link-other-')));
      try {
        writeFileSync(join(otherHome, '.claude.json'), JSON.stringify({ projects: {} }));
        symlinkSync(join(otherHome, '.claude.json'), linkPath());
        const viaLink = transportWithHome(fakeHome);
        const viaRealPath = transportWithHome(otherHome);
        const results = await Promise.all([
          ensureClaudeLegacyBypassAccepted(viaLink),
          ensureClaudeTrust(viaRealPath, '/wt-a'),
          ensureClaudeTrust(viaLink, '/wt-b'),
          ensureClaudeLegacyBypassAccepted(viaRealPath),
        ]);
        expect(results.every((r) => r.action === 'accepted' || r.action === 'registered' || r.action === 'already_accepted')).toBe(true);
        const config = JSON.parse(readFileSync(join(otherHome, '.claude.json'), 'utf8'));
        expect(config.bypassPermissionsModeAccepted).toBe(true);
        expect(Object.keys(config.projects)).toEqual(expect.arrayContaining([...claudeProjectKeys(process.platform === 'win32' ? 'win32' : 'linux', '/wt-a'), ...claudeProjectKeys(process.platform === 'win32' ? 'win32' : 'linux', '/wt-b')]));
      } finally {
        rmSync(otherHome, { recursive: true, force: true });
      }
    });

    it('treats a dangling link as a missing file', async () => {
      symlinkSync(targetPath(), linkPath());
      const transport = transportWithHome(fakeHome);
      expect(await ensureClaudeLegacyBypassAccepted(transport)).toEqual({ action: 'absent' });
      expect(await ensureClaudeTrust(transport, '/wt')).toEqual({ action: 'skipped', reason: '~/.claude.json not found' });
      expect(existsSync(targetPath())).toBe(false);
      expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    });
  });

  /** The real file operations, except that the link's path resolves to the target and the file operations refuse the link's own path (as the host's do). */
  function transportWithResolvedLink(): { transport: IServerTransport; touched: string[] } {
    const real = transportWithHome(fakeHome).files();
    const touched: string[] = [];
    const guard = (p: string): void => {
      touched.push(p);
      if (p === linkPath()) throw new FileOpsError('SYMLINK_REFUSED', 'refused');
    };
    const ops = {
      ...real,
      platform: real.platform,
      realpath: async (p: string) => (p === linkPath() ? targetPath() : real.realpath(p)),
      read: async (p: string) => (guard(p), real.read(p)),
      write: async (p: string, ...rest: unknown[]) => (guard(p), (real.write as (...a: unknown[]) => Promise<unknown>)(p, ...rest)),
    } as unknown as IFileOps;
    return { transport: { files: () => ops } as unknown as IServerTransport, touched };
  }

  it('reads and writes the resolved path and serialises both updates on it (no symbolic link needed)', async () => {
    mkdirSync(join(fakeHome, 'dotfiles'));
    writeFileSync(targetPath(), JSON.stringify({ projects: {} }));
    const { transport, touched } = transportWithResolvedLink();
    await Promise.all([ensureClaudeLegacyBypassAccepted(transport), ensureClaudeTrust(transport, '/wt-a'), ensureClaudeTrust(transport, '/wt-b')]);
    expect(touched).not.toContain(linkPath());
    const config = readTarget();
    expect(config.bypassPermissionsModeAccepted).toBe(true);
    expect(Object.keys(config.projects).length).toBeGreaterThanOrEqual(2);
  });
});

describe('prepareClaudeLaunch', () => {
  beforeEach(() => {
    fakeHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-prepare-')));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('accepts the dialog in both files and reports each', async () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{}');
    const reports: Record<string, unknown>[] = [];
    await prepareClaudeLaunch(transportWithHome(fakeHome), (entry) => reports.push(entry));
    expect(reports).toEqual([
      { type: 'claude_bypass_accepted', file: 'settings.json' },
      { type: 'claude_bypass_accepted', file: '.claude.json' },
    ]);
  });

  it('reports a failure and a skip instead of throwing', async () => {
    mkdirSync(claudeDir());
    writeFileSync(settingsPath(), '{not json');
    const broken = { files: () => { throw new Error('host unreachable'); } } as unknown as IServerTransport;
    const reports: Record<string, unknown>[] = [];
    await prepareClaudeLaunch(transportWithHome(fakeHome), (entry) => reports.push(entry));
    await prepareClaudeLaunch(broken, (entry) => reports.push(entry));
    expect(reports).toEqual([
      { type: 'claude_bypass_skipped', file: 'settings.json', reason: expect.stringContaining('not valid JSON') },
      { type: 'claude_bypass_failed', file: 'settings.json', reason: 'host unreachable' },
      { type: 'claude_bypass_failed', file: '.claude.json', reason: 'host unreachable' },
    ]);
  });
});

describe('ensureClaudeBypassAccepted on a Windows host', () => {
  it('resolves ~ and joins the path with backslashes', async () => {
    const files = new Map<string, string>();
    const dirs: string[] = [];
    const ops = {
      platform: 'win32' as HostPlatform,
      realpath: async (p: string) => (p === '~' ? 'C:\\Users\\me' : p),
      read: async (p: string) => {
        const text = files.get(p);
        if (text === undefined) throw new FileOpsError('NOT_FOUND', p);
        return { data: Buffer.from(text) };
      },
      create: async (p: string, kind: 'file' | 'directory') => {
        if (kind === 'directory') dirs.push(p);
        else files.set(p, '');
        return { created: true };
      },
      write: async (p: string, data: Buffer) => {
        files.set(p, data.toString('utf8'));
        return {};
      },
    } as unknown as IFileOps;
    const transport = { files: () => ops } as unknown as IServerTransport;

    expect(await ensureClaudeBypassAccepted(transport)).toEqual({ action: 'accepted' });
    expect(dirs).toEqual(['C:\\Users\\me\\.claude']);
    expect([...files.keys()]).toEqual(['C:\\Users\\me\\.claude\\settings.json']);
    expect(JSON.parse(files.get('C:\\Users\\me\\.claude\\settings.json') ?? '')).toEqual({ skipDangerousModePermissionPrompt: true });
    expect(await ensureClaudeBypassAccepted(transport)).toEqual({ action: 'already_accepted' });
  });
});
