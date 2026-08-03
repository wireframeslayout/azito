import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readEnvValue } from './envFile';

describe('readEnvValue', () => {
  let tmpDir: string;
  let envPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-test-'));
    envPath = path.join(tmpDir, '.env');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when file does not exist', () => {
    expect(readEnvValue('/nonexistent/.env', 'KEY')).toBeUndefined();
  });

  it('reads unquoted value', () => {
    fs.writeFileSync(envPath, 'AZITO_UI_TOKEN=abc123\n');
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBe('abc123');
  });

  it('reads double-quoted value', () => {
    fs.writeFileSync(envPath, 'AZITO_UI_TOKEN="abc123"\n');
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBe('abc123');
  });

  it('reads single-quoted value', () => {
    fs.writeFileSync(envPath, "AZITO_UI_TOKEN='abc123'\n");
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBe('abc123');
  });

  it('returns empty string for empty value', () => {
    fs.writeFileSync(envPath, 'AZITO_UI_TOKEN=\n');
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBe('');
  });

  it('skips comment lines', () => {
    fs.writeFileSync(envPath, '# AZITO_UI_TOKEN=commented\nAZITO_UI_TOKEN=real\n');
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBe('real');
  });

  it('returns undefined when key is not present', () => {
    fs.writeFileSync(envPath, 'OTHER_KEY=value\n');
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBeUndefined();
  });

  it('handles key with spaces around equals', () => {
    fs.writeFileSync(envPath, 'AZITO_UI_TOKEN = spaced\n');
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBe('spaced');
  });

  it('returns first match when key appears multiple times', () => {
    fs.writeFileSync(envPath, 'AZITO_UI_TOKEN=first\nAZITO_UI_TOKEN=second\n');
    expect(readEnvValue(envPath, 'AZITO_UI_TOKEN')).toBe('first');
  });
});
