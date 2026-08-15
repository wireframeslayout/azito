import { describe, it, expect, vi } from 'vitest';
import { runIsolationDoctor } from './isolationDoctor';
import type { IServerTransport, ExecResult } from './transport/ServerTransport';

// Issue #29 Step 2 B: fail-closed contract — every check must default to
// 'unknown' unless it actually confirmed something, and the overall
// `verified` flag is true only when EVERY check is 'pass'.

const HUB = { hostname: 'hub-host', uid: 1000 };

function makeTransport(handler: (cmd: string) => Promise<ExecResult> | ExecResult): IServerTransport {
  return {
    exec: vi.fn(async (cmd: string) => handler(cmd)),
    execTmux: vi.fn(),
    openTerminal: vi.fn(),
    createPaneStream: vi.fn(),
  } as unknown as IServerTransport;
}

// A transport that reports a fully clean agent server — every individual
// test below overrides just the one command it cares about.
function cleanHandler(cmd: string): ExecResult {
  if (cmd.includes('hostname')) return { stdout: 'agent-host\n2000\n', stderr: '', code: 0 };
  if (cmd.includes('.ssh')) return { stdout: 'AZT_SSH_NO_DIR\n', stderr: '', code: 0 };
  if (cmd.includes('gh auth')) return { stdout: 'AZT_GH_ABSENT\n', stderr: '', code: 0 };
  if (cmd.includes('credential.helper')) return { stdout: 'AZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
  if (cmd.startsWith('echo "$HOME"')) return { stdout: '/home/agent\n', stderr: '', code: 0 };
  if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_DONE\n', stderr: '', code: 0 };
  throw new Error(`unexpected command: ${cmd}`);
}

describe('runIsolationDoctor', () => {
  it('reports verified:true when every check passes', async () => {
    const transport = makeTransport(cleanHandler);
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.verified).toBe(true);
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('same_host: fails when hostname AND uid both match the hub', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('hostname')) return { stdout: `${HUB.hostname}\n${HUB.uid}\n`, stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'same_host')!;
    expect(check.status).toBe('fail');
    expect(result.verified).toBe(false);
  });

  it('same_host: passes when only hostname matches (uid differs)', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('hostname')) return { stdout: `${HUB.hostname}\n9999\n`, stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('pass');
  });

  it('same_host: unknown when the exec throws (unreachable)', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('hostname')) throw new Error('connection refused');
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('unknown');
    expect(result.verified).toBe(false);
  });

  it('same_host: unknown when hub uid could not be resolved', async () => {
    const transport = makeTransport(cleanHandler);
    const result = await runIsolationDoctor(transport, { hostname: 'hub-host', uid: null });
    expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('unknown');
  });

  it('no_ssh_private_keys: fails when a private key file is found', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('.ssh')) return { stdout: '/home/agent/.ssh/id_rsa\nAZT_SSH_DIR_EXISTS\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'no_ssh_private_keys')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('id_rsa');
  });

  it('no_ssh_private_keys: passes when the directory exists but is empty of keys', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('.ssh')) return { stdout: 'AZT_SSH_DIR_EXISTS\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_ssh_private_keys')!.status).toBe('pass');
  });

  it('no_ssh_private_keys: unknown on a non-zero exit code', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('.ssh')) return { stdout: '', stderr: 'boom', code: 1 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_ssh_private_keys')!.status).toBe('unknown');
  });

  it('gh_unauthenticated: fails when gh auth status succeeds (authenticated)', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('gh auth')) return { stdout: 'AZT_GH_EXIT:0\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'gh_unauthenticated')!.status).toBe('fail');
  });

  it('gh_unauthenticated: passes when gh is installed but unauthenticated', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('gh auth')) return { stdout: 'AZT_GH_EXIT:1\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'gh_unauthenticated')!.status).toBe('pass');
  });

  it('no_git_credentials: fails when credential.helper is set', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('credential.helper')) return { stdout: 'store\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'no_git_credentials')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('credential.helper=store');
  });

  it('no_git_credentials: fails when ~/.git-credentials exists', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('credential.helper')) return { stdout: 'AZT_HELPER_END\nAZT_CREDFILE_EXISTS\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_git_credentials')!.status).toBe('fail');
  });

  it('no_operator_token: fails when an azitoctl*.env file still carries AZITO_UI_TOKEN', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.startsWith('echo "$HOME"')) return { stdout: '/home/agent\n', stderr: '', code: 0 };
      if (cmd.includes('ls -1')) return { stdout: 'azitoctl.env\nAZT_LS_DONE\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_FILE_BEGIN')) {
        return { stdout: 'AZT_FILE_BEGIN:0\nAZITO_UI_TOKEN=deadbeef\nAZT_FILE_END:0\n', stderr: '', code: 0 };
      }
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'no_operator_token')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('azitoctl.env');
  });

  it('no_operator_token: passes when azitoctl*.env exists but has no AZITO_UI_TOKEN line', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.startsWith('echo "$HOME"')) return { stdout: '/home/agent\n', stderr: '', code: 0 };
      if (cmd.includes('ls -1')) return { stdout: 'azitoctl.env\nAZT_LS_DONE\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_FILE_BEGIN')) {
        return { stdout: 'AZT_FILE_BEGIN:0\nAZITO_WEBHOOK_TOKEN=abc\nAZT_FILE_END:0\n', stderr: '', code: 0 };
      }
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_operator_token')!.status).toBe('pass');
  });

  it('no_operator_token: ignores filenames that do not match the azitoctl*.env / operator.env grammar', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.startsWith('echo "$HOME"')) return { stdout: '/home/agent\n', stderr: '', code: 0 };
      if (cmd.includes('ls -1')) return { stdout: 'notes.txt\nAZT_LS_DONE\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_operator_token')!.status).toBe('pass');
  });

  it('no_operator_token: unknown when $HOME cannot be resolved', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.startsWith('echo "$HOME"')) return { stdout: '', stderr: '', code: 1 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_operator_token')!.status).toBe('unknown');
  });

  it('a single unknown check keeps the overall result unverified even if every other check passes', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('gh auth')) throw new Error('unreachable');
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.verified).toBe(false);
    expect(result.checks.some((c) => c.status === 'unknown')).toBe(true);
  });
});
