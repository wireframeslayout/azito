import { describe, it, expect, vi } from 'vitest';
import { runIsolationDoctor, probeFilesFramed } from './isolationDoctor';
import type { IServerTransport, ExecResult } from './transport/ServerTransport';

// Issue #29 Step 2 B: fail-closed contract — every check must default to
// 'unknown' unless it actually confirmed something, and the overall
// `verified` flag is true only when EVERY check is 'pass'.

const HUB = { hostname: 'hub-host', uid: 1000, canary: { path: '/hub/data/.azito-hub-canary-test', content: 'canary-content' } };

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

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
  // Review round (Critical finding 1): the FS-boundary canary — absent on a
  // genuinely separate filesystem.
  if (cmd.includes(HUB.canary.path)) return { stdout: 'AZT_STATUS:canary:absent\n', stderr: '', code: 0 };
  if (cmd.includes('.ssh')) return { stdout: 'AZT_SSH_NO_DIR\n', stderr: '', code: 0 };
  if (cmd.includes('gh auth')) return { stdout: 'AZT_GH_ABSENT\n', stderr: '', code: 0 };
  if (cmd.includes('credential.helper')) return { stdout: 'AZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
  if (cmd.startsWith('echo "$HOME"')) return { stdout: '/home/agent\n', stderr: '', code: 0 };
  if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_DONE\n', stderr: '', code: 0 };
  // Review round (Critical finding 2): framed base64 presence/absence,
  // replacing the old bare AZT_FILE_ABSENT marker — see probeFilesFramed's
  // doc comment in isolationDoctor.ts.
  if (cmd.includes('.claude/settings.json')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
  if (cmd.includes('config.toml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
  // Review round (Critical finding 3): the operator-environment check — no
  // operator variables present.
  if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
  throw new Error(`unexpected command: ${cmd}`);
}

describe('runIsolationDoctor', () => {
  // Ratified doctrine (misconfiguration detector, not attestation — see
  // isolationDoctor.ts's top-of-file module doc comment): a canary probe
  // that actually COMPLETES and positively reports the canary absent, paired
  // with both independent identifiers (hostname, uid) differing, is now
  // `'pass'` — `cleanHandler`'s scenario is exactly this, so a fully "clean"
  // agent server reaches `verified: true` overall.
  it('reports verified:true overall when every check (including same_host) passes', async () => {
    const transport = makeTransport(cleanHandler);
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('pass');
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('same_host: fails when hostname AND uid both match the hub, even with an unreadable canary', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('hostname')) return { stdout: `${HUB.hostname}\n${HUB.uid}\n`, stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'same_host')!;
    expect(check.status).toBe('fail');
    expect(result.verified).toBe(false);
  });

  // Step 2 review, Important #3: hostname alone is not an FS isolation
  // boundary (containers sharing a Docker host's utsname can still differ
  // in every way that matters) — a hostname-only match can no longer be
  // reported as 'pass'; it's inconclusive ('unknown') as long as the canary
  // itself is unreadable (no positive proof of separation either).
  it('same_host: unknown when only hostname matches (uid differs) — hostname alone is not an FS boundary', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('hostname')) return { stdout: `${HUB.hostname}\n9999\n`, stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'same_host')!;
    expect(check.status).toBe('unknown');
    expect(result.verified).toBe(false);
  });

  it('same_host: unknown when only uid matches (hostname differs) — uid alone is not an FS boundary', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('hostname')) return { stdout: `other-host\n${HUB.uid}\n`, stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('unknown');
  });

  // Ratified doctrine (misconfiguration detector, not attestation): a
  // COMPLETED canary probe that positively reports absence, combined with
  // both hostname and uid differing, is treated as 'pass' — the strongest
  // negative signal this check can produce (see checkFsAndHostBoundary's doc
  // comment). This is distinct from the probe not completing at all (still
  // 'unknown', covered separately below).
  it('same_host: passes when neither hostname nor uid match and the canary probe completed with a positive "absent" result', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('hostname')) return { stdout: 'other-host\n9999\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'same_host')!;
    expect(check.status).toBe('pass');
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
    const result = await runIsolationDoctor(transport, { hostname: 'hub-host', uid: null, canary: HUB.canary });
    expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('unknown');
  });

  // ─── FS-boundary canary (review round, Critical finding 1) ───
  describe('same_host: FS-boundary canary', () => {
    it('fails when the canary is read back with matching content, even though hostname/uid both differ', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('hostname')) return { stdout: 'other-host\n9999\n', stderr: '', code: 0 };
        if (cmd.includes(HUB.canary.path)) {
          return { stdout: `AZT_STATUS:canary:present\n${b64(HUB.canary.content)}\nAZT_STATUS_END:canary\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'same_host')!;
      expect(check.status).toBe('fail');
      expect(check.detail).toContain(HUB.canary.path);
      expect(result.verified).toBe(false);
    });

    it('unknown when hostname/uid both differ but the canary probe itself is unreachable', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('hostname')) return { stdout: 'other-host\n9999\n', stderr: '', code: 0 };
        if (cmd.includes(HUB.canary.path)) throw new Error('connection refused');
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('unknown');
    });

    it('unknown when the canary path exists but its content does not match (not trusted as proof of absence)', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('hostname')) return { stdout: 'other-host\n9999\n', stderr: '', code: 0 };
        if (cmd.includes(HUB.canary.path)) {
          return { stdout: `AZT_STATUS:canary:present\n${b64('unexpected-content')}\nAZT_STATUS_END:canary\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('unknown');
    });

    it('unknown when the hub has no canary at all (write failed at startup) — never silently skipped as a pass', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('hostname')) return { stdout: 'other-host\n9999\n', stderr: '', code: 0 };
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, { hostname: HUB.hostname, uid: HUB.uid, canary: null });
      expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('unknown');
    });
  });

  it('no_ssh_private_keys: fails when a private key file is found (grep exit 0)', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('.ssh')) return { stdout: 'AZT_GREP_STATUS:0\n/home/agent/.ssh/id_rsa\nAZT_SSH_DIR_EXISTS\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'no_ssh_private_keys')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('id_rsa');
  });

  it('no_ssh_private_keys: passes when the directory exists but grep exits 1 (no match)', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('.ssh')) return { stdout: 'AZT_GREP_STATUS:1\nAZT_SSH_DIR_EXISTS\n', stderr: '', code: 0 };
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

  // Review round (Important finding 2): grep's own exit status must never be
  // swallowed — a failed scan (missing grep, or grep itself erroring) must
  // never silently read as "no private keys found".
  it('no_ssh_private_keys: unknown when grep is not on PATH', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('.ssh')) return { stdout: 'AZT_GREP_ABSENT\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_ssh_private_keys')!.status).toBe('unknown');
  });

  it('no_ssh_private_keys: unknown when grep exits with a scan error (status >= 2)', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('.ssh')) return { stdout: 'AZT_GREP_STATUS:2\nAZT_SSH_DIR_EXISTS\n', stderr: '', code: 0 };
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

  // Step 2 review, Important #4: the raw helper value (which can itself
  // embed a username/password/token, e.g. `store --file
  // /path/with/user:pass@host` or a `!command`) must never appear verbatim
  // in `detail` — only a coarse, value-free classification.
  it('no_git_credentials: fails when credential.helper is set, without leaking the raw helper value', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('credential.helper')) return { stdout: 'store --file /home/agent/.git-credentials-secret\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'no_git_credentials')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('種別: store');
    expect(check.detail).not.toContain('/home/agent/.git-credentials-secret');
  });

  it('no_git_credentials: classifies a shell-command (!...) helper without leaking it, and never as "store"', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('credential.helper')) return { stdout: '!aws codecommit credential-helper $@ --profile secretprofile\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    const check = result.checks.find((c) => c.id === 'no_git_credentials')!;
    expect(check.status).toBe('fail');
    expect(check.detail).not.toContain('secretprofile');
    expect(check.detail).not.toContain('aws codecommit');
    expect(check.detail).toContain('shell command');
  });

  it('no_git_credentials: fails when ~/.git-credentials exists', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.includes('credential.helper')) return { stdout: 'AZT_HELPER_END\nAZT_CREDFILE_EXISTS\n', stderr: '', code: 0 };
      return cleanHandler(cmd);
    });
    const result = await runIsolationDoctor(transport, HUB);
    expect(result.checks.find((c) => c.id === 'no_git_credentials')!.status).toBe('fail');
  });

  // Review round (Critical finding 2): content now travels base64-encoded
  // inside a framed AZT_STATUS:<key>:present / AZT_STATUS_END:<key> pair
  // instead of the old bare-marker AZT_FILE_BEGIN/AZT_FILE_END search.
  it('no_operator_token: fails when an azitoctl*.env file still carries AZITO_UI_TOKEN', async () => {
    const transport = makeTransport((cmd) => {
      if (cmd.startsWith('echo "$HOME"')) return { stdout: '/home/agent\n', stderr: '', code: 0 };
      if (cmd.includes('ls -1')) return { stdout: 'azitoctl.env\nAZT_LS_DONE\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_STATUS:0')) {
        return { stdout: `AZT_STATUS:0:present\n${b64('AZITO_UI_TOKEN=deadbeef\n')}\nAZT_STATUS_END:0\n`, stderr: '', code: 0 };
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
      if (cmd.includes('AZT_STATUS:0')) {
        return { stdout: `AZT_STATUS:0:present\n${b64('AZITO_WEBHOOK_TOKEN=abc\n')}\nAZT_STATUS_END:0\n`, stderr: '', code: 0 };
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

  // Step 2 review, Critical #1: doctor must inspect every store
  // --purge-operator-token cleans up, not just azitoctl*.env/operator.env —
  // Claude's settings.json MCP env and Codex's config.toml are the other
  // two.
  describe('no_claude_mcp_token (Step 2 review, Critical #1)', () => {
    it('fails when settings.json carries a live azt-mcp AZITO_UI_TOKEN', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('.claude/settings.json')) {
          const content = JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'deadbeef' } } } });
          return { stdout: `AZT_STATUS:f:present\n${b64(content)}\nAZT_STATUS_END:f\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'no_claude_mcp_token')!;
      expect(check.status).toBe('fail');
      expect(result.verified).toBe(false);
    });

    it('passes when settings.json exists but has no azt-mcp token', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('.claude/settings.json')) {
          const content = JSON.stringify({ mcpServers: {} });
          return { stdout: `AZT_STATUS:f:present\n${b64(content)}\nAZT_STATUS_END:f\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_claude_mcp_token')!.status).toBe('pass');
    });

    it('passes when settings.json does not exist', async () => {
      const transport = makeTransport(cleanHandler);
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_claude_mcp_token')!.status).toBe('pass');
    });

    it('is unknown (fail-closed) when settings.json is not valid JSON', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('.claude/settings.json')) {
          return { stdout: `AZT_STATUS:f:present\n${b64('{ not valid json')}\nAZT_STATUS_END:f\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'no_claude_mcp_token')!;
      expect(check.status).toBe('unknown');
      expect(result.verified).toBe(false);
    });

    // Review round (Important finding 5 upstream / mcpTokenStores fix):
    // valid JSON that is not an object (null/array/scalar) must also report
    // unknown, not crash or silently read as "absent".
    it('is unknown (fail-closed) when settings.json is valid JSON but not an object', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('.claude/settings.json')) {
          return { stdout: `AZT_STATUS:f:present\n${b64('null')}\nAZT_STATUS_END:f\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_claude_mcp_token')!.status).toBe('unknown');
    });

    it('is unknown when the probe is unreachable', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('.claude/settings.json')) throw new Error('connection refused');
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_claude_mcp_token')!.status).toBe('unknown');
    });
  });

  describe('no_codex_mcp_token (Step 2 review, Critical #1)', () => {
    it('fails when config.toml carries AZITO_UI_TOKEN', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('config.toml')) {
          const content = '[mcp_servers.azt-mcp.env]\nAZITO_UI_TOKEN = "deadbeef"\n';
          return { stdout: `AZT_STATUS:f:present\n${b64(content)}\nAZT_STATUS_END:f\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'no_codex_mcp_token')!;
      expect(check.status).toBe('fail');
      expect(result.verified).toBe(false);
    });

    it('passes when config.toml exists but has no AZITO_UI_TOKEN', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('config.toml')) {
          const content = '[mcp_servers.other]\ncommand = "foo"\n';
          return { stdout: `AZT_STATUS:f:present\n${b64(content)}\nAZT_STATUS_END:f\n`, stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_codex_mcp_token')!.status).toBe('pass');
    });

    it('passes when config.toml does not exist', async () => {
      const transport = makeTransport(cleanHandler);
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_codex_mcp_token')!.status).toBe('pass');
    });

    it('is unknown when the probe result is an unrecognized shape', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('config.toml')) return { stdout: 'garbage output with no markers\n', stderr: '', code: 0 };
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_codex_mcp_token')!.status).toBe('unknown');
    });
  });

  // ─── Operator-environment check (review round, Critical finding 3 /
  // follow-up review round, Important finding 1) ───
  describe('no_operator_environment', () => {
    it('fails when AZITO_UI_TOKEN is present in the exec environment, without leaking its value', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_PRESENT:AZITO_UI_TOKEN\nAZT_ENV_DONE\n', stderr: '', code: 0 };
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'no_operator_environment')!;
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('AZITO_UI_TOKEN');
      expect(result.verified).toBe(false);
    });

    it('reports every present hub-secret variable, still never the value', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('AZT_ENV_PRESENT')) {
          return { stdout: 'AZT_ENV_PRESENT:AZITO_UI_TOKEN\nAZT_ENV_PRESENT:AZITO_WEBHOOK_TOKEN\nAZT_ENV_DONE\n', stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'no_operator_environment')!;
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('AZITO_UI_TOKEN');
      expect(check.detail).toContain('AZITO_WEBHOOK_TOKEN');
    });

    // Follow-up review round, Important finding 1: AZITO_AGENT_TOKEN is the
    // hub<->agent TRANSPORT credential every genuinely isolated agent server
    // MUST have set for /api/exec to be reachable at all — it must never be
    // checked here, or this check would fail permanently on every correctly
    // configured isolated server. The generated command itself no longer asks
    // about it (varsToCheck), so the real shell would never even emit a
    // AZT_ENV_PRESENT:AZITO_AGENT_TOKEN line — this test simulates that by
    // asserting the check still passes when the var is genuinely present in
    // the remote environment (only AZITO_UI_TOKEN/WEBHOOK_TOKEN/MASTER_KEY
    // could ever appear in real output).
    it('passes even when AZITO_AGENT_TOKEN is present in the exec environment (transport credential, not operator-equivalent)', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('AZT_ENV_PRESENT')) {
          expect(cmd).not.toContain('AZITO_AGENT_TOKEN');
          return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
        }
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'no_operator_environment')!;
      expect(check.status).toBe('pass');
      // cleanHandler's canary-absent + differing-identity scenario now
      // resolves `same_host` to 'pass' too (see checkFsAndHostBoundary's doc
      // comment) — asserted here only to confirm this check's own 'pass'
      // isn't accidentally riding on some other check's failure.
      expect(result.checks.find((c) => c.id === 'same_host')!.status).toBe('pass');
    });

    it('passes when no operator variable is set', async () => {
      const transport = makeTransport(cleanHandler);
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_operator_environment')!.status).toBe('pass');
    });

    it('unknown when the probe is unreachable', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('AZT_ENV_PRESENT')) throw new Error('connection refused');
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_operator_environment')!.status).toBe('unknown');
    });

    it('unknown when the terminator line is missing (unrecognized output shape)', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'garbage\n', stderr: '', code: 0 };
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      expect(result.checks.find((c) => c.id === 'no_operator_environment')!.status).toBe('unknown');
    });
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

// ─── probeFilesFramed (review round, Critical finding 2) ───
describe('probeFilesFramed', () => {
  it('never mistakes file content containing a status-line-like string for real framing (the bug this replaces)', async () => {
    // The exact scenario the old bare-marker search was vulnerable to: file
    // content that itself contains the literal marker text. Framed with
    // base64, this can never be confused with the real AZT_STATUS lines.
    const trickyContent = 'some file text\nAZT_STATUS:f:present\nAZT_STATUS_END:f\nmore text';
    const transport = makeTransport(async (cmd) => {
      expect(cmd).toContain('base64');
      return { stdout: `AZT_STATUS:f:present\n${b64(trickyContent)}\nAZT_STATUS_END:f\n`, stderr: '', code: 0 };
    });
    const result = await probeFilesFramed(transport, [{ key: 'f', pathExpr: '"/some/path"' }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const outcome = result.results.get('f');
      expect(outcome).toEqual({ kind: 'content', content: trickyContent });
    }
  });

  it('reports absent for a missing file', async () => {
    const transport = makeTransport(async () => ({ stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 }));
    const result = await probeFilesFramed(transport, [{ key: 'f', pathExpr: '"/missing"' }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results.get('f')).toEqual({ kind: 'absent' });
  });

  it('probes multiple files in a single exec call, keyed independently', async () => {
    const transport = makeTransport(async () => ({
      stdout: [
        'AZT_STATUS:0:present', b64('content-a'), 'AZT_STATUS_END:0',
        'AZT_STATUS:1:absent',
      ].join('\n') + '\n',
      stderr: '',
      code: 0,
    }));
    const result = await probeFilesFramed(transport, [
      { key: '0', pathExpr: '"/a"' },
      { key: '1', pathExpr: '"/b"' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.get('0')).toEqual({ kind: 'content', content: 'content-a' });
      expect(result.results.get('1')).toEqual({ kind: 'absent' });
    }
  });

  it('returns ok:false when the exec throws', async () => {
    const transport = makeTransport(async () => { throw new Error('unreachable'); });
    const result = await probeFilesFramed(transport, [{ key: 'f', pathExpr: '"/x"' }]);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on a non-zero exit code', async () => {
    const transport = makeTransport(async () => ({ stdout: '', stderr: 'boom', code: 1 }));
    const result = await probeFilesFramed(transport, [{ key: 'f', pathExpr: '"/x"' }]);
    expect(result.ok).toBe(false);
  });

  // ─── Follow-up review round, Important finding 3: base64 framing must not
  // swallow encode failures / malformed content as a false empty pass ───
  describe('base64 failure modes (follow-up review round, Important finding 3)', () => {
    it('reports unreadable (not content) when the base64 encode itself fails (e.g. missing encoder, TOCTOU permission error)', async () => {
      // The command branches on `base64`'s own exit status; a failed encode
      // emits `AZT_STATUS:<key>:unreadable` with no content frame at all —
      // this simulates that branch's real output.
      const transport = makeTransport(async () => ({ stdout: 'AZT_STATUS:f:unreadable\n', stderr: '', code: 0 }));
      const result = await probeFilesFramed(transport, [{ key: 'f', pathExpr: '"/x"' }]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.results.get('f')).toEqual({ kind: 'unreadable' });
    });

    it('reports unrecognized (not empty content) when the content frame carries syntactically invalid base64', async () => {
      const transport = makeTransport(async () => ({
        stdout: 'AZT_STATUS:f:present\nnot-valid-base64!!!\nAZT_STATUS_END:f\n',
        stderr: '',
        code: 0,
      }));
      const result = await probeFilesFramed(transport, [{ key: 'f', pathExpr: '"/x"' }]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.results.get('f')).toEqual({ kind: 'unrecognized' });
    });

    it('reports content:"" (never unknown) for a genuinely empty file — the encode succeeded, output is empty', async () => {
      const transport = makeTransport(async () => ({
        stdout: 'AZT_STATUS:f:present\nAZT_STATUS_END:f\n',
        stderr: '',
        code: 0,
      }));
      const result = await probeFilesFramed(transport, [{ key: 'f', pathExpr: '"/x"' }]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.results.get('f')).toEqual({ kind: 'content', content: '' });
    });

    // checkNoOperatorToken only flags files that CONTAIN AZITO_UI_TOKEN=; a
    // silent "unreadable degrades to empty content" bug would make this
    // check falsely PASS even though the file's actual (unread) content
    // carries the token — this is the exact false-pass scenario the fix
    // closes, exercised through the full doctor.
    it('checkNoOperatorToken: unknown (never a false pass) when the offending file cannot be base64-encoded', async () => {
      const transport = makeTransport((cmd) => {
        if (cmd.startsWith('echo "$HOME"')) return { stdout: '/home/agent\n', stderr: '', code: 0 };
        if (cmd.includes('ls -1')) return { stdout: 'azitoctl.env\nAZT_LS_DONE\n', stderr: '', code: 0 };
        if (cmd.includes('AZT_STATUS:0')) return { stdout: 'AZT_STATUS:0:unreadable\n', stderr: '', code: 0 };
        return cleanHandler(cmd);
      });
      const result = await runIsolationDoctor(transport, HUB);
      const check = result.checks.find((c) => c.id === 'no_operator_token')!;
      expect(check.status).toBe('unknown');
      expect(result.verified).toBe(false);
    });
  });
});
