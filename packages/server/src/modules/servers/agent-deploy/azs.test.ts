import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// harness/bin/azs (bash) run for real in a temp home with a fake `tmux`; `echo` is the "runner", so what azs would exec is printed.
const AZS = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'harness', 'bin', 'azs');

interface Ran { code: number; stdout: string; stderr: string }

let home: string;
let supervisor: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-azs-'));
  fs.mkdirSync(path.join(home, 'bin'));
  const tmux = path.join(home, 'bin', 'tmux');
  fs.writeFileSync(tmux, '#!/bin/sh\necho sess:1.0\n');
  fs.chmodSync(tmux, 0o755);
  supervisor = path.join(home, 'supervisor.cjs');
  fs.writeFileSync(supervisor, '');
  fs.mkdirSync(path.join(home, '.azito'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** The shape setup.sh writes: URL, token, server name and the supervisor path — never AZITO_SUPERVISOR_RUNNER. */
const envFile = (name: string, server: string): void => {
  fs.writeFileSync(
    path.join(home, '.azito', name),
    `AZITO_URL=http://file-hub-of-${server}\nAZITO_WEBHOOK_TOKEN=file-token-of-${server}\nAZITO_SERVER_NAME=${server}\nAZITO_SUPERVISOR_PATH=${supervisor}\n`,
  );
};

/** Runs azs with `echo` as the runner (from the environment) and returns what azs would have exec'd. */
function azs(env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve) => {
    const base = { PATH: `${path.join(home, 'bin')}:${process.env.PATH ?? ''}`, HOME: home, TMUX: '1', TMUX_PANE: '%1', AZITO_SUPERVISOR_RUNNER: 'echo' };
    execFile('bash', [AZS, 'agent-cmd'], { env: { ...base, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

// #528: the same file-selection rules as azitoctl and the hooks.
describe.skipIf(process.platform === 'win32')('azs env file selection', { timeout: 30_000 }, () => {
  it('AZITO_PREFIX selects azitoctl-<prefix>.env over the unprefixed file of another hub', async () => {
    envFile('azitoctl.env', 'other-hub');
    envFile('azitoctl-dev.env', 'dev-hub');

    expect((await azs({ AZITO_PREFIX: 'dev' })).stdout).toContain('--server dev-hub ');
  });

  it('without a prefix, reads the unprefixed azitoctl.env', async () => {
    envFile('azitoctl.env', 'plain-hub');
    envFile('azitoctl-dev.env', 'dev-hub');

    expect((await azs({})).stdout).toContain('--server plain-hub ');
  });

  it('the runner and the supervisor path from the environment are kept: setup.sh writes no AZITO_SUPERVISOR_RUNNER, so the file cannot replace them', async () => {
    envFile('azitoctl-dev.env', 'dev-hub');
    const other = path.join(home, 'other-supervisor.cjs');
    fs.writeFileSync(other, '');

    const ran = await azs({ AZITO_PREFIX: 'dev', AZITO_SUPERVISOR_PATH: other });

    expect(ran.stdout.startsWith(`${other} --server dev-hub `)).toBe(true); // `echo` (the runner from the environment) printed the arguments
  });

  it('a complete destination in the environment (URL, token, server name) is used as is', async () => {
    envFile('azitoctl-dev.env', 'file-hub');

    const ran = await azs({ AZITO_PREFIX: 'dev', AZITO_URL: 'http://pane-hub', AZITO_WEBHOOK_TOKEN: 'pane-token', AZITO_SERVER_NAME: 'pane-hub' });

    expect(ran.stdout).toContain('--server pane-hub ');
  });

  it('an incomplete destination in the environment is dropped: the server name comes from the file, together with its URL and token', async () => {
    envFile('azitoctl-dev.env', 'file-hub');

    const ran = await azs({ AZITO_PREFIX: 'dev', AZITO_SERVER_NAME: 'pane-hub' });

    expect(ran.stdout).toContain('--server file-hub ');
  });

  it('a prefix whose env file is missing launches the command without a supervisor and never reads the unprefixed file', async () => {
    envFile('azitoctl.env', 'other-hub');

    const ran = await azs({ AZITO_PREFIX: 'dev' });

    expect(ran.stdout).not.toContain('--server');
    expect(ran.stderr).toContain('azitoctl-dev.env');
  });
});
