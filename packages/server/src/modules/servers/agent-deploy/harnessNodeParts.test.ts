import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { CREATE_SCRIPT, PROTECT_CHANGED, PROTECT_SCRIPT, PROTECT_UNCHANGED } from '../../../shared/os/windowsSecretFileGuard';

const HARNESS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'harness');
const load = (...parts: string[]): Promise<any> => import(pathToFileURL(path.join(HARNESS_DIR, ...parts)).href);

describe('harness/lib/winAclScripts.mjs', () => {
  it('is the same PowerShell as the hub\'s SecretFileGuard (setup.mjs cannot import the TypeScript, so it repeats it)', async () => {
    const copy = await load('lib', 'winAclScripts.mjs');
    expect(copy.PROTECT_SCRIPT).toBe(PROTECT_SCRIPT);
    expect(copy.CREATE_SCRIPT).toBe(CREATE_SCRIPT);
    expect(copy.PROTECT_CHANGED).toBe(PROTECT_CHANGED);
    expect(copy.PROTECT_UNCHANGED).toBe(PROTECT_UNCHANGED);
  });
});

describe('azito-hook.mjs env file', () => {
  it('reads the Windows form it is written in, whatever the value holds', async () => {
    const { parseEnvFile } = await load('hooks', 'azito-hook.mjs');
    const { formatEnvLine } = await load('lib', 'envFiles.mjs');
    const values = { A: 'plain', B: 'with space', C: 'quote " and \\ backslash', D: '$HOME `x`', E: 'こんにちは', F: 'line\nbreak', G: '' };
    const text = Object.entries(values).map(([k, v]) => formatEnvLine(k, v)).join('\r\n');
    expect(parseEnvFile(text)).toEqual(values);
  });

  it('reads plain and single-quoted values, and leaves out the bash %q forms it would misread', async () => {
    const { parseEnvFile } = await load('hooks', 'azito-hook.mjs');
    const text = ['AZITO_URL=http://h:3001', "AZITO_SERVER_NAME='The Mirano'", 'X=The\\ Mirano', "Y=$'a\\nb'", 'Z="unterminated', '# comment', 'not a line'].join('\n');
    expect(parseEnvFile(text)).toEqual({ AZITO_URL: 'http://h:3001', AZITO_SERVER_NAME: 'The Mirano' });
  });
});

describe('hook command line', () => {
  it('is the same text for Git Bash and PowerShell: forward slashes, double quotes, no expansion', async () => {
    const { hookCommand } = await load('lib', 'claudeSettings.mjs');
    expect(hookCommand('C:\\Users\\me\\.azito\\harness\\hooks\\azito-hook.mjs', 'activity', 'stop', 'prod'))
      .toBe('node "C:/Users/me/.azito/harness/hooks/azito-hook.mjs" activity stop --prefix prod');
    expect(hookCommand('C:\\Users\\Jane Doe\\h\\azito-hook.mjs', 'session', '', '')).toBe('node "C:/Users/Jane Doe/h/azito-hook.mjs" session');
  });

  it('refuses what either shell would expand', async () => {
    const { hookCommand } = await load('lib', 'claudeSettings.mjs');
    expect(() => hookCommand('C:\\Users\\a$b\\azito-hook.mjs', 'session', '', '')).toThrow('hook のパス');
    expect(() => hookCommand('C:\\x\\azito-hook.mjs', 'session', '', 'a;b')).toThrow('--prefix');
  });
});
