import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnvFile, resolveEnvFilePath, resolveHubEnv } from './env';

describe('env', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-env-'));
    file = path.join(dir, 'azitoctl.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses plain %q values', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://localhost:3001\nAZITO_WEBHOOK_TOKEN=abc123\n');
    const env = resolveHubEnv({}, file);
    expect(env).toEqual({ url: 'http://localhost:3001', token: 'abc123' });
  });

  it('decodes backslash-escaped %q values (spaces, quotes, dollars)', () => {
    // printf '%q' 'a b$c"d' -> a\ b\$c\"d
    fs.writeFileSync(file, 'AZITO_URL=http://h/\nAZITO_WEBHOOK_TOKEN=a\\ b\\$c\\"d\n');
    const env = resolveHubEnv({}, file);
    expect(env?.token).toBe('a b$c"d');
  });

  it('prefers process env over the file', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://from-file\nAZITO_WEBHOOK_TOKEN=file-token\n');
    const env = resolveHubEnv({ AZITO_URL: 'http://from-env' }, file);
    expect(env).toEqual({ url: 'http://from-env', token: 'file-token' });
  });

  it('returns null when the file is missing and env is empty', () => {
    expect(resolveHubEnv({}, path.join(dir, 'nope.env'))).toBeNull();
  });

  it('returns null when only one of the two values resolves', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://localhost:3001\n');
    expect(resolveHubEnv({}, file)).toBeNull();
  });

  it('never throws on unreadable/garbage content', () => {
    fs.writeFileSync(file, '\x00\x01 not = an env file\n====\n');
    expect(() => resolveHubEnv({}, file)).not.toThrow();
  });

  it('parseEnvFile skips comments and blank lines', () => {
    const values = parseEnvFile('# comment\n\nKEY=value\n');
    expect(values).toEqual({ KEY: 'value' });
  });
});

describe('resolveEnvFilePath', () => {
  it('returns azitoctl.env when AZITO_PREFIX is unset', () => {
    const p = resolveEnvFilePath({});
    expect(p).toBe(path.join(os.homedir(), '.azito', 'azitoctl.env'));
  });

  it('returns azitoctl-<prefix>.env when AZITO_PREFIX is valid', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: 'dev' });
    expect(p).toBe(path.join(os.homedir(), '.azito', 'azitoctl-dev.env'));
  });

  it('accepts hyphens and digits in prefix', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: 'staging-2' });
    expect(p).toBe(path.join(os.homedir(), '.azito', 'azitoctl-staging-2.env'));
  });

  it('ignores path-traversal prefix (../x)', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: '../x' });
    expect(p).toBe(path.join(os.homedir(), '.azito', 'azitoctl.env'));
  });

  it('ignores prefix with uppercase letters', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: 'Dev' });
    expect(p).toBe(path.join(os.homedir(), '.azito', 'azitoctl.env'));
  });

  it('ignores prefix with spaces', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: 'a b' });
    expect(p).toBe(path.join(os.homedir(), '.azito', 'azitoctl.env'));
  });

  it('ignores empty string prefix', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: '' });
    expect(p).toBe(path.join(os.homedir(), '.azito', 'azitoctl.env'));
  });
});

describe('resolveHubEnv with AZITO_PREFIX', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-prefix-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads azitoctl-dev.env when AZITO_PREFIX=dev (via resolveEnvFilePath default)', () => {
    const prefixFile = path.join(dir, 'azitoctl-dev.env');
    fs.writeFileSync(prefixFile, 'AZITO_URL=http://dev-hub\nAZITO_WEBHOOK_TOKEN=dev-token\n');
    const env = resolveHubEnv({ AZITO_PREFIX: 'dev' }, prefixFile);
    expect(env).toEqual({ url: 'http://dev-hub', token: 'dev-token' });
  });

  it('falls back to azitoctl.env when AZITO_PREFIX is invalid', () => {
    const defaultFile = path.join(dir, 'azitoctl.env');
    fs.writeFileSync(defaultFile, 'AZITO_URL=http://default-hub\nAZITO_WEBHOOK_TOKEN=default-token\n');
    const env = resolveHubEnv({ AZITO_PREFIX: '../x' }, defaultFile);
    expect(env).toEqual({ url: 'http://default-hub', token: 'default-token' });
  });

  it('process env AZITO_URL still takes priority over env file with prefix', () => {
    const prefixFile = path.join(dir, 'azitoctl-dev.env');
    fs.writeFileSync(prefixFile, 'AZITO_URL=http://file-url\nAZITO_WEBHOOK_TOKEN=file-token\n');
    const env = resolveHubEnv({ AZITO_PREFIX: 'dev', AZITO_URL: 'http://env-url' }, prefixFile);
    expect(env).toEqual({ url: 'http://env-url', token: 'file-token' });
  });
});
