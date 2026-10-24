import { describe, expect, it, vi } from 'vitest';
import { agentPaneShell, hubPaneShell, requireCommandArgs } from './paneShell';
import { resolveHubHostProfile } from '../../../shared/os/hostProfile';
import { AgentHostOutdatedError } from '../../servers/transport/agentHostProtocol';

const hub = hubPaneShell('/bin/bash', { platform: 'linux', arch: 'x64' });
const log = () => ({ warn: vi.fn() });
const server = (hostProfile: { platform: 'linux' | 'darwin' | 'win32'; arch: 'x64' | 'arm64' } | null = null) => ({ name: 'a1', hostProfile });

describe('hubPaneShell', () => {
  it('is the hub shell with -lc, as before', async () => {
    expect(await hubPaneShell('/bin/zsh', { platform: 'linux', arch: 'x64' })()).toEqual({ shell: '/bin/zsh', commandArgs: ['-lc'] });
    expect(await hubPaneShell('/bin/zsh', { platform: 'darwin', arch: 'arm64' })()).toEqual({ shell: '/bin/zsh', commandArgs: ['-lc'] });
  });

  it("gives a Windows hub its command interpreter (%ComSpec%), bare: no command arguments, like a Windows agent's", async () => {
    expect(await hubPaneShell('C:\\Windows\\System32\\cmd.exe', { platform: 'win32', arch: 'x64' })()).toEqual({ shell: 'C:\\Windows\\System32\\cmd.exe', commandArgs: null });
  });

  it('says which shell is missing instead of falling back to a Unix one', async () => {
    await expect(hubPaneShell(null, { platform: 'win32', arch: 'x64' })()).rejects.toThrow(/%ComSpec% is not set/);
    await expect(hubPaneShell(null, { platform: 'linux', arch: 'x64' })()).rejects.toThrow(/no default shell/);
  });

  it('refuses running a command in a Windows hub pane as unsupported_os (worker launch is #371)', async () => {
    const paneShell = await hubPaneShell('C:\\Windows\\System32\\cmd.exe', { platform: 'win32', arch: 'x64' })();
    expect(() => requireCommandArgs(paneShell, 'Starting a command in a new pane')).toThrowError(expect.objectContaining({ code: 'unsupported_os' }));
  });

  it('refuses a hub on an unknown OS with that reason', async () => {
    await expect(hubPaneShell('/bin/bash', resolveHubHostProfile({ platform: 'freebsd', arch: 'x64' }))()).rejects.toMatchObject({ code: 'unsupported_host' });
  });
});

describe('agentPaneShell', () => {
  it("uses the default shell the agent reports, not the hub's", async () => {
    const resolve = agentPaneShell(server(), async () => ({ platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' }), hub, log());
    expect(await resolve()).toEqual({ shell: '/bin/zsh', commandArgs: ['-lc'] });
  });

  it('asks the agent once and keeps the answer', async () => {
    const fetchHostInfo = vi.fn(async () => ({ platform: 'linux', arch: 'x64', shell: '/bin/fish' }));
    const resolve = agentPaneShell(server(), fetchHostInfo, hub, log());
    await resolve();
    await resolve();
    expect(fetchHostInfo).toHaveBeenCalledTimes(1);
  });

  it('fails with a reason when the agent has no $SHELL, instead of falling back to /bin/sh', async () => {
    const resolve = agentPaneShell(server(), async () => ({ platform: 'linux', arch: 'x64', shell: null }), hub, log());
    await expect(resolve()).rejects.toThrow(/reports no default shell.*SHELL/);
  });

  it('does not keep a failure: the next pane asks again', async () => {
    const answers = [{ platform: 'linux', arch: 'x64', shell: null }, { platform: 'linux', arch: 'x64', shell: '/bin/sh' }];
    const resolve = agentPaneShell(server(), async () => answers.shift()!, hub, log());
    await expect(resolve()).rejects.toThrow();
    expect(await resolve()).toEqual({ shell: '/bin/sh', commandArgs: ['-lc'] });
  });

  it('gives a Windows agent the shell it reports (%ComSpec%), bare: no command arguments', async () => {
    const fetchHostInfo = vi.fn(async () => ({ platform: 'win32', arch: 'x64', shell: 'C:\\Windows\\System32\\cmd.exe' }));
    const resolve = agentPaneShell(server({ platform: 'win32', arch: 'x64' }), fetchHostInfo, hub, log());
    expect(await resolve()).toEqual({ shell: 'C:\\Windows\\System32\\cmd.exe', commandArgs: null });
    await resolve();
    expect(fetchHostInfo).toHaveBeenCalledTimes(1);
  });

  it('fails for a Windows agent that reports no shell, and never uses the hub shell for one', async () => {
    const noShell = agentPaneShell(server({ platform: 'win32', arch: 'x64' }), async () => ({ platform: 'win32', arch: 'x64', shell: null }), hub, log());
    await expect(noShell()).rejects.toThrow(/ComSpec/);
    const outdated = agentPaneShell(server({ platform: 'win32', arch: 'x64' }), async () => { throw new AgentHostOutdatedError('a1'); }, hub, log());
    await expect(outdated()).rejects.toBeInstanceOf(AgentHostOutdatedError);
  });

  it('refuses an agent that reports win32 even though none was recorded', async () => {
    const resolve = agentPaneShell(server(), async () => ({ platform: 'win32', arch: 'x64', shell: 'C:\\Windows\\System32\\cmd.exe' }), hub, log());
    await expect(resolve()).rejects.toMatchObject({ code: 'unsupported_os' });
  });

  it('keeps an agent too old to report its host on the hub shell, as before, and says so once', async () => {
    const logger = log();
    const resolve = agentPaneShell(server(), async () => { throw new AgentHostOutdatedError('a1'); }, hub, logger);
    expect(await resolve()).toEqual({ shell: '/bin/bash', commandArgs: ['-lc'] });
    expect(await resolve()).toEqual({ shell: '/bin/bash', commandArgs: ['-lc'] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/agent_outdated/);
  });

  it("tells a Windows hub's user to update the agent, not that this hub is unsupported, for an agent too old to report", async () => {
    const winHub = hubPaneShell('C:\\Windows\\System32\\cmd.exe', { platform: 'win32', arch: 'x64' });
    const resolve = agentPaneShell(server(), async () => { throw new AgentHostOutdatedError('a1'); }, winHub, log());
    await expect(resolve()).rejects.toMatchObject({ code: 'unsupported_os', message: expect.stringMatching(/agent server a1.*agent_outdated.*Update the agent/) });
  });

  it('propagates an unreachable agent', async () => {
    const resolve = agentPaneShell(server(), async () => { throw new Error('Agent unreachable'); }, hub, log());
    await expect(resolve()).rejects.toThrow('unreachable');
  });
});
