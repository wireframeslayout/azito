import { describe, expect, it, vi } from 'vitest';
import { agentPaneShell, hubPaneShell } from './paneShell';
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

  it('refuses a Windows hub as unsupported_os instead of passing it a Unix shell', async () => {
    await expect(hubPaneShell('/bin/bash', { platform: 'win32', arch: 'x64' })()).rejects.toMatchObject({ code: 'unsupported_os', message: expect.stringContaining('this hub') });
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

  it('refuses a Windows agent as unsupported_os without asking it (PowerShell panes are not implemented)', async () => {
    const fetchHostInfo = vi.fn();
    const resolve = agentPaneShell(server({ platform: 'win32', arch: 'x64' }), fetchHostInfo, hub, log());
    await expect(resolve()).rejects.toMatchObject({ code: 'unsupported_os' });
    expect(fetchHostInfo).not.toHaveBeenCalled();
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

  it('propagates an unreachable agent', async () => {
    const resolve = agentPaneShell(server(), async () => { throw new Error('Agent unreachable'); }, hub, log());
    await expect(resolve()).rejects.toThrow('unreachable');
  });
});
