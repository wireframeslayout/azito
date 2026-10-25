import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import type { HostPlatform } from '../../../shared/os/hostEnv';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import { ensureClaudeBypassAccepted } from './ensureClaudeBypassAccepted';

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
      create: async (p: string) => {
        dirs.push(p);
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
