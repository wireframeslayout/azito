import { describe, it, expect, vi } from 'vitest';
import { HarnessInstaller } from './HarnessInstaller';
import type { SshClient } from '../ssh/SshClient';

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
