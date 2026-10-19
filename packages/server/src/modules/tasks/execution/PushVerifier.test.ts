import { describe, it, expect } from 'vitest';
import { PushVerifier } from './PushVerifier';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { GitProviderService } from '../../git/providers/GitProviderService';
import type { ServerConfig } from '../../servers/Server';
import type { CommandSpec } from '../../../shared/exec/commandSpec';
import { argvOfShellLine, argvOfSpec, failed, fakeRunTransport, ok } from '../../../shared/exec/testing/commandTesting';

function makeAgentServer(): ServerConfig {
  return {
    name: 'agent-1',
    type: 'agent',
    host: '100.64.0.1',
    agentPort: 4001,
    agentToken: 'tok',
    agentVersion: '1.0.0',
    sshHost: null,
    defaultMux: 'tmux' as const, muxRuntime: 'system',
    hostProfile: null, sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null, isolationCleanupReport: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const SHA = 'a'.repeat(40);

function makeVerifier(respond: (spec: CommandSpec) => ReturnType<typeof ok>) {
  const transport = fakeRunTransport(respond);
  const verifier = new PushVerifier({ getTransport: () => transport } as unknown as TransportFactory, {} as GitProviderService);
  return { verifier, specs: transport.specs };
}

const answerShas = (spec: CommandSpec): ReturnType<typeof ok> =>
  spec.args[0] === 'rev-parse' ? ok(`${SHA}\n`) : ok(`${SHA}\trefs/heads/x\n`);

describe('PushVerifier (remote server, non-local)', () => {
  // workingDir/branch reach `readShasRemote` after passing through `assertPathContained`, which does not restrict their
  // character set (Issue #27 review finding 2). With no shell involved they reach git as whole arguments.
  it('passes workingDir (as cwd) and branch as whole arguments, whatever shell metacharacters they contain', async () => {
    const { verifier, specs } = makeVerifier(answerShas);
    const dangerousDir = "/work/repo; touch /tmp/pwned; echo '";
    const dangerousBranch = "feature/x'; touch /tmp/pwned; echo '";

    const result = await verifier.verifyPushCompleted(makeAgentServer(), dangerousDir, dangerousBranch, true, null);

    expect(result).toBe(true);
    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.file).toBe('git');
      expect(spec.cwd).toBe(dangerousDir);
    }
    expect(specs[0].args).toEqual(['rev-parse', 'HEAD']);
    expect(specs[1].args).toEqual(['ls-remote', '--heads', '--', 'origin', dangerousBranch]);
  });

  it('keeps a branch that starts with a dash from being read as an option', async () => {
    const { verifier, specs } = makeVerifier(answerShas);
    await verifier.verifyPushCompleted(makeAgentServer(), '/work/repo', '--upload-pack=evil', true, null);
    expect(specs[1].args).toEqual(['ls-remote', '--heads', '--', 'origin', '--upload-pack=evil']);
  });

  it('returns false when the local and remote SHAs differ', async () => {
    const { verifier } = makeVerifier((spec) => (spec.args[0] === 'rev-parse' ? ok(`${SHA}\n`) : ok(`${'b'.repeat(40)}\trefs/heads/x\n`)));
    expect(await verifier.verifyPushCompleted(makeAgentServer(), '/work/repo', 'x', true, null)).toBe(false);
  });

  it('returns false when git exits non-zero, even if it printed a SHA', async () => {
    const { verifier } = makeVerifier((spec) => (spec.args[0] === 'rev-parse' ? failed(128, 'fatal: not a git repository', SHA) : answerShas(spec)));
    expect(await verifier.verifyPushCompleted(makeAgentServer(), '/work/repo', 'x', true, null)).toBe(false);
  });

  it('returns false when the branch is not on the remote (ls-remote prints nothing)', async () => {
    const { verifier } = makeVerifier((spec) => (spec.args[0] === 'rev-parse' ? ok(`${SHA}\n`) : ok('')));
    expect(await verifier.verifyPushCompleted(makeAgentServer(), '/work/repo', 'x', true, null)).toBe(false);
  });

  it('returns false (fails closed) when the remote run throws, instead of leaking the error', async () => {
    const transportFactory = { getTransport: () => ({ run: async () => { throw new Error('transport failure'); } }) } as unknown as TransportFactory;
    const verifier = new PushVerifier(transportFactory, {} as GitProviderService);
    expect(await verifier.verifyPushCompleted(makeAgentServer(), '/work/repo', 'main', true, null)).toBe(false);
  });

  // The old strings were `cd -- <dir> && git rev-parse HEAD` and `... git ls-remote --heads origin <branch>`. The only
  // difference is the `--` before `origin`, which the local variant already used.
  it.skipIf(process.platform === 'win32')('runs the same argv as the old shell strings, plus the `--` guard', async () => {
    const { verifier, specs } = makeVerifier(answerShas);
    await verifier.verifyPushCompleted(makeAgentServer(), "/work/it's", "feature/it's", true, null);
    const oldArgv = [
      argvOfShellLine('git rev-parse HEAD'),
      argvOfShellLine("git ls-remote --heads origin 'feature/it'\\''s'"),
    ];
    const withoutGuard = specs.map(argvOfSpec).map((argv) => argv.filter((a, i) => !(a === '--' && argv[i - 1] === '--heads')));
    expect(withoutGuard).toEqual(oldArgv);
    expect(specs.map((s) => s.cwd)).toEqual(["/work/it's", "/work/it's"]);
  });
});
