import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _resetCache } from '../shared/releaseInfo';
import { _resetReleaseDefaultNotice } from '../shared/dataDir';
import { resolveServerEnvPath } from '../shared/envFile';
import { resolveCurrentUiToken } from '../shared/currentUiToken';
import { tokenCommand } from './tokenCommand';
import { authDoctorCommand } from './authDoctorCommand';
import { createSecretFileGuard } from '../shared/os/secretFileGuard';

const secretFileGuard = createSecretFileGuard(process.platform);

// A real release layout, nothing mocked: <prefix>/hub/<version>/ (the bundle), <prefix>/hub/current -> <version>,
// <prefix>/hub/.env (written by install.sh, loaded by run.sh).
describe('release layout (hub/<version>, hub/current symlink, parent .env)', () => {
  let tmpDir: string;
  let hubDir: string;
  let bundleDir: string;
  let origArgv1: string;
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-release-')));
    hubDir = path.join(tmpDir, '.azito', 'hub');
    bundleDir = path.join(hubDir, '0.11.0');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, 'release.json'),
      JSON.stringify({ version: '0.11.0', commit: 'abc', bundleHash: 'h', channel: { repo: 'o/r' } }),
    );
    fs.symlinkSync(bundleDir, path.join(hubDir, 'current'));

    for (const k of ['HOME', 'AZITO_UI_TOKEN', 'AZITO_DATA_DIR']) origEnv[k] = process.env[k];
    process.env.HOME = tmpDir;
    delete process.env.AZITO_UI_TOKEN;
    delete process.env.AZITO_DATA_DIR;
    origArgv1 = process.argv[1];
    // The service runs `<hub>/current/azito-hub.cjs`, so the bundle root is the symlink path.
    process.argv[1] = path.join(hubDir, 'current', 'azito-hub.cjs');
    _resetCache();
    _resetReleaseDefaultNotice();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv[1] = origArgv1;
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function errorOutput(): string {
    return vi.mocked(console.error).mock.calls.map(([m]) => String(m)).join('\n');
  }

  it('prefers the parent .env, as run.sh does', () => {
    fs.writeFileSync(path.join(hubDir, '.env'), 'AZITO_UI_TOKEN=parent-token\n');
    fs.writeFileSync(path.join(bundleDir, '.env'), 'AZITO_UI_TOKEN=bundle-token\n');
    expect(resolveServerEnvPath()).toBe(path.join(hubDir, '.env'));
    expect(resolveCurrentUiToken(secretFileGuard)).toEqual({ token: 'parent-token', source: path.join(hubDir, '.env') });
  });

  it('falls back to the bundle .env when the parent has none', () => {
    fs.writeFileSync(path.join(bundleDir, '.env'), 'AZITO_UI_TOKEN=bundle-token\n');
    expect(resolveServerEnvPath()).toBe(path.join(hubDir, 'current', '.env'));
    expect(resolveCurrentUiToken(secretFileGuard)?.token).toBe('bundle-token');
  });

  it('token show prints the token from the parent .env', async () => {
    fs.writeFileSync(path.join(hubDir, '.env'), 'AZITO_UI_TOKEN=parent-token\n');
    await tokenCommand(['show'], tmpDir, secretFileGuard);
    expect(console.log).toHaveBeenCalledWith('parent-token');
  });

  it('token rotate reports the parent .env as the source and leaves the token file alone', async () => {
    fs.writeFileSync(path.join(hubDir, '.env'), 'AZITO_UI_TOKEN=parent-token\n');
    await expect(tokenCommand(['rotate'], tmpDir, secretFileGuard)).rejects.toThrow('process.exit');
    expect(errorOutput()).toContain(path.join(hubDir, '.env'));
    expect(fs.existsSync(path.join(tmpDir, '.azito', 'data', 'ui-token'))).toBe(false);
  });

  it('token show names the parent .env when no .env exists, and announces the data dir once', async () => {
    await expect(tokenCommand(['show'], tmpDir, secretFileGuard)).rejects.toThrow('process.exit');
    expect(errorOutput()).toContain(`Set AZITO_UI_TOKEN in ${path.join(hubDir, '.env')}`);
    const notices = vi.mocked(console.log).mock.calls.filter(([m]) => String(m).startsWith('AZITO_DATA_DIR not set'));
    expect(notices).toHaveLength(1);
  });

  it('auth doctor finds the token in the parent .env', async () => {
    fs.writeFileSync(path.join(hubDir, '.env'), 'AZITO_UI_TOKEN=parent-token\n');
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'parent-token' } } } }),
    );
    await authDoctorCommand(tmpDir, secretFileGuard);
    const out = vi.mocked(console.log).mock.calls.map(([m]) => String(m)).join('\n');
    expect(out).toContain(`一致元: ${path.join(hubDir, '.env')}`);
  });
});
