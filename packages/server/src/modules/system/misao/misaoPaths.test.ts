import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServicePath, hasMisaoToRelyOn, resolveInstallPrefix, resolveMisaoPaths } from './misaoPaths';
import { readEnvValue, upsertEnvValue } from '../../../shared/envFile';
import { createSecretFileGuard } from '../../../shared/os/secretFileGuard';

const secretFileGuard = createSecretFileGuard(process.platform, process.env);

describe('misaoPaths', () => {
  // Windows では動かない: POSIX のパス連結前提（/home/u）
  it.skipIf(process.platform === 'win32')('keeps the misao directory beside hub/, not inside it, so a hub update cannot touch it', () => {
    const paths = resolveMisaoPaths('/home/u/.azito');
    expect(paths).toMatchObject({ root: '/home/u/.azito/misao', current: '/home/u/.azito/misao/current', socket: '/home/u/.azito/misao/misao.sock', hubEnvFile: '/home/u/.azito/hub/.env' });
  });

  it('rejects a prefix whose socket path would exceed the unix socket limit', () => {
    expect(() => resolveMisaoPaths(`/${'a'.repeat(100)}`)).toThrow(/107-byte limit/);
  });

  it.each(['/home/my user/.azito', '/home/u/50%/.azito', '/home/u/a&b', '/home/u/<x>', '/home/u/it\'s', '/home/u/"q"', '/home/u/a\\b', '/home/u/$HOME'])('rejects the prefix %s (it would be re-interpreted in the unit / plist)', (prefix) => {
    expect(() => resolveMisaoPaths(prefix)).toThrow(/must not contain/);
  });

  it('rejects a relative prefix', () => {
    expect(() => resolveMisaoPaths('azito')).toThrow(/absolute/);
  });

  it('derives the prefix from where the hub bundle lives (AZITO_PREFIX is the harness prefix, not the install location)', () => {
    expect(resolveInstallPrefix('/home/u/.azito/hub/current')).toBe('/home/u/.azito');
    expect(resolveInstallPrefix('/home/u/.azito/hub/v0.11.0')).toBe('/home/u/.azito');
    expect(resolveInstallPrefix('/repo/packages/server')).toBeNull();
    expect(resolveInstallPrefix(null)).toBeNull();
  });

  // Windows では動かない: PATH の区切りが : 前提（Windows は ;）
  it.skipIf(process.platform === 'win32')('builds a PATH with the existing tool locations first, without duplicates', () => {
    const result = buildServicePath({ PATH: '/usr/bin:/opt/x/bin' }, '/home/u', (dir) => dir === '/home/u/.local/bin' || dir === '/usr/local/bin');
    expect(result).toBe('/home/u/.local/bin:/usr/local/bin:/usr/bin:/opt/x/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('hasMisaoToRelyOn', () => {
  const none = (): boolean => false;
  it('is false with neither a service definition nor MISAO_SOCKET, so a fresh install without misao starts on tmux', () => {
    expect(hasMisaoToRelyOn({}, '/home/u', none)).toBe(false);
  });
  // Windows では動かない: POSIX のパス連結前提（/home/u）
  it.skipIf(process.platform === 'win32')('is true once MISAO_SOCKET is set or either service definition exists', () => {
    expect(hasMisaoToRelyOn({ MISAO_SOCKET: '/s' }, '/home/u', none)).toBe(true);
    expect(hasMisaoToRelyOn({}, '/home/u', (f) => f === '/home/u/.config/systemd/user/azito-misao.service')).toBe(true);
    expect(hasMisaoToRelyOn({}, '/home/u', (f) => f === '/home/u/Library/LaunchAgents/com.azito.misao.plist')).toBe(true);
  });
});

describe('upsertEnvValue', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aze-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('tightens an existing file that was more permissive to owner-only', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'A=1\n', { mode: 0o644 });
    expect(secretFileGuard.inspect(file, 'file').ok).toBe(false);
    upsertEnvValue(file, 'MISAO_SOCKET', '/s', secretFileGuard);
    expect(secretFileGuard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('creates a missing file restricted to the owner', () => {
    const file = path.join(dir, 'hub', '.env');
    upsertEnvValue(file, 'MISAO_SOCKET', '/s', secretFileGuard);
    expect(fs.readFileSync(file, 'utf-8')).toBe('MISAO_SOCKET=/s\n');
    expect(secretFileGuard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('replaces an existing assignment in place and appends otherwise, keeping other lines and comments', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# c\nA=1\nMISAO_SOCKET=/old\nB=2\n');
    upsertEnvValue(file, 'MISAO_SOCKET', '/new', secretFileGuard);
    expect(fs.readFileSync(file, 'utf-8')).toBe('# c\nA=1\nMISAO_SOCKET=/new\nB=2\n');

    upsertEnvValue(file, 'C', '3', secretFileGuard);
    expect(fs.readFileSync(file, 'utf-8')).toBe('# c\nA=1\nMISAO_SOCKET=/new\nB=2\nC=3\n');
    expect(readEnvValue(file, 'C')).toBe('3');
  });
});
