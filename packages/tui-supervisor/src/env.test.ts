import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnvFile, resolveEnvFilePath, resolveHubEnv, resolveMuxPaneRef } from './env';

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
    const result = resolveHubEnv({}, file);
    expect(result).toEqual({ ok: true, env: { url: 'http://localhost:3001', token: 'abc123' } });
  });

  it('decodes backslash-escaped %q values (spaces, quotes, dollars)', () => {
    // printf '%q' 'a b$c"d' -> a\ b\$c\"d
    fs.writeFileSync(file, 'AZITO_URL=http://h/\nAZITO_WEBHOOK_TOKEN=a\\ b\\$c\\"d\n');
    const result = resolveHubEnv({}, file);
    expect(result.ok && result.env.token).toBe('a b$c"d');
  });

  it('prefers a complete process env over the file', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://from-file\nAZITO_WEBHOOK_TOKEN=file-token\n');
    const result = resolveHubEnv({ AZITO_URL: 'http://from-env', AZITO_WEBHOOK_TOKEN: 'env-token' }, file);
    expect(result).toEqual({ ok: true, env: { url: 'http://from-env', token: 'env-token' } });
  });

  it('takes the pair from the file when the env has only one of them (the file token never goes to the env URL)', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://from-file\nAZITO_WEBHOOK_TOKEN=file-token\n');
    expect(resolveHubEnv({ AZITO_URL: 'http://from-env' }, file)).toEqual({ ok: true, env: { url: 'http://from-file', token: 'file-token' } });
    expect(resolveHubEnv({ AZITO_WEBHOOK_TOKEN: 'env-token' }, file)).toEqual({ ok: true, env: { url: 'http://from-file', token: 'file-token' } });
  });

  it('does not complete a file that lacks a value with the env\'s (no mixing)', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://from-file\n');
    expect(resolveHubEnv({ AZITO_WEBHOOK_TOKEN: 'env-token' }, file)).toEqual({ ok: false, missing: ['AZITO_WEBHOOK_TOKEN'] });
  });

  it('reports both missing when the file is missing and env is empty', () => {
    const result = resolveHubEnv({}, path.join(dir, 'nope.env'));
    expect(result).toEqual({ ok: false, missing: ['AZITO_URL', 'AZITO_WEBHOOK_TOKEN'] });
  });

  it('reports AZITO_WEBHOOK_TOKEN missing when only URL resolves', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://localhost:3001\n');
    const result = resolveHubEnv({}, file);
    expect(result).toEqual({ ok: false, missing: ['AZITO_WEBHOOK_TOKEN'] });
  });

  it('reports AZITO_URL missing when only token resolves', () => {
    fs.writeFileSync(file, 'AZITO_WEBHOOK_TOKEN=some-token\n');
    const result = resolveHubEnv({}, file);
    expect(result).toEqual({ ok: false, missing: ['AZITO_URL'] });
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

  it('selects no file for a path-traversal prefix (../x) (never the unprefixed one)', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: '../x' });
    expect(p).toBeNull();
  });

  it('selects no file for a prefix with uppercase letters (never the unprefixed one)', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: 'Dev' });
    expect(p).toBeNull();
  });

  it('selects no file for a prefix with spaces (never the unprefixed one)', () => {
    const p = resolveEnvFilePath({ AZITO_PREFIX: 'a b' });
    expect(p).toBeNull();
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
    const result = resolveHubEnv({ AZITO_PREFIX: 'dev' }, prefixFile);
    expect(result).toEqual({ ok: true, env: { url: 'http://dev-hub', token: 'dev-token' } });
  });

  it('does not fall back to azitoctl.env when AZITO_PREFIX is invalid', () => {
    // resolveEnvFilePath yields no file for it, whatever azitoctl.env holds
    const result = resolveHubEnv({ AZITO_PREFIX: '../x' });
    expect(result).toEqual({ ok: false, missing: ['AZITO_URL', 'AZITO_WEBHOOK_TOKEN'] });
  });

  it('a complete process env takes priority over the env file with prefix; a partial one does not mix with it', () => {
    const prefixFile = path.join(dir, 'azitoctl-dev.env');
    fs.writeFileSync(prefixFile, 'AZITO_URL=http://file-url\nAZITO_WEBHOOK_TOKEN=file-token\n');
    expect(resolveHubEnv({ AZITO_PREFIX: 'dev', AZITO_URL: 'http://env-url', AZITO_WEBHOOK_TOKEN: 'env-token' }, prefixFile))
      .toEqual({ ok: true, env: { url: 'http://env-url', token: 'env-token' } });
    expect(resolveHubEnv({ AZITO_PREFIX: 'dev', AZITO_URL: 'http://env-url' }, prefixFile))
      .toEqual({ ok: true, env: { url: 'http://file-url', token: 'file-token' } });
  });
});

describe('resolveMuxPaneRef', () => {
  it('returns TMUX_PANE when set', () => {
    expect(resolveMuxPaneRef({ TMUX_PANE: '%42' })).toBe('%42');
  });

  it('returns undefined when TMUX_PANE is absent', () => {
    expect(resolveMuxPaneRef({})).toBeUndefined();
  });

  it('rejects invalid TMUX_PANE format', () => {
    expect(resolveMuxPaneRef({ TMUX_PANE: 'not-a-pane' })).toBeUndefined();
  });
});
