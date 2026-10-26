import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import { FileOpsError } from '../../../shared/fs/fileOps';
import type { LocalAgentHomes } from '../agentHomes';
import { codexProjectKey, ensureCodexTrust } from './ensureCodexTrust';

let fakeHome: string;
const noHomes: LocalAgentHomes = { claudeConfigDir: null, codexHome: null };

/** A transport whose host is this machine with `homeDir` as its home directory: the file operations are the real ones. */
function transportWithHome(homeDir: string): IServerTransport {
  const ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir }));
  return { files: () => ops } as unknown as IServerTransport;
}

const configPath = (): string => join(fakeHome, '.codex', 'config.toml');
const trust = (path: string, homes: LocalAgentHomes = noHomes, isLocal = false) => ensureCodexTrust(transportWithHome(fakeHome), path, homes, isLocal);

describe('ensureCodexTrust', () => {
  beforeEach(() => {
    fakeHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-trust-')));
    mkdirSync(join(fakeHome, '.codex'));
  });
  // Paths of this machine: a Windows runner writes them with backslashes, so the expected section is built the way the module spells it.
  const dirOf = (name: string): string => join(fakeHome, name);
  const keyOf = (path: string): string => codexProjectKey(process.platform === 'win32' ? 'win32' : 'posix', path);
  const section = (path: string, level = 'trusted'): string => `[projects.${JSON.stringify(keyOf(path))}]\ntrust_level = "${level}"\n`;
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('creates config.toml with the project\'s section when the file does not exist', async () => {
    expect(await trust(dirOf('wt'))).toEqual({ action: 'registered', key: keyOf(dirOf('wt')) });
    expect(readFileSync(configPath(), 'utf8')).toBe(section(dirOf('wt')));
  });

  it('creates the codex home too when it is missing', async () => {
    rmSync(join(fakeHome, '.codex'), { recursive: true });
    expect((await trust(dirOf('wt'))).action).toBe('registered');
    expect(existsSync(configPath())).toBe(true);
  });

  it('keeps everything the file already holds (comments, order, other projects) and only appends the new section', async () => {
    const original = [
      '# my codex settings',
      'model = "gpt-5.6-sol"',
      '',
      '[mcp_servers.azt-mcp]',
      'command = "azt-mcp"   # keep this comment',
      '',
      section(dirOf('other'), 'untrusted').trimEnd(),
      '',
    ].join('\n');
    writeFileSync(configPath(), original);
    expect((await trust(dirOf('wt'))).action).toBe('registered');
    expect(readFileSync(configPath(), 'utf8')).toBe(`${original}\n${section(dirOf('wt'))}`);
  });

  it('separates the new section from a file that does not end with a newline', async () => {
    writeFileSync(configPath(), 'model = "x"');
    expect((await trust(dirOf('wt'))).action).toBe('registered');
    expect(readFileSync(configPath(), 'utf8')).toBe(`model = "x"\n\n${section(dirOf('wt'))}`);
  });

  it('returns already_trusted without rewriting', async () => {
    const original = section(dirOf('wt'));
    writeFileSync(configPath(), original);
    expect(await trust(dirOf('wt'))).toEqual({ action: 'already_trusted' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it('does not override a person\'s "untrusted"', async () => {
    const original = section(dirOf('wt'), 'untrusted');
    writeFileSync(configPath(), original);
    expect(await trust(dirOf('wt'))).toMatchObject({ action: 'skipped' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it('does not write a file that is not valid TOML, and says why', async () => {
    writeFileSync(configPath(), 'model = = broken\n[projects');
    const result = await trust('/wt');
    expect(result).toMatchObject({ action: 'failed' });
    expect(readFileSync(configPath(), 'utf8')).toBe('model = = broken\n[projects');
  });

  it('does not write when the project already has a table without a trust level (a duplicate table would break the file)', async () => {
    const original = `[projects.${JSON.stringify(keyOf(dirOf('wt')))}]\nnote = "x"\n`;
    writeFileSync(configPath(), original);
    expect(await trust(dirOf('wt'))).toMatchObject({ action: 'failed' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it('does not write when projects is an inline table it cannot extend', async () => {
    const original = 'projects = { "/a" = { trust_level = "trusted" } }\n';
    writeFileSync(configPath(), original);
    expect(await trust(dirOf('wt'))).toMatchObject({ action: 'failed' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32')('escapes a path with a quote or a backslash so the section stays valid TOML', async () => {
    writeFileSync(configPath(), '');
    expect((await trust('/wt/a"b\\c')).action).toBe('registered');
    // read back through codex's own reading of the file (smol-toml, as the module does)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parse } = require('smol-toml') as { parse: (raw: string) => { projects: Record<string, { trust_level: string }> } };
    expect(parse(readFileSync(configPath(), 'utf8')).projects['/wt/a"b\\c']).toEqual({ trust_level: 'trusted' });
  });

  it.skipIf(process.platform === 'win32')('keeps the file\'s permission bits and leaves no temporary file behind', async () => {
    writeFileSync(configPath(), 'model = "x"\n', { mode: 0o600 });
    chmodSync(configPath(), 0o600);
    await trust(dirOf('wt'));
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(fakeHome, '.codex'))).toEqual(['config.toml']);
  });

  it('keeps both registrations when two tasks register at the same time', async () => {
    writeFileSync(configPath(), 'model = "x"\n');
    const dirs = ['a', 'b', 'c'].map(dirOf);
    const results = await Promise.all(dirs.map((p) => trust(p)));
    expect(results.map((r) => r.action)).toEqual(['registered', 'registered', 'registered']);
    const text = readFileSync(configPath(), 'utf8');
    for (const p of dirs) expect(text).toContain(section(p));
  });

  it('writes under CODEX_HOME for the hub\'s own server, and under ~/.codex for any other', async () => {
    const codexHome = join(fakeHome, 'elsewhere');
    mkdirSync(codexHome);
    await trust(dirOf('local-wt'), { claudeConfigDir: null, codexHome }, true);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain(section(dirOf('local-wt')));
    expect(existsSync(configPath())).toBe(false);
    await trust(dirOf('agent-wt'), { claudeConfigDir: null, codexHome }, false);
    expect(readFileSync(configPath(), 'utf8')).toContain(section(dirOf('agent-wt')));
  });

  it('does not overwrite a file that changed after it was read', async () => {
    writeFileSync(configPath(), 'model = "x"\n');
    const real = transportWithHome(fakeHome).files();
    const racing = {
      files: () => ({
        platform: real.platform,
        realpath: real.realpath.bind(real),
        create: real.create.bind(real),
        write: real.write.bind(real),
        read: async (...args: Parameters<typeof real.read>) => {
          const content = await real.read(...args);
          writeFileSync(configPath(), 'model = "theirs"\n');
          return content;
        },
      }),
    } as unknown as IServerTransport;
    expect((await ensureCodexTrust(racing, dirOf('wt'), noHomes, false)).action).toBe('failed');
    expect(readFileSync(configPath(), 'utf8')).toBe('model = "theirs"\n');
  });
});

describe('codexProjectKey', () => {
  it('leaves a POSIX path as it is', () => {
    expect(codexProjectKey('posix', '/home/me/repo-wt')).toBe('/home/me/repo-wt');
  });

  // codex compares the key with the canonical path of the directory it runs in: backslashes, no trailing separator, no \\?\ prefix
  // (and lower-cased on both sides, so the case is not changed here).
  it('is the host\'s backslash spelling on Windows, however the path was written', () => {
    expect(codexProjectKey('win32', 'C:\\Users\\me\\repo')).toBe('C:\\Users\\me\\repo');
    expect(codexProjectKey('win32', 'C:/Users/me/repo')).toBe('C:\\Users\\me\\repo');
    expect(codexProjectKey('win32', 'C:\\Users\\me\\repo\\')).toBe('C:\\Users\\me\\repo');
    expect(codexProjectKey('win32', '\\\\?\\C:\\Users\\me\\repo')).toBe('C:\\Users\\me\\repo');
    expect(codexProjectKey('win32', 'C:\\Users\\me\\日本語 dir')).toBe('C:\\Users\\me\\日本語 dir');
    expect(codexProjectKey('win32', 'C:\\')).toBe('C:\\');
  });
});

describe('ensureCodexTrust on a Windows host', () => {
  function windowsTransport(initial: string | null): { transport: IServerTransport; written: () => string | null } {
    let content = initial;
    const ops = {
      platform: 'win32' as const,
      realpath: async (p: string) => (p === '~' ? 'C:\\Users\\me' : p),
      read: async () => {
        if (content === null) throw new FileOpsError('NOT_FOUND', 'missing');
        return { data: Buffer.from(content, 'utf8'), stat: {} };
      },
      create: async () => ({ created: true }),
      write: async (_p: string, data: Buffer) => {
        content = data.toString('utf8');
        return { mtimeMs: 0, sha256: '' };
      },
    };
    return { transport: { files: () => ops } as unknown as IServerTransport, written: () => content };
  }

  it('writes the backslash spelling under the codex home of the Windows user', async () => {
    const { transport, written } = windowsTransport(null);
    const result = await ensureCodexTrust(transport, 'C:\\Users\\me\\repo\\wt\\', noHomes, false);
    expect(result).toEqual({ action: 'registered', key: 'C:\\Users\\me\\repo\\wt' });
    expect(written()).toBe('[projects."C:\\\\Users\\\\me\\\\repo\\\\wt"]\ntrust_level = "trusted"\n');
  });

  it('finds an existing entry whatever its case (codex compares them lower-cased on Windows)', async () => {
    const original = '[projects."c:\\\\users\\\\ME\\\\Repo"]\ntrust_level = "trusted"\n';
    const { transport, written } = windowsTransport(original);
    expect(await ensureCodexTrust(transport, 'C:\\Users\\me\\repo', noHomes, false)).toEqual({ action: 'already_trusted' });
    expect(written()).toBe(original);
  });
});
