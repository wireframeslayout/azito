import { describe, expect, it, vi } from 'vitest';
import { agentPaneShell, hubPaneShell } from './paneShell';
import { AgentHostOutdatedError } from '../../servers/transport/agentHostProtocol';

const log = () => ({ warn: vi.fn() });
const server = (hostProfile: { platform: 'linux' | 'darwin' | 'win32'; arch: 'x64' | 'arm64' } | null = null) => ({ name: 'a1', hostProfile });

describe('hubPaneShell', () => {
  it('is the hub shell with -lc, as before', async () => {
    expect(await hubPaneShell('/bin/zsh')()).toEqual({ shell: '/bin/zsh', commandArgs: ['-lc'] });
  });
});

describe('agentPaneShell', () => {
  it("uses the default shell the agent reports, not the hub's", async () => {
    const resolve = agentPaneShell(server(), async () => ({ platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' }), '/bin/bash', log());
    expect(await resolve()).toEqual({ shell: '/bin/zsh', commandArgs: ['-lc'] });
  });

  it('asks the agent once and keeps the answer', async () => {
    const fetchHostInfo = vi.fn(async () => ({ platform: 'linux', arch: 'x64', shell: '/bin/fish' }));
    const resolve = agentPaneShell(server(), fetchHostInfo, '/bin/bash', log());
    await resolve();
    await resolve();
    expect(fetchHostInfo).toHaveBeenCalledTimes(1);
  });

  it('fails with a reason when the agent has no $SHELL, instead of falling back to /bin/sh', async () => {
    const resolve = agentPaneShell(server(), async () => ({ platform: 'linux', arch: 'x64', shell: null }), '/bin/bash', log());
    await expect(resolve()).rejects.toThrow(/reports no default shell.*SHELL/);
  });

  it('does not keep a failure: the next pane asks again', async () => {
    const answers = [{ platform: 'linux', arch: 'x64', shell: null }, { platform: 'linux', arch: 'x64', shell: '/bin/sh' }];
    const resolve = agentPaneShell(server(), async () => answers.shift()!, '/bin/bash', log());
    await expect(resolve()).rejects.toThrow();
    expect(await resolve()).toEqual({ shell: '/bin/sh', commandArgs: ['-lc'] });
  });

  it('refuses a Windows agent as unsupported_os without asking it (PowerShell panes are not implemented)', async () => {
    const fetchHostInfo = vi.fn();
    const resolve = agentPaneShell(server({ platform: 'win32', arch: 'x64' }), fetchHostInfo, '/bin/bash', log());
    await expect(resolve()).rejects.toMatchObject({ code: 'unsupported_os' });
    expect(fetchHostInfo).not.toHaveBeenCalled();
  });

  it('refuses an agent that reports win32 even though none was recorded', async () => {
    const resolve = agentPaneShell(server(), async () => ({ platform: 'win32', arch: 'x64', shell: 'C:\\Windows\\System32\\cmd.exe' }), '/bin/bash', log());
    await expect(resolve()).rejects.toMatchObject({ code: 'unsupported_os' });
  });

  it('keeps an agent too old to report its host on the hub shell, as before, and says so once', async () => {
    const logger = log();
    const resolve = agentPaneShell(server(), async () => { throw new AgentHostOutdatedError('a1'); }, '/bin/bash', logger);
    expect(await resolve()).toEqual({ shell: '/bin/bash', commandArgs: ['-lc'] });
    expect(await resolve()).toEqual({ shell: '/bin/bash', commandArgs: ['-lc'] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/agent_outdated/);
  });

  it('propagates an unreachable agent', async () => {
    const resolve = agentPaneShell(server(), async () => { throw new Error('Agent unreachable'); }, '/bin/bash', log());
    await expect(resolve()).rejects.toThrow('unreachable');
  });
});
