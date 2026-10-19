import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// install.sh is a script run once on a user's machine, so its parts are exercised by cutting them out of the file
// (a function, or the CLI wrapper it writes) and running them under bash with stand-ins for uname / node / systemctl.
const INSTALL_SH = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'install.sh'), 'utf-8');

function extractFunction(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(INSTALL_SH);
  if (!match) throw new Error(`install.sh has no function ${name}`);
  return match[0];
}

function extractWrapper(): string {
  const match = /<<'WRAPPER'\n([\s\S]*?)\nWRAPPER\n/.exec(INSTALL_SH);
  if (!match) throw new Error('install.sh has no CLI wrapper');
  return match[1];
}

describe('install.sh', () => {
  let dir: string;
  let bin: string;
  let log: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azi-'));
    bin = path.join(dir, 'bin');
    log = path.join(dir, 'calls.log');
    fs.mkdirSync(bin);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** An executable that appends its name and arguments to the log and exits with `code`. */
  function stub(file: string, code = 0, output = ''): void {
    fs.writeFileSync(file, `#!/bin/bash\necho "$(basename "$0") $*" >> "${log}"\n${output ? `echo '${output}'\n` : ''}exit ${code}\n`, { mode: 0o755 });
  }

  const calls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []);

  function bash(script: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ...env }, encoding: 'utf-8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  describe('find_tailscale', () => {
    // `command -v` is shadowed so the test does not depend on what the machine running it has under /opt/homebrew.
    const withOnly = (...present: string[]): string => `command() { if [ "$1" = -v ]; then case " ${present.join(' ')} " in *" $2 "*) echo "$2"; return 0 ;; esac; return 1; fi; builtin command "$@"; }\n`;

    it('takes the one on PATH first', () => {
      const result = bash(`${withOnly('tailscale', '/opt/homebrew/bin/tailscale')}${extractFunction('find_tailscale')}find_tailscale`);
      expect(result.stdout.trim()).toBe('tailscale');
    });

    it("finds Homebrew's tailscale on Apple silicon and on Intel when PATH lacks it", () => {
      expect(bash(`${withOnly('/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale')}${extractFunction('find_tailscale')}find_tailscale`).stdout.trim()).toBe('/opt/homebrew/bin/tailscale');
      expect(bash(`${withOnly('/usr/local/bin/tailscale')}${extractFunction('find_tailscale')}find_tailscale`).stdout.trim()).toBe('/usr/local/bin/tailscale');
    });

    it('fails when there is none', () => {
      const result = bash(`${withOnly()}${extractFunction('find_tailscale')}find_tailscale`);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    });

    it('is what the script uses to run tailscale, never a bare `tailscale` after the check', () => {
      expect(INSTALL_SH).not.toMatch(/command -v tailscale/);
      expect(INSTALL_SH).toContain('"$TAILSCALE_BIN" status --self --json');
    });
  });

  describe('register_hub_service_launchd', () => {
    const run = (): ReturnType<typeof bash> => bash(`INSTALL_DIR="${dir}/hub/v1"\n${extractFunction('register_hub_service_launchd')}register_hub_service_launchd`);

    it('reloads the service through the bundled CLI, so the domain is chosen in one place', () => {
      fs.mkdirSync(path.join(dir, 'hub', 'v1'), { recursive: true });
      stub(path.join(dir, 'hub', 'v1', 'node'));
      const result = run();
      expect(result.status).toBe(0);
      expect(calls()).toEqual([`node ${dir}/hub/v1/azito-hub.cjs service reload`]);
    });

    it('reports a failure as an error and returns non-zero instead of carrying on', () => {
      fs.mkdirSync(path.join(dir, 'hub', 'v1'), { recursive: true });
      stub(path.join(dir, 'hub', 'v1', 'node'), 1);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR: the AZITO launchd service could not be loaded');
      expect(result.stderr).toContain('azito service start');
    });

    it('is called so that a failure ends the install with a non-zero status', () => {
      expect(INSTALL_SH).toContain('register_hub_service_launchd || exit 1');
      expect(INSTALL_SH).not.toMatch(/launchctl (load|unload|list)/);
    });
  });

  describe('the azito CLI wrapper', () => {
    function runWrapper(os_: 'Darwin' | 'Linux', command: string): ReturnType<typeof bash> {
      const prefix = path.join(dir, 'prefix');
      fs.mkdirSync(path.join(prefix, 'hub', 'current'), { recursive: true });
      stub(path.join(prefix, 'hub', 'current', 'node'));
      fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/bash\necho ${os_}\n`, { mode: 0o755 });
      stub(path.join(bin, 'systemctl'));
      fs.writeFileSync(path.join(dir, 'azito'), extractWrapper(), { mode: 0o755 });
      return bash(`"${dir}/azito" ${command}`, { AZITO_PREFIX: prefix });
    }

    it('stops and reports the status on macOS through the bundled CLI (launchd domain chosen there), not launchctl directly', () => {
      expect(runWrapper('Darwin', 'stop').status).toBe(0);
      expect(runWrapper('Darwin', 'status').status).toBe(0);
      expect(calls()).toEqual([
        `node ${dir}/prefix/hub/current/azito-hub.cjs service stop`,
        `node ${dir}/prefix/hub/current/azito-hub.cjs service status`,
      ]);
    });

    it('keeps using systemctl on Linux', () => {
      runWrapper('Linux', 'stop');
      runWrapper('Linux', 'status');
      expect(calls()).toEqual(['systemctl --user stop azito', 'systemctl --user status azito --no-pager']);
    });

    it('passes `azito service ...` to the bundled CLI', () => {
      runWrapper('Darwin', 'service reload');
      expect(calls()).toEqual([`node ${dir}/prefix/hub/current/azito-hub.cjs service reload`]);
    });
  });
});
