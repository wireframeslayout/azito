import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { createSecretFileGuard } from '../../shared/os/secretFileGuard';
import { ASKPASS_HELPER_SOURCE, ASKPASS_TOKEN_ENV, ASKPASS_USERNAME_ENV } from './askPassHelperSource';
import { ASKPASS_USERNAME, HubGitSupport } from './HubGitSupport';

const execFileAsync = promisify(execFile);
const TOKEN = 'tok-3f9a1c7e-SECRET';
const isWindows = process.platform === 'win32';

describe('HubGitSupport', () => {
  const dirs: string[] = [];

  /** A temp folder whose name contains a space (a Windows user name may). */
  function makeSpacedTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito askpass test '));
    dirs.push(dir);
    return dir;
  }

  function makeSupport(tmpDir: string): HubGitSupport {
    const hostEnv = resolveCurrentHostEnv();
    return new HubGitSupport(hostEnv, createSecretFileGuard(hostEnv.platform, process.env), path.join(tmpDir, 'git-support'));
  }

  /** Runs the launcher the way git does: the whole GIT_ASKPASS value is the executable, the prompt is its only argument. */
  function runLauncher(launcher: string, prompt: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    const base = { ...process.env, [ASKPASS_TOKEN_ENV]: '', [ASKPASS_USERNAME_ENV]: '' };
    const result = isWindows
      // Node refuses to spawn a .cmd directly; cmd.exe is what CreateProcess falls back to for git as well.
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" "${prompt}""`], { env: { ...base, ...env }, encoding: 'utf-8', windowsVerbatimArguments: true })
      : spawnSync(launcher, [prompt], { env: { ...base, ...env }, encoding: 'utf-8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  describe('askPass launcher and helper', () => {
    it('answers the password prompt with the token and the username prompt with the username', () => {
      const env = makeSupport(makeSpacedTmpDir()).askPassEnv(TOKEN);
      const launcher = env.GIT_ASKPASS as string;

      const password = runLauncher(launcher, "Password for 'https://x-access-token@example.com': ", env);
      expect(password.status).toBe(0);
      expect(password.stdout.trim()).toBe(TOKEN);

      const username = runLauncher(launcher, "Username for 'https://example.com': ", env);
      expect(username.status).toBe(0);
      expect(username.stdout.trim()).toBe(ASKPASS_USERNAME);
    });

    it('works from a path containing a space', () => {
      const env = makeSupport(makeSpacedTmpDir()).askPassEnv(TOKEN);
      expect(env.GIT_ASKPASS).toContain(' ');
      expect(runLauncher(env.GIT_ASKPASS as string, 'Password for x', env).stdout.trim()).toBe(TOKEN);
    });

    it('fails without a value (no default) when the token is not in the environment', () => {
      const env = makeSupport(makeSpacedTmpDir()).askPassEnv(TOKEN);
      const result = runLauncher(env.GIT_ASKPASS as string, 'Password for x', { [ASKPASS_TOKEN_ENV]: '' });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(ASKPASS_TOKEN_ENV);
    });

    it('never writes the token into the launcher, the helper, or the directory', () => {
      const tmpDir = makeSpacedTmpDir();
      const env = makeSupport(tmpDir).askPassEnv(TOKEN);
      const dir = path.dirname(env.GIT_ASKPASS as string);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) expect(fs.readFileSync(path.join(dir, entry.name), 'utf-8')).not.toContain(TOKEN);
      }
      expect(ASKPASS_HELPER_SOURCE).not.toContain(TOKEN);
      expect(JSON.stringify(Object.entries(env).filter(([k]) => k !== ASKPASS_TOKEN_ENV))).not.toContain(TOKEN);
    });

    it('creates the files once per instance and reuses them', () => {
      const support = makeSupport(makeSpacedTmpDir());
      expect(support.askPassEnv(TOKEN).GIT_ASKPASS).toBe(support.askPassEnv('another-token').GIT_ASKPASS);
    });

    it('rejects an empty token', () => {
      expect(() => makeSupport(makeSpacedTmpDir()).askPassEnv('')).toThrow('token must not be empty');
    });

    it.skipIf(isWindows)('makes the launcher executable by its owner only (Unix)', () => {
      const env = makeSupport(makeSpacedTmpDir()).askPassEnv(TOKEN);
      const launcherMode = fs.statSync(env.GIT_ASKPASS as string).mode & 0o777;
      const dirMode = fs.statSync(path.dirname(env.GIT_ASKPASS as string)).mode & 0o777;
      expect(launcherMode).toBe(0o700);
      expect(dirMode).toBe(0o700);
    });
  });

  describe('support directory', () => {
    it('is rewritten when the process starts again, even if its contents were removed or tampered with', () => {
      const tmpDir = makeSpacedTmpDir();
      const first = makeSupport(tmpDir);
      const dir = first.dir;
      fs.writeFileSync(path.join(dir, 'hooks', 'post-checkout'), 'evil');
      fs.rmSync(path.join(dir, 'askpass.cjs'));

      const second = makeSupport(tmpDir);
      expect(second.dir).toBe(dir);
      expect(fs.existsSync(path.join(dir, 'askpass.cjs'))).toBe(true);
      expect(fs.readdirSync(path.join(dir, 'hooks'))).toEqual([]);
      expect(runLauncher(second.askPassEnv(TOKEN).GIT_ASKPASS as string, 'Password for x', second.askPassEnv(TOKEN)).stdout.trim()).toBe(TOKEN);
    });

    it('removes what it wrote and rethrows when creation fails part-way', () => {
      const dir = path.join(makeSpacedTmpDir(), 'git-support');
      const hostEnv = { platform: 'win32' as const, execPath: 'C:\\100%\\node.exe' };
      const guard = createSecretFileGuard(process.platform, process.env);
      expect(() => new HubGitSupport(hostEnv, guard, dir)).toThrow('cannot take literally');
      expect(fs.existsSync(dir)).toBe(false);
    });

    it.skipIf(isWindows)('is readable by its owner only (Unix)', () => {
      const support = makeSupport(makeSpacedTmpDir());
      expect(fs.statSync(support.dir).mode & 0o777).toBe(0o700);
    });
  });

  describe('hooksPathArgs', () => {
    it('points core.hooksPath at an existing empty directory', () => {
      const args = makeSupport(makeSpacedTmpDir()).hooksPathArgs();
      expect(args[0]).toBe('-c');
      const value = args[1].replace(/^core\.hooksPath=/, '');
      expect(fs.statSync(value).isDirectory()).toBe(true);
      expect(fs.readdirSync(value)).toEqual([]);
    });
  });

  describe('with a real git process', () => {
    let server: http.Server;
    let baseUrl: string;
    let authorizations: string[] = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.headers.authorization) {
          authorizations.push(req.headers.authorization);
          res.writeHead(404).end();
          return;
        }
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="azito-test"' }).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    afterEach(() => {
      authorizations = [];
    });

    // Async: the HTTP server runs in this process, so a synchronous child would block it from answering.
    it('hands git the username and the token through the launcher', async () => {
      const env = makeSupport(makeSpacedTmpDir()).askPassEnv(TOKEN);
      await expect(execFileAsync('git', ['-c', 'credential.helper=', 'ls-remote', baseUrl], {
        encoding: 'utf-8',
        timeout: 20_000,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ...env },
      })).rejects.toThrow();

      expect(authorizations).toHaveLength(1);
      const decoded = Buffer.from(authorizations[0].replace(/^Basic /, ''), 'base64').toString('utf-8');
      expect(decoded).toBe(`${ASKPASS_USERNAME}:${TOKEN}`);
    });
  });
});
