import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import type { IFileOps } from '../../../shared/fs/fileOps';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import { readHarnessCheck } from '../harnessCheck';
import { HarnessInstaller, type HarnessInstallOptions } from './HarnessInstaller';
import { buildNodeSetupInvocation } from './harnessNodeSetup';
import type { SshClient } from '../ssh/SshClient';

// The Windows route of the harness install, driven with the real IFileOps over a temporary "agent" home directory (the
// path notation is the test machine's; the route itself only ever asks the host's IFileOps and `run`).
const WIN32 = { platform: 'win32' as const, arch: 'x64' as const };
const OK: CommandResult = { exitCode: 0, signal: null, stdout: '', stderr: '' };

let home: string;
let files: IFileOps;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-win-'));
  files = new LocalFileOps(localFileOpsHost({ platform: process.platform === 'win32' ? 'win32' : 'linux', homeDir: home }));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const options = (extra: Partial<HarnessInstallOptions> = {}): HarnessInstallOptions => ({
  hostProfile: WIN32, azitoUrl: 'http://hub:3001', webhookToken: 'wh-secret', uiToken: 'ui-secret', serverName: 'win-agent', ...extra,
});

describe('HarnessInstaller.installOnAgent', () => {
  it('writes the harness through the agent\'s file operations and runs setup.mjs with the tokens in the environment only', async () => {
    const run = vi.fn(async (spec: CommandSpec): Promise<CommandResult> => {
      // by the time setup runs, the harness is in place
      expect(fs.existsSync(spec.args[0])).toBe(true);
      return OK;
    });
    const result = await new HarnessInstaller({} as SshClient).installOnAgent({ files: () => files, run }, options({ version: 'v-hash' }));

    expect(result.success).toBe(true);
    const harnessDir = path.join(home, '.azito', 'harness');
    expect(fs.existsSync(path.join(harnessDir, 'setup.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(harnessDir, 'hooks', 'azito-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(harnessDir, 'lib', 'secretFile.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(harnessDir, 'skills', 'azt-plan', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(harnessDir, 'VERSION'), 'utf8').trim()).toBe('v-hash');
    expect(fs.readdirSync(path.join(home, '.azito'))).toEqual(['harness']);

    const [spec] = run.mock.calls[0];
    expect(spec.file).toBe('node');
    expect(spec.args).toEqual([path.join(harnessDir, 'setup.mjs'), '--azito-url', 'http://hub:3001', '--server-name', 'win-agent']);
    expect(JSON.stringify(spec.args)).not.toMatch(/secret/);
    expect(spec.env).toMatchObject({ AZITO_WEBHOOK_TOKEN: 'wh-secret', AZITO_UI_TOKEN: 'ui-secret', AZITO_URL: '', AZITO_PREFIX: '' });
  });

  it('replaces an older harness as a whole and uses the prefix\'s own directory', async () => {
    const dir = path.join(home, '.azito', 'harness-dev');
    fs.mkdirSync(path.join(dir, 'gone'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gone', 'old.txt'), 'old');
    const run = vi.fn(async (_spec: CommandSpec): Promise<CommandResult> => OK);
    await new HarnessInstaller({} as SshClient).installOnAgent({ files: () => files, run }, options({ prefix: 'dev' }));
    expect(fs.existsSync(path.join(dir, 'gone'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'setup.mjs'))).toBe(true);
    expect(run.mock.calls[0][0].args).toContain('--prefix');
  });

  it('withholds the UI token from an isolation-intent server and has setup purge it', async () => {
    const run = vi.fn(async (_spec: CommandSpec): Promise<CommandResult> => OK);
    await new HarnessInstaller({} as SshClient).installOnAgent({ files: () => files, run }, options({ isolationIntent: true }));
    const [spec] = run.mock.calls[0];
    expect(spec.args).toContain('--purge-operator-token');
    expect(spec.env).toMatchObject({ AZITO_WEBHOOK_TOKEN: 'wh-secret', AZITO_UI_TOKEN: '' });
  });

  it('reports a failing setup with its stderr, and writes no VERSION', async () => {
    const run = vi.fn(async (_spec: CommandSpec): Promise<CommandResult> => ({ ...OK, exitCode: 3, stderr: 'boom' }));
    const result = await new HarnessInstaller({} as SshClient).installOnAgent({ files: () => files, run }, options({ version: 'v1' }));
    expect(result).toMatchObject({ success: false, error: 'setup.mjs failed (exit 3): boom' });
    expect(fs.existsSync(path.join(home, '.azito', 'harness', 'VERSION'))).toBe(false);
  });

  it('a transfer that stops half way leaves no staging directory and no half harness', async () => {
    const failing: IFileOps = Object.create(files);
    let writes = 0;
    failing.write = async (p, data, o) => {
      if (++writes === 5) throw new Error('disk full');
      return files.write(p, data, o);
    };
    const run = vi.fn(async (_spec: CommandSpec): Promise<CommandResult> => OK);
    const result = await new HarnessInstaller({} as SshClient).installOnAgent({ files: () => failing, run }, options());
    expect(result).toMatchObject({ success: false, error: 'disk full' });
    expect(run).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(home, '.azito'))).toEqual([]);
  });

  it('is only the Windows route', async () => {
    await expect(new HarnessInstaller({} as SshClient).installOnAgent({ files: () => files, run: vi.fn() }, options({ hostProfile: { platform: 'linux', arch: 'x64' } })))
      .rejects.toThrow('Windows route');
  });
});

describe('buildNodeSetupInvocation', () => {
  it('keeps every secret out of the arguments and every unset option out of the ambient environment', () => {
    const { args, env } = buildNodeSetupInvocation({ azitoUrl: 'u', webhookToken: 'w', uiToken: 't', serverName: 's', prefix: 'p' });
    expect(args).toEqual(['--azito-url', 'u', '--server-name', 's', '--prefix', 'p']);
    expect(env).toEqual({ AZITO_URL: '', AZITO_SERVER_NAME: '', AZITO_PREFIX: '', AZITO_WEBHOOK_TOKEN: 'w', AZITO_UI_TOKEN: 't' });
    expect(buildNodeSetupInvocation({}).env.AZITO_WEBHOOK_TOKEN).toBe('');
  });
});

describe('readHarnessCheck', () => {
  it('is empty when nothing is installed', async () => {
    expect(await readHarnessCheck(files)).toBe('');
  });

  it('names the harness copy and its VERSION', async () => {
    fs.mkdirSync(path.join(home, '.azito', 'harness-dev', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, '.azito', 'harness-dev', 'VERSION'), 'abc\n');
    expect(await readHarnessCheck(files, 'dev')).toBe(`${path.join(home, '.azito', 'harness-dev', 'skills')}\nabc\n`);
  });

  it('falls back to an azt-* skill in ~/.claude/skills (an install by hand), with no version', async () => {
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'azt-plan'), { recursive: true });
    const text = await readHarnessCheck(files);
    expect(text.split('\n')[0]).toContain('azt-plan');
    expect(text.split('\n')[1]).toBe('');
  });
});
