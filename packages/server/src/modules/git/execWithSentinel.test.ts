import { describe, it, expect, vi } from 'vitest';
import { execWithSentinel, execGitOrThrow, RemoteGitCommandError } from './execWithSentinel';
import type { IServerTransport } from '../servers/transport/ServerTransport';

// Issue #87 third-party review, seventh pass, Important finding 1:
// `SshClient.execRemote()` (the `ssh` server type's transport) always
// returns `code: 0` / `stderr: ''` regardless of what actually happened on
// the remote shell — the marker-based exec protocol has no way to
// propagate a real exit status. These tests model exactly that transport
// shape (`code: 0`, `stderr: ''`) and vary only what the appended sentinel
// echo captured in stdout, since that's the one signal `execWithSentinel`
// is designed to rely on.
function sshShapedTransport(stdout: string): IServerTransport {
  return { exec: vi.fn(async () => ({ stdout, stderr: '', code: 0 })) } as unknown as IServerTransport;
}

describe('execWithSentinel', () => {
  it('(a) detects a failure that is not formatted as a git fatal:/error: line, on an SSH-shaped transport', async () => {
    const transport = sshShapedTransport('sh: git: command not found\nAZITO_RC:127');
    const outcome = await execWithSentinel(transport, 'git status', 5_000);
    expect(outcome.sentinelFound).toBe(true);
    expect(outcome.exitCode).toBe(127);
    expect(outcome.ok).toBe(false);
  });

  it('(b) treats a sentinel of 0 as success, on an SSH-shaped transport', async () => {
    const transport = sshShapedTransport('On branch main\nAZITO_RC:0');
    const outcome = await execWithSentinel(transport, 'git status', 5_000);
    expect(outcome.sentinelFound).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.ok).toBe(true);
  });

  it('(c) treats a missing sentinel as failure, on an SSH-shaped transport', async () => {
    const transport = sshShapedTransport('connection reset by peer');
    const outcome = await execWithSentinel(transport, 'git status', 5_000);
    expect(outcome.sentinelFound).toBe(false);
    expect(outcome.exitCode).toBeNull();
    expect(outcome.ok).toBe(false);
  });

  it('appends the sentinel echo to the command sent to the transport', async () => {
    const transport = sshShapedTransport('AZITO_RC:0');
    await execWithSentinel(transport, 'git status', 5_000);
    expect(transport.exec).toHaveBeenCalledWith('git status; echo "AZITO_RC:$?"', 5_000);
  });

  it('strips the sentinel line from the returned stdout', async () => {
    const transport = sshShapedTransport('some output\nAZITO_RC:0');
    const outcome = await execWithSentinel(transport, 'git status', 5_000);
    expect(outcome.stdout).toBe('some output');
  });

  it('picks up a sentinel line that is not the very last line of stdout', async () => {
    const transport = sshShapedTransport('AZITO_RC:0\ntrailing noise after the prompt redraws');
    const outcome = await execWithSentinel(transport, 'git status', 5_000);
    expect(outcome.sentinelFound).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });

  // Issue #87 review, 8th pass, Minor finding 3: `transport.exec()` itself
  // can REJECT (agent-transport HTTP failure, dropped SSH connection,
  // thrown timeout) — distinct from resolving with a missing sentinel line.
  // Before this fix that rejection propagated as whatever raw error
  // `transport.exec()` threw, which fails `err instanceof
  // RemoteGitCommandError && err.transportFailure` at every call site that
  // checks it (`RemoteBundleOps.verify()`,
  // `FetchDistributionService.deliverToMirror()`), so an unreachable server
  // got misclassified as "git ran and rejected the bundle's content" and
  // triggered a pointless incremental->full retry.
  it('wraps a transport.exec() rejection in RemoteGitCommandError(transportFailure: true), preserving the original error as cause', async () => {
    const originalError = new Error('ECONNREFUSED: connect failed');
    const transport = { exec: vi.fn(async () => { throw originalError; }) } as unknown as IServerTransport;

    const err: unknown = await execWithSentinel(transport, 'git status', 5_000).catch((e) => e);

    expect(err).toBeInstanceOf(RemoteGitCommandError);
    expect((err as RemoteGitCommandError).transportFailure).toBe(true);
    expect((err as Error).cause).toBe(originalError);
    expect((err as Error).message).toContain('ECONNREFUSED');
  });
});

describe('execGitOrThrow', () => {
  it('resolves with the outcome when the sentinel reports exit code 0', async () => {
    const transport = sshShapedTransport('ok\nAZITO_RC:0');
    const outcome = await execGitOrThrow(transport, 'git fetch', 5_000, 'git fetch failed');
    expect(outcome.ok).toBe(true);
  });

  it('throws RemoteGitCommandError(transportFailure: false) when the sentinel reports a non-zero exit', async () => {
    const transport = sshShapedTransport('fatal: rejected\nAZITO_RC:1');
    const err: unknown = await execGitOrThrow(transport, 'git fetch', 5_000, 'git fetch failed').catch((e) => e);
    expect(err).toBeInstanceOf(RemoteGitCommandError);
    expect((err as RemoteGitCommandError).transportFailure).toBe(false);
    expect((err as Error).message).toContain('git fetch failed');
  });

  it('throws RemoteGitCommandError(transportFailure: true) when the sentinel is missing', async () => {
    const transport = sshShapedTransport('connection reset by peer');
    const err: unknown = await execGitOrThrow(transport, 'git fetch', 5_000, 'git fetch failed').catch((e) => e);
    expect(err).toBeInstanceOf(RemoteGitCommandError);
    expect((err as RemoteGitCommandError).transportFailure).toBe(true);
  });

  // Issue #87 review, 8th pass, Minor finding 3.
  it('throws RemoteGitCommandError(transportFailure: true) when transport.exec() itself rejects', async () => {
    const transport = { exec: vi.fn(async () => { throw new Error('agent unreachable: 502'); }) } as unknown as IServerTransport;
    const err: unknown = await execGitOrThrow(transport, 'git fetch', 5_000, 'git fetch failed').catch((e) => e);
    expect(err).toBeInstanceOf(RemoteGitCommandError);
    expect((err as RemoteGitCommandError).transportFailure).toBe(true);
  });
});
