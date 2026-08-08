import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let uiTokenPath: string;
let dotEnvPath: string;
let fakeHome: string;

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
  let originalHome: string | undefined;
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

    // rotate() also touches ~/.azito/operator.env and ~/.claude/settings.json
    // (Issue #28 Phase B). HOME MUST be sandboxed here — without this, running
    // this suite on a real developer machine would silently overwrite their
    // actual operator.env / Claude settings.json with a freshly rotated token.
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-cmd-home-'));
    process.env.HOME = fakeHome;

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
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
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
    // Issue #28 review Important finding: when .env (or the AZITO_UI_TOKEN
    // env var) is the authoritative source, rotating the token FILE used to
    // still overwrite operator.env/MCP settings with a token the running
    // hub never actually reads — the hub keeps authenticating with the OLD
    // .env/env value forever, while every local consumer gets handed a
    // fresh value that 401s against it. rotate must abort instead, leaving
    // every file untouched, and tell the operator to update the
    // authoritative source directly.
    it('aborts without writing anything when .env has AZITO_UI_TOKEN (the authoritative source)', async () => {
      fs.writeFileSync(dotEnvPath, 'AZITO_UI_TOKEN=existing\n');
      const azitoDir = path.join(fakeHome, '.azito');
      fs.mkdirSync(azitoDir, { recursive: true });
      const operatorEnvPath = path.join(azitoDir, 'operator.env');
      fs.writeFileSync(operatorEnvPath, 'AZITO_URL=http://localhost:3001\nAZITO_UI_TOKEN=old-token\n');

      const { tokenCommand } = await import('./tokenCommand.js');
      await expect(tokenCommand(['rotate'])).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot rotate'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(dotEnvPath));
      expect(fs.existsSync(uiTokenPath)).toBe(false);
      expect(fs.readFileSync(operatorEnvPath, 'utf-8')).toContain('old-token');
    });

    it('aborts without writing anything when AZITO_UI_TOKEN env var is the authoritative source', async () => {
      process.env.AZITO_UI_TOKEN = 'env-authoritative';
      const { tokenCommand } = await import('./tokenCommand.js');
      await expect(tokenCommand(['rotate'])).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot rotate'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('environment variable'));
      expect(fs.existsSync(uiTokenPath)).toBe(false);
    });

    it('proceeds normally when the token file is already the authoritative source (rotating it forward)', async () => {
      fs.mkdirSync(path.dirname(uiTokenPath), { recursive: true });
      fs.writeFileSync(uiTokenPath, 'previous-file-token\n');
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);

      expect(errorSpy).not.toHaveBeenCalled();
      const rotated = fs.readFileSync(uiTokenPath, 'utf-8');
      expect(rotated).not.toContain('previous-file-token');
      expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not warn when .env has no AZITO_UI_TOKEN', async () => {
      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not create or modify ~/.azito/azitoctl*.env (Issue #28 Phase B)', async () => {
      const azitoDir = path.join(fakeHome, '.azito');
      fs.mkdirSync(azitoDir, { recursive: true });
      const azitoctlEnvPath = path.join(azitoDir, 'azitoctl.env');
      const before = 'AZITO_URL=http://localhost:3001\nAZITO_WEBHOOK_TOKEN=abc\n';
      fs.writeFileSync(azitoctlEnvPath, before);

      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);

      expect(fs.readFileSync(azitoctlEnvPath, 'utf-8')).toBe(before);
    });

    it('updates AZITO_UI_TOKEN in ~/.azito/operator.env when present', async () => {
      const azitoDir = path.join(fakeHome, '.azito');
      fs.mkdirSync(azitoDir, { recursive: true });
      const operatorEnvPath = path.join(azitoDir, 'operator.env');
      fs.writeFileSync(operatorEnvPath, 'AZITO_URL=http://localhost:3001\nAZITO_UI_TOKEN=old-token\n');

      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);

      const updated = fs.readFileSync(operatorEnvPath, 'utf-8');
      expect(updated).not.toContain('old-token');
      expect(updated).toMatch(/AZITO_UI_TOKEN=[0-9a-f]{64}/);
      expect(updated).toContain('AZITO_URL=http://localhost:3001');
    });

    it('forces operator.env to mode 0600 even if it was previously more permissive', async () => {
      const azitoDir = path.join(fakeHome, '.azito');
      fs.mkdirSync(azitoDir, { recursive: true });
      const operatorEnvPath = path.join(azitoDir, 'operator.env');
      fs.writeFileSync(operatorEnvPath, 'AZITO_URL=http://localhost:3001\nAZITO_UI_TOKEN=old-token\n');
      // Simulate a file left over from before the umask 077 + atomic-mv fix
      // (or restored from a backup) that ended up world-readable.
      fs.chmodSync(operatorEnvPath, 0o644);

      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);

      const mode = fs.statSync(operatorEnvPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('does nothing when operator.env does not exist', async () => {
      const { tokenCommand } = await import('./tokenCommand.js');
      await expect(tokenCommand(['rotate'])).resolves.not.toThrow();
      expect(fs.existsSync(path.join(fakeHome, '.azito', 'operator.env'))).toBe(false);
    });

    it('updates azt-mcp AZITO_UI_TOKEN in ~/.claude/settings.json when present', async () => {
      const claudeDir = path.join(fakeHome, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      const before = {
        mcpServers: {
          'azt-mcp': {
            command: 'node',
            args: ['/path/to/index.js'],
            env: { AZITO_URL: 'http://localhost:3001', AZITO_UI_TOKEN: 'old-mcp-token' },
          },
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2));

      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);

      const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(updated.mcpServers['azt-mcp'].env.AZITO_UI_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(updated.mcpServers['azt-mcp'].env.AZITO_UI_TOKEN).not.toBe('old-mcp-token');
      expect(updated.mcpServers['azt-mcp'].env.AZITO_URL).toBe('http://localhost:3001');
      expect(updated.mcpServers['azt-mcp'].command).toBe('node');
    });

    it('does not touch settings.json when azt-mcp has no AZITO_UI_TOKEN', async () => {
      const claudeDir = path.join(fakeHome, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      const before = { mcpServers: { 'azt-mcp': { command: 'node', args: [], env: { AZITO_URL: 'http://localhost:3001' } } } };
      fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2));

      const { tokenCommand } = await import('./tokenCommand.js');
      await tokenCommand(['rotate']);

      const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(updated.mcpServers['azt-mcp'].env.AZITO_UI_TOKEN).toBeUndefined();
    });
  });
});
