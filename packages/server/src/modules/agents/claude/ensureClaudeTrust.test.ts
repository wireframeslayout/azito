import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import { claudeProjectKeys, ensureClaudeTrust } from './ensureClaudeTrust';

let fakeHome: string;

/** The keys Claude Code may file a project under on the machine running the test (both spellings on Windows, the path as it is elsewhere). */
const keysOf = (p: string): string[] => claudeProjectKeys(process.platform === 'win32' ? 'win32' : 'linux', p);
/** The registration of `p`, read back under every key (they are all the same entry). */
const registered = (projects: Record<string, unknown>, p: string): unknown[] => keysOf(p).map((k) => projects[k]);
const entriesFor = (p: string, value: unknown): Record<string, unknown> => Object.fromEntries(keysOf(p).map((k) => [k, value]));

/** A transport whose host is this machine with `homeDir` as its home directory: the file operations are the real ones. */
function transportWithHome(homeDir: string): IServerTransport {
  const ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir }));
  return { files: () => ops } as unknown as IServerTransport;
}

const configPath = (): string => join(fakeHome, '.claude.json');
const readConfig = (): { projects: Record<string, Record<string, unknown>> } =>
  JSON.parse(readFileSync(configPath(), 'utf8'));

describe('ensureClaudeTrust', () => {
  beforeEach(() => {
    fakeHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-trust-')));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('registers trust for a new project', async () => {
    writeFileSync(configPath(), JSON.stringify({ projects: {} }));
    expect(await ensureClaudeTrust(transportWithHome(fakeHome), '/wt')).toEqual({ action: 'registered' });
    expect(registered(readConfig().projects, '/wt')).toEqual(keysOf('/wt').map(() => ({ hasTrustDialogAccepted: true })));
    expect(readdirSync(fakeHome)).toEqual(['.claude.json']);
  });

  it('returns already_trusted without rewriting', async () => {
    const original = JSON.stringify({ projects: entriesFor('/wt', { hasTrustDialogAccepted: true }) });
    writeFileSync(configPath(), original);
    expect(await ensureClaudeTrust(transportWithHome(fakeHome), '/wt')).toEqual({ action: 'already_trusted' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it('returns failed for invalid JSON', async () => {
    writeFileSync(configPath(), '{not json');
    const result = await ensureClaudeTrust(transportWithHome(fakeHome), '/wt');
    expect(result.action).toBe('failed');
  });

  it('returns skipped when the file does not exist', async () => {
    expect(await ensureClaudeTrust(transportWithHome(fakeHome), '/wt')).toEqual({
      action: 'skipped',
      reason: '~/.claude.json not found',
    });
  });

  // Windows では動かない: mode 前提（Windows には POSIX の mode が無い）
  it.skipIf(process.platform === 'win32')('preserves file permissions after write', async () => {
    writeFileSync(configPath(), JSON.stringify({ projects: {} }), { mode: 0o600 });
    chmodSync(configPath(), 0o600);
    await ensureClaudeTrust(transportWithHome(fakeHome), '/wt');
    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('preserves existing fields and other projects', async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        numStartups: 3,
        projects: { ...entriesFor('/wt', { allowedTools: ['Bash'], hasTrustDialogAccepted: false }), ...entriesFor('/other', { x: 1 }) },
      }),
    );
    expect(await ensureClaudeTrust(transportWithHome(fakeHome), '/wt')).toEqual({ action: 'registered' });
    const config = readConfig() as unknown as { numStartups: number; projects: Record<string, unknown> };
    expect(config.numStartups).toBe(3);
    expect(registered(config.projects, '/other')).toEqual(keysOf('/other').map(() => ({ x: 1 })));
    expect(registered(config.projects, '/wt')).toEqual(keysOf('/wt').map(() => ({ allowedTools: ['Bash'], hasTrustDialogAccepted: true })));
  });

  it('keeps both registrations when two projects register at the same time', async () => {
    writeFileSync(configPath(), JSON.stringify({ projects: {} }));
    const transport = transportWithHome(fakeHome);
    const results = await Promise.all(['/a', '/b', '/c'].map((p) => ensureClaudeTrust(transport, p)));
    expect(results.map((r) => r.action)).toEqual(['registered', 'registered', 'registered']);
    expect(Object.keys(readConfig().projects).sort()).toEqual(['/a', '/b', '/c'].flatMap(keysOf).sort());
  });

  it('does not overwrite a file that changed after it was read', async () => {
    writeFileSync(configPath(), JSON.stringify({ projects: {} }));
    const real = transportWithHome(fakeHome).files();
    const racing = {
      files: () => ({
        ...real,
        platform: real.platform,
        realpath: real.realpath.bind(real),
        read: async (...args: Parameters<typeof real.read>) => {
          const content = await real.read(...args);
          writeFileSync(configPath(), JSON.stringify({ projects: { '/theirs': {} } }));
          return content;
        },
        write: real.write.bind(real),
      }),
    } as unknown as IServerTransport;
    const result = await ensureClaudeTrust(racing, '/wt');
    expect(result.action).toBe('failed');
    expect(readConfig().projects).toEqual({ '/theirs': {} });
  });
});

describe('claudeProjectKeys', () => {
  // 2.1.x files a Windows project under the forward-slash form (wq), 2.0.x under the backslash form: both are written.
  it('is the forward-slash and the backslash form on Windows, whichever way the path was written', () => {
    const both = ['C:/Users/me/repo', 'C:\\Users\\me\\repo'];
    expect(claudeProjectKeys('win32', 'C:/Users/me/repo')).toEqual(both);
    expect(claudeProjectKeys('win32', 'C:\\Users\\me\\repo')).toEqual(both);
    expect(claudeProjectKeys('win32', 'C:\\Users\\me\\repo\\')).toEqual(both);
    expect(claudeProjectKeys('win32', '\\\\?\\C:\\Users\\me\\repo')).toEqual(both);
    expect(claudeProjectKeys('win32', 'C:\\Users\\me\\a b\\..\\日本語')).toEqual(['C:/Users/me/日本語', 'C:\\Users\\me\\日本語']);
  });

  it('keeps a drive root and a UNC share', () => {
    expect(claudeProjectKeys('win32', 'C:\\')).toEqual(['C:/', 'C:\\']);
    expect(claudeProjectKeys('win32', '\\\\host\\share\\repo')).toEqual(['//host/share/repo', '\\\\host\\share\\repo']);
  });

  it('leaves a Unix path alone', () => {
    expect(claudeProjectKeys('linux', '/home/me/repo')).toEqual(['/home/me/repo']);
    expect(claudeProjectKeys('darwin', '/Users/me/repo/')).toEqual(['/Users/me/repo/']);
  });
});
