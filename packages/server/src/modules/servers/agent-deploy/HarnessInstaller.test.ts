import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { HarnessInstaller } from './HarnessInstaller';
import type { SshClient } from '../ssh/SshClient';

// fs/child_process are ESM named exports here — vitest can't spyOn() a
// non-configurable module namespace export directly (see
// RecoverStuckTasksUseCase.test.ts for the same pattern), so both are
// mocked at the module level and stubbed per-test via vi.mocked(...).
// child_process.execFile keeps the rest of the real module intact (only
// execFile itself is replaced) — a full vi.mock('child_process') automock
// strips the `util.promisify.custom` symbol the real implementation carries,
// which left util.promisify(execFile) resolving to `undefined` instead of a
// callable promisified function.
vi.mock('fs');
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, execFile: vi.fn() };
});

// HarnessInstaller.runSetup/runSetupLocal are private, but they're the only
// thing distinguishing an isolation_intent server from a normal one (Issue
// #29 Step 1: --ui-token must never reach a server declared to hold no
// credentials — setup.sh's own #28 change already tolerates a missing
// --ui-token). Exercised through the public install()/installLocal() entry
// points, stubbing out the transfer step so only the setup.sh invocation is
// observed.

function makeSshClient(execResult: { stdout: string; stderr: string; code: number } = { stdout: '', stderr: '', code: 0 }) {
  return {
    execIsolated: vi.fn(async () => execResult),
  } as unknown as SshClient;
}

describe('HarnessInstaller.install — --ui-token withholding for isolation_intent servers', () => {
  it('passes --ui-token to setup.sh for a normal (non-isolated) server', async () => {
    const sshClient = makeSshClient();
    const installer = new HarnessInstaller(sshClient);
    // Stub the transfer step (private) — this test only cares about the
    // setup.sh command line runSetup builds.
    vi.spyOn(installer as unknown as { transferHarness: () => Promise<void> }, 'transferHarness').mockResolvedValue(undefined);

    await installer.install('test-host', {
      webhookToken: 'wh-token',
      uiToken: 'ui-token-secret',
      serverName: 'srv-agent',
      isolationIntent: false,
    });

    expect(sshClient.execIsolated).toHaveBeenCalledTimes(1);
    const [, cmd] = (sshClient.execIsolated as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toContain('--ui-token');
    expect(cmd).toContain('ui-token-secret');
    expect(cmd).toContain('--webhook-token');
  });

  it('withholds --ui-token from setup.sh for a server with isolationIntent=true, but still passes --webhook-token', async () => {
    const sshClient = makeSshClient();
    const installer = new HarnessInstaller(sshClient);
    vi.spyOn(installer as unknown as { transferHarness: () => Promise<void> }, 'transferHarness').mockResolvedValue(undefined);

    await installer.install('test-host', {
      webhookToken: 'wh-token',
      uiToken: 'ui-token-secret',
      serverName: 'srv-agent',
      isolationIntent: true,
    });

    expect(sshClient.execIsolated).toHaveBeenCalledTimes(1);
    const [, cmd] = (sshClient.execIsolated as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).not.toContain('--ui-token');
    expect(cmd).not.toContain('ui-token-secret');
    expect(cmd).toContain('--webhook-token');
    expect(cmd).toContain('wh-token');
  });

  // Issue #29 review, Critical finding 3: withholding --ui-token above only
  // stops a NEW token from being distributed — an already-distributed one
  // from a prior (pre-isolation) setup.sh run stays in operator.env / Claude
  // settings.json / Codex MCP config unless --purge-operator-token is also
  // passed.
  it('passes --purge-operator-token to setup.sh for a server with isolationIntent=true', async () => {
    const sshClient = makeSshClient();
    const installer = new HarnessInstaller(sshClient);
    vi.spyOn(installer as unknown as { transferHarness: () => Promise<void> }, 'transferHarness').mockResolvedValue(undefined);

    await installer.install('test-host', {
      webhookToken: 'wh-token',
      serverName: 'srv-agent',
      isolationIntent: true,
    });

    const [, cmd] = (sshClient.execIsolated as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toContain('--purge-operator-token');
  });

  it('does not pass --purge-operator-token to setup.sh for a normal (non-isolated) server', async () => {
    const sshClient = makeSshClient();
    const installer = new HarnessInstaller(sshClient);
    vi.spyOn(installer as unknown as { transferHarness: () => Promise<void> }, 'transferHarness').mockResolvedValue(undefined);

    await installer.install('test-host', {
      webhookToken: 'wh-token',
      uiToken: 'ui-token-secret',
      serverName: 'srv-agent',
      isolationIntent: false,
    });

    const [, cmd] = (sshClient.execIsolated as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).not.toContain('--purge-operator-token');
  });
});

// Issue #29 review, Important finding 2: runSetupLocal (the local-server
// counterpart to runSetup, exercised only through installLocal()) previously
// ignored isolationIntent entirely — it always passed --ui-token and never
// --purge-operator-token, regardless of the option. local-type servers can
// never actually reach isolationIntent: true today (PUT /api/servers/:name
// rejects it for any effective type other than 'agent'), so this was
// unreachable in production, but it violated HarnessInstallOptions'
// documented contract and left the local path inconsistent with runSetup's
// remote behavior (defense in depth). Verifies the fix mirrors runSetup's
// --ui-token withholding / --purge-operator-token forcing for both values of
// isolationIntent.
describe('HarnessInstaller.installLocal — isolationIntent handling (local setup.sh invocation)', () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(child_process.execFile).mockReset();
  });

  function stubLocalSetup() {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const execFileSpy = vi.mocked(child_process.execFile).mockImplementation(
      // Node's execFile has multiple overloads; the promisify path used by
      // HarnessInstaller calls it with (file, args, options, callback).
      ((..._args: unknown[]) => {
        const callback = _args[_args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof child_process.execFile>;
      }) as unknown as typeof child_process.execFile,
    );
    return execFileSpy;
  }

  it('passes --ui-token and omits --purge-operator-token for a normal (non-isolated) local install', async () => {
    const execFileSpy = stubLocalSetup();
    const installer = new HarnessInstaller({} as SshClient);

    const result = await installer.installLocal({
      webhookToken: 'wh-token',
      uiToken: 'ui-token-secret',
      serverName: 'srv-local',
      isolationIntent: false,
    });

    expect(result.success).toBe(true);
    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const [, args] = execFileSpy.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('--ui-token');
    expect(args).toContain('ui-token-secret');
    expect(args).not.toContain('--purge-operator-token');
  });

  it('withholds --ui-token and passes --purge-operator-token for an isolationIntent=true local install', async () => {
    const execFileSpy = stubLocalSetup();
    const installer = new HarnessInstaller({} as SshClient);

    const result = await installer.installLocal({
      webhookToken: 'wh-token',
      uiToken: 'ui-token-secret',
      serverName: 'srv-local',
      isolationIntent: true,
    });

    expect(result.success).toBe(true);
    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const [, args] = execFileSpy.mock.calls[0] as unknown as [string, string[]];
    expect(args).not.toContain('--ui-token');
    expect(args).not.toContain('ui-token-secret');
    expect(args).toContain('--purge-operator-token');
    expect(args).toContain('--webhook-token');
    expect(args).toContain('wh-token');
  });
});
