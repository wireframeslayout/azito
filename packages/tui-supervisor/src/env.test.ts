import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnvFile, resolveHubEnv } from './env';

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
    const env = resolveHubEnv(file, {});
    expect(env).toEqual({ url: 'http://localhost:3001', token: 'abc123' });
  });

  it('decodes backslash-escaped %q values (spaces, quotes, dollars)', () => {
    // printf '%q' 'a b$c"d' -> a\ b\$c\"d
    fs.writeFileSync(file, 'AZITO_URL=http://h/\nAZITO_WEBHOOK_TOKEN=a\\ b\\$c\\"d\n');
    const env = resolveHubEnv(file, {});
    expect(env?.token).toBe('a b$c"d');
  });

  it('prefers process env over the file', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://from-file\nAZITO_WEBHOOK_TOKEN=file-token\n');
    const env = resolveHubEnv(file, { AZITO_URL: 'http://from-env' });
    expect(env).toEqual({ url: 'http://from-env', token: 'file-token' });
  });

  it('returns null when the file is missing and env is empty', () => {
    expect(resolveHubEnv(path.join(dir, 'nope.env'), {})).toBeNull();
  });

  it('returns null when only one of the two values resolves', () => {
    fs.writeFileSync(file, 'AZITO_URL=http://localhost:3001\n');
    expect(resolveHubEnv(file, {})).toBeNull();
  });

  it('never throws on unreadable/garbage content', () => {
    fs.writeFileSync(file, '\x00\x01 not = an env file\n====\n');
    expect(() => resolveHubEnv(file, {})).not.toThrow();
  });

  it('parseEnvFile skips comments and blank lines', () => {
    const values = parseEnvFile('# comment\n\nKEY=value\n');
    expect(values).toEqual({ KEY: 'value' });
  });
});
