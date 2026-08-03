import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let uiTokenPath: string;
let dotEnvPath: string;

vi.mock('../shared/dataDir', () => ({
  resolveDataDir: () => ({
    dir: tmpDir,
    db: path.join(tmpDir, 'data.db'),
    masterKey: path.join(tmpDir, 'master.key'),
    vapidKeys: path.join(tmpDir, 'vapid-keys.json'),
    uiToken: uiTokenPath,
    browserProfile: path.join(tmpDir, 'browser-profile'),
    sidekicks: path.join(tmpDir, 'sidekicks'),
    updateState: path.join(tmpDir, 'update-state.json'),
    updateLog: path.join(tmpDir, 'update.log'),
    updateChannel: path.join(tmpDir, 'update-channel.json'),
  }),
}));

vi.mock('../shared/envFile', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/envFile')>();
  return {
    ...original,
    resolveServerEnvPath: () => dotEnvPath,
  };
});

describe('tokenCommand', () => {
  let originalEnv: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-cmd-test-'));
    uiTokenPath = path.join(tmpDir, 'data', 'ui-token');
    dotEnvPath = path.join(tmpDir, '.env');
    originalEnv = process.env.AZITO_UI_TOKEN;
    delete process.env.AZITO_UI_TOKEN;

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AZITO_UI_TOKEN = originalEnv;
    } else {
      delete process.env.AZITO_UI_TOKEN;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('show', () => {
    it('returns env token when AZITO_UI_TOKEN is set', async () => {
      process.env.AZITO_UI_TOKEN = 'env-token-123';
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['show']);
      expect(logSpy).toHaveBeenCalledWith('env-token-123');
    });

    it('returns .env token when only .env has the value', async () => {
      fs.writeFileSync(dotEnvPath, 'AZITO_UI_TOKEN=dotenv-token-456\n');
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['show']);
      expect(logSpy).toHaveBeenCalledWith('dotenv-token-456');
    });

    it('returns file token when only ui-token file exists', async () => {
      fs.mkdirSync(path.dirname(uiTokenPath), { recursive: true });
      fs.writeFileSync(uiTokenPath, 'file-token-789\n');
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['show']);
      expect(logSpy).toHaveBeenCalledWith('file-token-789');
    });

    it('env takes priority over .env', async () => {
      process.env.AZITO_UI_TOKEN = 'env-wins';
      fs.writeFileSync(dotEnvPath, 'AZITO_UI_TOKEN=dotenv-loses\n');
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['show']);
      expect(logSpy).toHaveBeenCalledWith('env-wins');
    });

    it('.env takes priority over file', async () => {
      fs.writeFileSync(dotEnvPath, 'AZITO_UI_TOKEN=dotenv-wins\n');
      fs.mkdirSync(path.dirname(uiTokenPath), { recursive: true });
      fs.writeFileSync(uiTokenPath, 'file-loses\n');
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['show']);
      expect(logSpy).toHaveBeenCalledWith('dotenv-wins');
    });

    it('shows all checked paths when no token found', async () => {
      const { tokenCommand } = await import('./tokenCommand.js');
      await expect(tokenCommand(['show'])).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith('UI token not found.');
      const checkedMsg = errorSpy.mock.calls.find((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('Checked:'));
      expect(checkedMsg).toBeDefined();
      expect(checkedMsg![0]).toContain('AZITO_UI_TOKEN env');
      expect(checkedMsg![0]).toContain('.env');
      expect(checkedMsg![0]).toContain('ui-token');
    });
  });

  describe('rotate', () => {
    it('warns when .env has AZITO_UI_TOKEN', async () => {
      fs.writeFileSync(dotEnvPath, 'AZITO_UI_TOKEN=existing\n');
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('.env の値が優先されます'),
      );
    });

    it('does not warn when .env has no AZITO_UI_TOKEN', async () => {
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
