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

describe('authDoctorCommand', () => {
  let originalEnv: string | undefined;
  let originalHome: string | undefined;
  let originalScopedAuth: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-doctor-test-'));
    uiTokenPath = path.join(tmpDir, 'data', 'ui-token');
    dotEnvPath = path.join(tmpDir, '.env');

    originalEnv = process.env.AZITO_UI_TOKEN;
    delete process.env.AZITO_UI_TOKEN;
    originalScopedAuth = process.env.AZITO_SCOPED_AUTH;
    delete process.env.AZITO_SCOPED_AUTH;

    // Sandboxed HOME: this command reads ~/.azito and ~/.claude on whatever
    // machine it runs on. Without this, running the suite on a real
    // developer machine would read their actual operator.env / settings.json.
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-doctor-home-'));
    process.env.HOME = fakeHome;

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AZITO_UI_TOKEN = originalEnv;
    } else {
      delete process.env.AZITO_UI_TOKEN;
    }
    if (originalScopedAuth !== undefined) {
      process.env.AZITO_SCOPED_AUTH = originalScopedAuth;
    } else {
      delete process.env.AZITO_SCOPED_AUTH;
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    process.exitCode = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function allLogLines(): string {
    return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  it('passes when nothing is set up yet', async () => {
    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();
    expect(process.exitCode).toBeUndefined();
    expect(allLogLines()).toContain('すべての検査に合格しました');
  });

  it('fails when azitoctl*.env still has AZITO_UI_TOKEN', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    fs.writeFileSync(path.join(azitoDir, 'azitoctl.env'), 'AZITO_URL=http://x\nAZITO_UI_TOKEN=leftover\n');

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('azitoctl.env');
  });

  it('passes when azitoctl*.env has no AZITO_UI_TOKEN', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    fs.writeFileSync(path.join(azitoDir, 'azitoctl.env'), 'AZITO_URL=http://x\nAZITO_WEBHOOK_TOKEN=y\n');

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBeUndefined();
  });

  // Third-party review Minor finding: a broken symlink (or any unreadable
  // file) among ~/.azito/azitoctl*.env used to throw straight out of
  // `fs.readFileSync` inside this check's `.filter()` — uncaught, that
  // crashed the entire `azito auth doctor` command (a human running it would
  // see neither this nor any of the other three checks' results at all, not
  // even a clean NG). It must instead surface as its own failing check.
  it('fails independently (without crashing the whole command) when an azitoctl*.env entry is unreadable', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    fs.symlinkSync(path.join(azitoDir, 'does-not-exist-target'), path.join(azitoDir, 'azitoctl.env'));

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('読み取りに失敗しました');
    // The other three checks must still have run and reported (proof the
    // command didn't abort partway through).
    expect(allLogLines()).toContain('AZITO_SCOPED_AUTH の現在値');
  });

  it('fails when operator.env permissions are not 0600', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    const operatorEnvPath = path.join(azitoDir, 'operator.env');
    fs.writeFileSync(operatorEnvPath, 'AZITO_UI_TOKEN=x\n', { mode: 0o644 });

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('operator.env');
  });

  it('passes when operator.env is 0600', async () => {
    const azitoDir = path.join(fakeHome, '.azito');
    fs.mkdirSync(azitoDir, { recursive: true });
    const operatorEnvPath = path.join(azitoDir, 'operator.env');
    fs.writeFileSync(operatorEnvPath, 'AZITO_UI_TOKEN=x\n', { mode: 0o600 });

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBeUndefined();
  });

  it('fails when MCP settings token does not match the hub token', async () => {
    process.env.AZITO_UI_TOKEN = 'hub-token';
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'stale-token' } } } }),
    );

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('MCP settings');
  });

  it('passes when MCP settings token matches the hub token', async () => {
    process.env.AZITO_UI_TOKEN = 'hub-token';
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'hub-token' } } } }),
    );

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBeUndefined();
  });

  // Issue #28 review Minor finding: an unreadable/broken settings.json used
  // to be indistinguishable from "azt-mcp has no token configured", which
  // this doctor check reported as a pass — a human editing the file by hand
  // (or a tool that crashed mid-write) would never learn the file was
  // actually broken.
  it('fails independently when MCP settings.json is not valid JSON', async () => {
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ this is not valid json');

    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();

    expect(process.exitCode).toBe(1);
    expect(allLogLines()).toContain('読み取りまたは JSON パースに失敗');
  });

  it('reports AZITO_SCOPED_AUTH current value', async () => {
    process.env.AZITO_SCOPED_AUTH = '1';
    const { authDoctorCommand } = await import('./authDoctorCommand.js');
    await authDoctorCommand();
    expect(allLogLines()).toContain('scoped 認可: 有効');
  });
});
