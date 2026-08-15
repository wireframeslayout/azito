import { describe, it, expect, vi } from 'vitest';
import { PushVerifier } from './PushVerifier';
import type { TmuxClient } from '../../tmux/TmuxClient';
import type { GitProviderService } from '../../git/providers/GitProviderService';
import type { ServerConfig } from '../../servers/Server';

function makeAgentServer(): ServerConfig {
  return {
    name: 'agent-1',
    type: 'agent',
    host: '100.64.0.1',
    agentPort: 4001,
    agentToken: 'tok',
    agentVersion: '1.0.0',
    sshHost: null,
    muxRuntime: 'system',
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null, isolationCleanupReport: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('PushVerifier (remote server, non-local)', () => {
  // workingDir/branch reach `readShasRemote` after passing through
  // `assertPathContained`, which no longer restricts their character set
  // (Issue #27 review finding 2 — that restriction was moved out in favor
  // of quoting at each shell boundary). This call site is one of those
  // boundaries, so it must quote both values itself.
  it('quotes workingDir and branch when building the remote `cd -- ... && git ...` commands, so shell metacharacters in either do not reach the shell unquoted', async () => {
    const execCommand = vi.fn(async (_server: ServerConfig, command: string) => {
      if (command.includes('rev-parse HEAD')) return { stdout: 'a'.repeat(40) + '\n', stderr: '', code: 0 };
      if (command.includes('ls-remote')) return { stdout: `${'a'.repeat(40)}\trefs/heads/x\n`, stderr: '', code: 0 };
      throw new Error(`unexpected command: ${command}`);
    });
    const tmux = { execCommand } as unknown as TmuxClient;
    const gitProvider = {} as GitProviderService;
    const verifier = new PushVerifier(tmux, gitProvider);

    const dangerousDir = "/work/repo; touch /tmp/pwned; echo '";
    const dangerousBranch = "feature/x'; touch /tmp/pwned; echo '";

    const result = await verifier.verifyPushCompleted(makeAgentServer(), dangerousDir, dangerousBranch, true, null);

    expect(result).toBe(true);
    const calls = execCommand.mock.calls.map((call) => call[1] as string);
    for (const cmd of calls) {
      // Every occurrence of the dangerous directory/branch must be wrapped
      // in single quotes (with embedded `'` escaped as `'\''`), never
      // interpolated bare.
      expect(cmd).toContain(`cd -- '/work/repo; touch /tmp/pwned; echo '\\'''`);
    }
    const lsRemoteCall = calls.find((c) => c.includes('ls-remote'));
    expect(lsRemoteCall).toContain(`git ls-remote --heads origin 'feature/x'\\''; touch /tmp/pwned; echo '\\'''`);
  });

  it('returns false (fails closed) when the remote exec throws, instead of leaking the error', async () => {
    const execCommand = vi.fn(async () => {
      throw new Error('transport failure');
    });
    const tmux = { execCommand } as unknown as TmuxClient;
    const gitProvider = {} as GitProviderService;
    const verifier = new PushVerifier(tmux, gitProvider);

    const result = await verifier.verifyPushCompleted(makeAgentServer(), '/work/repo', 'main', true, null);

    expect(result).toBe(false);
  });
});
