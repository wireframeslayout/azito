import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveUiToken } from './uiToken';

describe('resolveUiToken', () => {
  let tmpDir: string;
  const origEnv: Record<string, string | undefined> = {};
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-uitoken-test-'));
    origEnv.AZITO_UI_TOKEN = process.env.AZITO_UI_TOKEN;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.AZITO_UI_TOKEN = origEnv.AZITO_UI_TOKEN;
    consoleSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns env token when AZITO_UI_TOKEN is set, ignoring file', () => {
    const tokenPath = path.join(tmpDir, 'ui-token');
    fs.writeFileSync(tokenPath, 'file-token');
    process.env.AZITO_UI_TOKEN = 'env-token-value';

    const result = resolveUiToken(tokenPath);
    expect(result).toBe('env-token-value');
  });

  it('reads token from file when env is not set', () => {
    delete process.env.AZITO_UI_TOKEN;
    const tokenPath = path.join(tmpDir, 'ui-token');
    fs.writeFileSync(tokenPath, 'file-token-abc', { mode: 0o600 });

    const result = resolveUiToken(tokenPath);
    expect(result).toBe('file-token-abc');
  });

  it('generates token and writes to file when neither env nor file exists', () => {
    delete process.env.AZITO_UI_TOKEN;
    const tokenPath = path.join(tmpDir, 'subdir', 'ui-token');

    const result = resolveUiToken(tokenPath);
    expect(result).toMatch(/^[0-9a-f]{64}$/);

    const fileContent = fs.readFileSync(tokenPath, 'utf-8');
    expect(fileContent).toBe(result);

    const stat = fs.statSync(tokenPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('does not log token value when stdout is not TTY', () => {
    delete process.env.AZITO_UI_TOKEN;
    const tokenPath = path.join(tmpDir, 'ui-token');

    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      const result = resolveUiToken(tokenPath);

      const logOutput = consoleSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(logOutput).not.toContain(result);
      expect(logOutput).toContain(tokenPath);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });
});
